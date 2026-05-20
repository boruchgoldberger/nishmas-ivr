const express = require('express');
const twilio = require('twilio');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const https = require('https');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

// ── USAePay credentials ─────────────────────────────────────────────────────
const USAEPAY_SOURCE_KEY = process.env.USAEPAY_SOURCE_KEY || 'X1YgGedt7JxvZ5JDjjWPV9MKL9Ihx268';
const USAEPAY_PIN        = process.env.USAEPAY_PIN        || '4321';
const USAEPAY_HOST       = process.env.USAEPAY_HOST       || 'usaepay.com';
const DONATION_AMOUNT    = parseFloat(process.env.DONATION_AMOUNT || '80');  // $80 kvittel default
const SPONSOR_FULL_AMT   = parseFloat(process.env.SPONSOR_FULL_AMT || '500'); // full sponsor
const SPONSOR_PARTIAL_AMT= parseFloat(process.env.SPONSOR_PARTIAL_AMT || '180'); // partial sponsor

// Charge a card via USAePay v2 REST. Returns { ok, approved, transactionId, error }
async function chargeUSAePay({ amount, cardNumber, expMonth, expYear, cvv, description }) {
  return new Promise((resolve) => {
    // USAePay v2 REST API auth format (per https://help.usaepay.info/api/rest/):
    //   prehash = apikey + seed + apipin
    //   apihash = 's2/' + seed + '/' + sha256(prehash)
    //   Authorization: Basic base64(apikey + ':' + apihash)
    const crypto = require('crypto');
    const seed = crypto.randomBytes(16).toString('hex');
    const prehash = USAEPAY_SOURCE_KEY + seed + USAEPAY_PIN;
    const apihash = 's2/' + seed + '/' + crypto.createHash('sha256').update(prehash).digest('hex');
    const authStr = USAEPAY_SOURCE_KEY + ':' + apihash;

    const expMo2 = String(expMonth).padStart(2, '0').slice(-2);
    const expYr2 = String(expYear).length >= 4 ? String(expYear).slice(-2) : String(expYear).padStart(2, '0').slice(-2);

    const body = JSON.stringify({
      command: 'cc:sale',
      amount: parseFloat(amount).toFixed(2),
      creditcard: {
        cardholder: 'IVR Donor',
        number: String(cardNumber).replace(/\D/g, ''),
        expiration: expMo2 + expYr2,
        cvc: String(cvv).replace(/\D/g, '')
      },
      description: description || 'Nishmas IVR Donation',
      ignore_duplicate: true
    });

    const options = {
      hostname: USAEPAY_HOST,
      path: '/api/v2/transactions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Basic ' + Buffer.from(authStr).toString('base64')
      }
    };

    console.log('[USAePay] charging $' + amount + ', card ending ' + String(cardNumber).slice(-4));
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log('[USAePay] HTTP status:', res.statusCode);
        console.log('[USAePay] response body:', data);
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { parsed = { raw: data }; }
        const approved = parsed?.result === 'Approved' || parsed?.result_code === 'A';
        const errMsg = parsed?.error || parsed?.error_message || parsed?.errorcode || parsed?.detail || '';
        console.log('[USAePay] approved:', approved, '· result:', parsed?.result, '· error:', errMsg);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          approved,
          transactionId: parsed?.refnum || parsed?.transaction_id || parsed?.key || '',
          authCode: parsed?.authcode || '',
          status: parsed?.result || '',
          error: errMsg,
          raw: parsed
        });
      });
    });
    req.on('error', (err) => {
      console.error('[USAePay] network error:', err.message);
      resolve({ ok: false, approved: false, error: err.message });
    });
    req.write(body);
    req.end();
  });
}

// Point fluent-ffmpeg at the bundled ffmpeg binary (no system install needed)
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
console.log('ffmpeg path set to:', ffmpegInstaller.path);

// Convert any audio file (especially .webm browser recordings AND .wav uploads) to .mp3 for reliable Twilio playback.
// MP3 plays most reliably on Twilio. WAV sometimes fails depending on encoding.
// Returns the new filename (the .mp3 version). The original is deleted.
function convertToMp3(inputFilename) {
    return new Promise((resolve, reject) => {
        const inputPath = path.join('uploads', inputFilename);
        const ext = path.extname(inputFilename).toLowerCase();
        // Only skip if already mp3 — convert everything else (webm, wav, m4a, ogg, etc.)
        if (ext === '.mp3') return resolve(inputFilename);
        const outputFilename = inputFilename.replace(/\.[^.]+$/, '') + '.mp3';
        const outputPath = path.join('uploads', outputFilename);
        ffmpeg(inputPath)
            .audioCodec('libmp3lame')
            .audioBitrate('128k')
            .audioChannels(1)
            .audioFrequency(22050)
            .format('mp3')
            .on('error', (err) => {
                console.error('[ffmpeg convert ERROR]', err.message);
                // Fallback: return original filename if conversion fails
                resolve(inputFilename);
            })
            .on('end', () => {
                console.log('[ffmpeg] converted', inputFilename, '->', outputFilename);
                // Delete the original (webm etc) to save space
                fs.unlink(inputPath, () => {});
                resolve(outputFilename);
            })
            .save(outputPath);
    });
}

const app = express();
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(cors());

app.use('/audio', express.static('uploads'));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        const safeName = (file.originalname || 'recording.webm').replace(/\s+/g, '_');
        cb(null, Date.now() + '-' + safeName);
    }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS nishmas_messages (
                id SERIAL PRIMARY KEY,
                day_number INTEGER UNIQUE NOT NULL,
                date_recorded DATE NOT NULL,
                title TEXT NOT NULL,
                title_audio TEXT,
                speaker_name TEXT NOT NULL,
                speaker_name_audio TEXT,
                audio_url TEXT,
                recorded_audio TEXT,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS nishmas_settings (
                id SERIAL PRIMARY KEY,
                program_start_date DATE NOT NULL,
                greeting_audio TEXT,
                greeting_audio_file TEXT,
                press1_audio_file TEXT,
                press2_audio_file TEXT,
                press3_audio_file TEXT,
                nishmas_audio_file TEXT,
                nishmas_ashkenaz_file TEXT,
                nishmas_mizrach_file TEXT,
                nishmas_nusach_prompt_file TEXT,
                all_messages_intro_file TEXT,
                all_messages_template_file TEXT,
                return_menu_audio_file TEXT,
                closing_message TEXT,
                closing_audio_file TEXT,
                is_program_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        // Call log table — written to at each inbound call for analytics
        await pool.query(`
            CREATE TABLE IF NOT EXISTS nishmas_call_logs (
                id SERIAL PRIMARY KEY,
                call_sid TEXT,
                phone_number TEXT,
                program_day INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_call_logs_phone ON nishmas_call_logs (phone_number);`).catch(()=>{});
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_call_logs_created ON nishmas_call_logs (created_at DESC);`).catch(()=>{});
        
        // Auto-heal: add any missing columns to nishmas_messages (in case table was created earlier with a different schema)
        const msgCols = [
            ['title', 'TEXT'],
            ['title_audio', 'TEXT'],
            ['speaker_name', 'TEXT'],
            ['speaker_name_audio', 'TEXT'],
            ['audio_url', 'TEXT'],
            ['recorded_audio', 'TEXT'],
            ['date_recorded', 'DATE'],
            ['program_date', 'TEXT'],
            ['is_active', 'BOOLEAN DEFAULT true'],
            ['created_at', 'TIMESTAMP DEFAULT NOW()'],
            ['allow_skip', 'BOOLEAN DEFAULT false'],
            ['dedication_audio_file', 'TEXT'],   // plays right after welcome on this message's playback (admin upload per-message)
            ['is_skip_day', 'BOOLEAN DEFAULT false']  // Shabbos / Yom Tov — no video, can't be sponsored
        ];
        for (const [col, type] of msgCols) {
            await pool.query(`ALTER TABLE nishmas_messages ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
        }
        // Auto-heal nishmas_settings too
        const setCols = [
            ['program_start_date', 'DATE'],
            ['greeting_audio', 'TEXT'],
            ['greeting_audio_file', 'TEXT'],
            ['press1_audio_file', 'TEXT'],
            ['press2_audio_file', 'TEXT'],
            ['press3_audio_file', 'TEXT'],
            ['nishmas_audio_file', 'TEXT'],
            ['nishmas_ashkenaz_file', 'TEXT'],
            ['nishmas_mizrach_file', 'TEXT'],
            ['nishmas_nusach_prompt_file', 'TEXT'],
            ['all_messages_intro_file', 'TEXT'],
            ['all_messages_template_file', 'TEXT'],
            ['return_menu_audio_file', 'TEXT'],
            ['closing_message', 'TEXT'],
            ['closing_audio_file', 'TEXT'],
            ['donation_enabled', 'BOOLEAN DEFAULT true'],
            ['donation_amount_cents', 'INTEGER DEFAULT 8000'],
            ['donation_digit', 'TEXT DEFAULT \'9\''],
            ['donate_intro_audio_file', 'TEXT'],     // "Press 9 to donate $40 ..." main menu prompt
            ['donate_card_prompt_file', 'TEXT'],     // "Please enter your card number..."
            ['donate_expiry_prompt_file', 'TEXT'],   // "Please enter expiration month/year..."
            ['donate_cvv_prompt_file', 'TEXT'],      // "Please enter the security code..."
            ['donate_kvittel_prompt_file', 'TEXT'],  // "Please record your kvittel name after the beep..."
            ['donate_thank_you_file', 'TEXT'],       // "Thank you, your donation was approved..."
            ['donate_decline_file', 'TEXT'],         // "Your card was declined..."
            ['donate_kvittel_thank_file', 'TEXT'],   // "Thank you, your kvittel has been received..."
            // ── Sponsor flow (Press 9) ──────────────────────────────────────
            ['sponsor_enabled', 'BOOLEAN DEFAULT true'],
            ['sponsor_digit', "TEXT DEFAULT '9'"],
            ['kvittel_digit', "TEXT DEFAULT '8'"],     // Press 8 = kvittel/donate flow
            ['sponsor_full_amount_cents', 'INTEGER DEFAULT 50000'],   // $500
            ['sponsor_partial_amount_cents', 'INTEGER DEFAULT 18000'], // $180
            ['sponsor_partial_max_per_day', 'INTEGER DEFAULT 3'],     // up to 3 partials per day
            ['sponsor_intro_audio_file', 'TEXT'],          // "To sponsor a daily video that will be a source of chizuk... press 1 for full $500, press 2 for partial $180"
            ['sponsor_pick_day_prompt_file', 'TEXT'],      // "Please select a day from 1 to 40, or press # for no specific day"
            ['sponsor_day_taken_audio_file', 'TEXT'],      // "That day is already fully sponsored — please choose another day"
            ['sponsor_shabbos_audio_file', 'TEXT'],        // "There is no video on Shabbos — please choose another day"
            ['sponsor_past_day_audio_file', 'TEXT'],       // "That day has already passed — please choose a future day"
            ['sponsor_anonymous_prompt_file', 'TEXT'],     // "Press 1 to sponsor anonymously, press 2 to record your name"
            ['sponsor_record_name_prompt_file', 'TEXT'],   // "Please record your name after the beep, press # when done"
            ['sponsor_thank_you_file', 'TEXT'],            // "Thank you, your sponsorship has been received..."
            ['sponsor_decline_file', 'TEXT'],              // "Your card was declined for the sponsorship..."
            ['is_program_active', 'BOOLEAN DEFAULT true'],
            ['created_at', 'TIMESTAMP DEFAULT NOW()']
        ];
        for (const [col, type] of setCols) {
            await pool.query(`ALTER TABLE nishmas_settings ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
        }

        // Donations table — log every donation attempt + kvittel recording
        await pool.query(`
            CREATE TABLE IF NOT EXISTS donations (
                id SERIAL PRIMARY KEY,
                amount_cents INTEGER NOT NULL,
                card_last4 TEXT,
                status TEXT DEFAULT 'pending',     -- 'approved' | 'declined' | 'pending' | 'error'
                transaction_id TEXT,
                auth_code TEXT,
                decline_reason TEXT,
                kvittel_recording_url TEXT,
                caller_phone TEXT,
                ivr_call_sid TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        // Auto-heal donations columns in case the table existed in an older shape
        const donCols = [
            ['amount_cents', 'INTEGER'],
            ['card_last4', 'TEXT'],
            ['status', "TEXT DEFAULT 'pending'"],
            ['transaction_id', 'TEXT'],
            ['auth_code', 'TEXT'],
            ['decline_reason', 'TEXT'],
            ['kvittel_recording_url', 'TEXT'],
            ['caller_phone', 'TEXT'],
            ['ivr_call_sid', 'TEXT'],
            ['created_at', 'TIMESTAMP DEFAULT NOW()']
        ];
        for (const [col, type] of donCols) {
            await pool.query(`ALTER TABLE donations ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
        }
        // Add campaign_id to donations so each transaction can be traced back to
        // its donation campaign (NULL for legacy donations from the original $80 flow).
        await pool.query('ALTER TABLE donations ADD COLUMN IF NOT EXISTS campaign_id INTEGER').catch(() => {});

        // ─── Donation campaigns: multiple "press X to donate $Y to <cause>" entries ───
        // Each campaign owns its own digit, preset amount, full audio bundle, and
        // kvittel toggle. At call time /webhook plays every active campaign's intro;
        // /handle-menu dispatches the pressed digit into /donate2/start?campaign=<id>.
        // Existing $80 nishmas flow is auto-seeded as the first campaign so nothing
        // breaks in production — see seed block below.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS donation_campaigns (
                id                          SERIAL PRIMARY KEY,
                name                        TEXT NOT NULL,                -- internal label, e.g. "Nishmas $80 + kvittel"
                digit                       TEXT NOT NULL,                -- single keypad digit '0'-'9'
                amount_cents                INTEGER NOT NULL,
                description                 TEXT,                         -- e.g. "Donate $104 to XYZ" (admin reference only)
                intro_audio_file            TEXT,                         -- "To donate X to XYZ press 9" (played in main menu)
                card_prompt_file            TEXT,                         -- "Please enter your card number..."
                expiry_prompt_file          TEXT,                         -- "Please enter expiration date..."
                cvv_prompt_file             TEXT,                         -- "Please enter the security code..."
                thank_you_file              TEXT,                         -- "Thank you, your donation was approved"
                decline_file                TEXT,                         -- "Your card was declined..."
                kvittel_enabled             BOOLEAN DEFAULT FALSE,        -- record a kvittel after approval?
                kvittel_prompt_file         TEXT,                         -- "Please record your kvittel name..."
                kvittel_thank_file          TEXT,                         -- "Thank you, your kvittel has been received"
                active                      BOOLEAN DEFAULT TRUE,
                sort_order                  INTEGER DEFAULT 0,
                created_at                  TIMESTAMP DEFAULT NOW(),
                updated_at                  TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});

        // Auto-heal donation_campaigns columns
        const dcCols = [
            ['name', 'TEXT'], ['digit', 'TEXT'], ['amount_cents', 'INTEGER'],
            ['description', 'TEXT'],
            ['intro_audio_file', 'TEXT'], ['card_prompt_file', 'TEXT'],
            ['expiry_prompt_file', 'TEXT'], ['cvv_prompt_file', 'TEXT'],
            ['thank_you_file', 'TEXT'], ['decline_file', 'TEXT'],
            ['kvittel_enabled', 'BOOLEAN DEFAULT FALSE'],
            ['kvittel_prompt_file', 'TEXT'], ['kvittel_thank_file', 'TEXT'],
            ['active', 'BOOLEAN DEFAULT TRUE'], ['sort_order', 'INTEGER DEFAULT 0'],
            ['created_at', 'TIMESTAMP DEFAULT NOW()'],
            ['updated_at', 'TIMESTAMP DEFAULT NOW()'],
        ];
        for (const [col, type] of dcCols) {
            await pool.query(`ALTER TABLE donation_campaigns ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
        }

        // Seed: if no campaigns exist yet but the legacy nishmas_settings has the
        // $80 donate flow enabled, port it over as campaign #1. This keeps the
        // production phone line behaving identically after the migration.
        try {
            const existingCount = await pool.query('SELECT COUNT(*)::int AS n FROM donation_campaigns');
            if ((existingCount.rows[0]?.n || 0) === 0) {
                const ns = (await pool.query('SELECT * FROM nishmas_settings LIMIT 1')).rows[0] || {};
                if (ns.donation_enabled !== false) {
                    await pool.query(
                        `INSERT INTO donation_campaigns
                          (name, digit, amount_cents, description,
                           intro_audio_file, card_prompt_file, expiry_prompt_file,
                           cvv_prompt_file, thank_you_file, decline_file,
                           kvittel_enabled, kvittel_prompt_file, kvittel_thank_file,
                           active, sort_order)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
                        [
                            'Nishmas — kvittel donation (legacy import)',
                            ns.kvittel_digit || ns.donation_digit || '8',
                            ns.donation_amount_cents || 8000,
                            'Original $80-and-have-a-kvittel-said-for-you flow.',
                            ns.donate_intro_audio_file || null,
                            ns.donate_card_prompt_file || null,
                            ns.donate_expiry_prompt_file || null,
                            ns.donate_cvv_prompt_file || null,
                            ns.donate_thank_you_file || null,
                            ns.donate_decline_file || null,
                            true,                                       // kvittel enabled for nishmas
                            ns.donate_kvittel_prompt_file || null,
                            ns.donate_kvittel_thank_file || null,
                            true, 0
                        ]
                    );
                    console.log('[migration] seeded Nishmas $80 + kvittel flow as donation_campaigns row #1');
                }
            }
        } catch (e) {
            console.error('[migration] donation_campaigns seed failed:', e.message);
        }

        // Sponsorships table — full $500 or partial $180 sponsorships, optionally tied to a day
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sponsorships (
                id SERIAL PRIMARY KEY,
                day_number INTEGER,                  -- 1-40 or NULL for "no specific day"
                sponsor_type TEXT NOT NULL,           -- 'full' | 'partial'
                amount_cents INTEGER NOT NULL,
                sponsor_name TEXT,                    -- recorded name URL or typed name; null if anonymous
                anonymous BOOLEAN DEFAULT false,
                kvittel_recording_url TEXT,
                card_last4 TEXT,
                status TEXT DEFAULT 'pending',        -- 'approved' | 'declined' | 'pending' | 'error'
                transaction_id TEXT,
                auth_code TEXT,
                decline_reason TEXT,
                caller_phone TEXT,
                ivr_call_sid TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        const spCols = [
            ['day_number', 'INTEGER'],
            ['sponsor_type', 'TEXT'],
            ['amount_cents', 'INTEGER'],
            ['sponsor_name', 'TEXT'],
            ['anonymous', 'BOOLEAN DEFAULT false'],
            ['kvittel_recording_url', 'TEXT'],
            ['card_last4', 'TEXT'],
            ['status', "TEXT DEFAULT 'pending'"],
            ['transaction_id', 'TEXT'],
            ['auth_code', 'TEXT'],
            ['decline_reason', 'TEXT'],
            ['caller_phone', 'TEXT'],
            ['ivr_call_sid', 'TEXT'],
            ['created_at', 'TIMESTAMP DEFAULT NOW()']
        ];
        for (const [col, type] of spCols) {
            await pool.query(`ALTER TABLE sponsorships ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
        }

        // Admin-blockable days — admin can mark any day 1-40 as blocked (no sponsorships allowed)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sponsor_day_blocks (
                day_number INTEGER PRIMARY KEY,
                reason TEXT,
                blocked_at TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});

        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        if (settings.rows.length === 0) {
            await pool.query(`
                INSERT INTO nishmas_settings (program_start_date, greeting_audio, closing_message)
                VALUES ($1, $2, $3)
            `, [new Date(), 'Welcome.', 'Thank you.']);
        }
        console.log('Database initialized (schema healed)');
    } catch (error) {
        console.error('Database init error:', error);
    }
}

async function getCurrentProgramDay() {
    try {
        const settings = await pool.query('SELECT program_start_date FROM nishmas_settings LIMIT 1');
        if (!settings.rows.length) return 1;
        // Normalize to date-only (strip time) so partial-day clock differences don't shift the count
        const start = new Date(settings.rows[0].program_start_date);
        const startOfStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const diffDays = Math.round((startOfToday - startOfStart) / (1000 * 60 * 60 * 24));
        return Math.max(1, diffDays + 1);
    } catch { return 1; }
}

async function getMostRecentMessage() {
    try {
        const currentDay = await getCurrentProgramDay();
        for (let day = currentDay; day >= 1; day--) {
            const m = await pool.query('SELECT * FROM nishmas_messages WHERE day_number = $1 AND is_active = true', [day]);
            if (m.rows.length) return m.rows[0];
        }
        return null;
    } catch { return null; }
}

// Today's message = message for exactly today's day_number. Returns null on skip days (no upload for this day).
async function getTodaysMessage() {
    try {
        const currentDay = await getCurrentProgramDay();
        const m = await pool.query('SELECT * FROM nishmas_messages WHERE day_number = $1 AND is_active = true', [currentDay]);
        return m.rows[0] || null;
    } catch { return null; }
}

// Yesterday's message = most recent active message with day_number < today. Skips gaps automatically.
async function getYesterdaysMessage() {
    try {
        const currentDay = await getCurrentProgramDay();
        for (let day = currentDay - 1; day >= 1; day--) {
            const m = await pool.query('SELECT * FROM nishmas_messages WHERE day_number = $1 AND is_active = true', [day]);
            if (m.rows.length) return m.rows[0];
        }
        return null;
    } catch { return null; }
}

// Log an inbound call — fire-and-forget so failures never affect caller experience
async function logCall(req) {
    try {
        const callSid = req.body?.CallSid || null;
        const phone = req.body?.From || null;
        let programDay = null;
        try { programDay = await getCurrentProgramDay(); } catch(e) { /* ignore */ }
        if (!phone && !callSid) return; // nothing to log
        await pool.query(
            'INSERT INTO nishmas_call_logs (call_sid, phone_number, program_day) VALUES ($1, $2, $3)',
            [callSid, phone, programDay]
        );
    } catch (e) {
        console.error('logCall error (non-fatal):', e.message);
    }
}

app.post('/webhook', async (req, res) => {
    // Log the call but don't await — never block the call if logging fails
    logCall(req);
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0];
        const todaysMessage = await getTodaysMessage();
        const yesterdaysMessage = await getYesterdaysMessage();
        const currentDay = await getCurrentProgramDay();
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';

        const gather = twiml.gather({ numDigits: 1, action: '/handle-menu', method: 'POST', timeout: 10 });

        // 1. Welcome greeting (uploaded or TTS default)
        if (s?.greeting_audio_file) {
            gather.play(audioBase + s.greeting_audio_file);
        } else {
            gather.say('Welcome to the 40 Days of Nishmas program.');
        }

        // 1b. Sponsor + Donation campaign prompts — play right after welcome, before menu options
        if (s?.sponsor_enabled !== false) {
            gather.pause({ length: 1 });
            // Sponsor prompt (press 9 by default) — admin-uploadable intro about sponsoring a daily video
            if (s?.sponsor_intro_audio_file) gather.play(audioBase + s.sponsor_intro_audio_file);
            else gather.say('To sponsor a daily video that will be a source of chizuk for tens of thousands across the globe, press ' + (s?.sponsor_digit || '9') + '.');
            gather.pause({ length: 1 });
        }

        // Donation campaigns — each row in donation_campaigns is one "press X to donate $Y to <cause>" option.
        // Multiple campaigns can be active simultaneously; each plays its own intro audio in sort order.
        // If the campaigns table is empty (fresh install before migration), fall back to the legacy single-donation prompt.
        let dcRows = [];
        try {
            const dcRes = await pool.query(
                "SELECT * FROM donation_campaigns WHERE active = TRUE ORDER BY sort_order ASC, id ASC"
            );
            dcRows = dcRes.rows || [];
        } catch (e) { /* table may not exist yet on very old DBs — fall through to legacy */ }

        if (dcRows.length > 0) {
            for (const c of dcRows) {
                if (c.intro_audio_file) {
                    gather.play(audioBase + c.intro_audio_file);
                } else {
                    const dollars = ((c.amount_cents || 0) / 100).toFixed(0);
                    const causeLabel = c.description || c.name || 'this cause';
                    gather.say('To donate ' + dollars + ' dollars to ' + causeLabel + ', press ' + (c.digit || '8') + '.');
                }
                gather.pause({ length: 1 });
            }
        } else if (s?.donation_enabled !== false) {
            // Legacy single-donation prompt (only reached if donation_campaigns is empty/uninitialized)
            if (s?.donate_intro_audio_file) gather.play(audioBase + s.donate_intro_audio_file);
            else gather.say('To donate ' + ((s?.donation_amount_cents || 8000) / 100).toFixed(0) + ' dollars and have a kvittel said for you, press ' + (s?.kvittel_digit || '8') + '.');
            gather.pause({ length: 1 });
        }
      

        // 2. Day announcement OR skip-day announcement
        if (todaysMessage) {
            // Regular day: announce day number + offer today/yesterday/all/nishmas
            if (currentDay >= 1 && currentDay <= 40) {
                gather.say('Today is day ' + currentDay + ' of Nishmas.');
            }
            // Press 1 — today's message
            if (s?.press1_audio_file) gather.play(audioBase + s.press1_audio_file);
            else gather.say("Press 1 for today's message from");
            if (todaysMessage.speaker_name_audio) gather.play(audioBase + todaysMessage.speaker_name_audio);
            else gather.say(todaysMessage.speaker_name);
            gather.pause({ length: 1 });
            // Press 2 — yesterday's message
            if (yesterdaysMessage) {
                gather.say("Press 2 for yesterday's message from");
                if (yesterdaysMessage.speaker_name_audio) gather.play(audioBase + yesterdaysMessage.speaker_name_audio);
                else gather.say(yesterdaysMessage.speaker_name);
                gather.pause({ length: 1 });
            }
            // Press 3 — all previous messages
            gather.say('Press 3 for all previous messages.');
            // Press 4 — Nishmas
            gather.say('Press 4 to hear Nishmas.');
        } else {
            // Skip day (Shabbos / Yom Tov / content not uploaded): no "today's message"
            gather.say('There is no new message today.');
            if (yesterdaysMessage) {
                gather.say("To hear yesterday's message from");
                if (yesterdaysMessage.speaker_name_audio) gather.play(audioBase + yesterdaysMessage.speaker_name_audio);
                else gather.say(yesterdaysMessage.speaker_name);
                gather.say(', press 1.');
                gather.pause({ length: 1 });
            }
            gather.say('Press 2 for all previous messages.');
            gather.say('Press 3 to hear Nishmas.');
        }

        twiml.say("We didn't receive your selection. Please try again.");
        twiml.redirect('/webhook');
    } catch (error) {
        console.error('Webhook error:', error);
        twiml.say("We're experiencing technical difficulties.");
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/handle-menu', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const digit = req.body.Digits;
    const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
    try {
        const todaysMessage = await getTodaysMessage();
        const yesterdaysMessage = await getYesterdaysMessage();
        const isSkipDay = !todaysMessage;
        const menuSettings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const ms = menuSettings.rows[0] || {};
        const donationOn = ms.donation_enabled !== false;
        const sponsorOn = ms.sponsor_enabled !== false;
        const kvittelDigitNow = ms.kvittel_digit || ms.donation_digit || '8';
        const sponsorDigitNow = ms.sponsor_digit || '9';

        // Preload donation campaigns so the sync promptPostMessage helper can reference them
        let postCampaigns = [];
        try {
            const dcAll = await pool.query(
                "SELECT * FROM donation_campaigns WHERE active = TRUE ORDER BY sort_order ASC, id ASC"
            );
            postCampaigns = dcAll.rows || [];
        } catch (e) { /* ignore — table may not exist yet */ }

        // Helper: at the end of any played message, prompt sponsor / donation campaigns / menu
        const promptPostMessage = () => {
            const hasCampaigns = postCampaigns.length > 0;
            if (sponsorOn || donationOn || hasCampaigns) {
                const g = twiml.gather({ numDigits: 1, action: '/handle-post-message', method: 'POST', timeout: 10 });
                if (sponsorOn && ms.sponsor_intro_audio_file) g.play(audioBase + ms.sponsor_intro_audio_file);
                else if (sponsorOn) g.say('To sponsor a daily video, press ' + sponsorDigitNow + '.');

                if (hasCampaigns) {
                    for (const c of postCampaigns) {
                        if (c.intro_audio_file) g.play(audioBase + c.intro_audio_file);
                        else {
                            const dollars = ((c.amount_cents || 0) / 100).toFixed(0);
                            const causeLabel = c.description || c.name || 'this cause';
                            g.say('To donate ' + dollars + ' dollars to ' + causeLabel + ', press ' + (c.digit || '8') + '.');
                        }
                    }
                } else if (donationOn && ms.donate_intro_audio_file) g.play(audioBase + ms.donate_intro_audio_file);
                else if (donationOn) g.say('To donate ' + ((ms.donation_amount_cents || 8000) / 100).toFixed(0) + ' dollars and have a kvittel said for you, press ' + kvittelDigitNow + '.');

                g.say('Press 0 to return to the main menu.');
                twiml.redirect('/webhook');
            } else {
                twiml.say('Press any key to return to the main menu.');
                twiml.gather({ numDigits: 1, action: '/webhook', method: 'POST' });
            }
        };

        // Helper: play a message with optional skip support
        const playMessage = (m, introText, offsetSeconds) => {
            // Dedication audio (uploaded per message) — plays right before the message intro
            if (m.dedication_audio_file && (!offsetSeconds || offsetSeconds === 0)) {
                twiml.play(audioBase + m.dedication_audio_file);
                twiml.pause({ length: 1 });
            }
            twiml.say(introText + ' from');
            if (m.speaker_name_audio) twiml.play(audioBase + m.speaker_name_audio);
            else twiml.say(m.speaker_name);
            // Title — prefer recorded title audio, fall back to TTS
            if (m.title_audio) {
                twiml.say('titled');
                twiml.play(audioBase + m.title_audio);
            } else if (m.title) {
                twiml.say('titled ' + m.title);
            }

            const audioSrc = m.audio_url || (m.recorded_audio ? audioBase + m.recorded_audio : null);

            if (!audioSrc) {
                twiml.say('Audio not yet available.');
            } else if (m.allow_skip) {
                // Announce skip option
                twiml.say('To skip ahead 30 seconds at any time, press 5.');
                // Use Gather to detect press-5 during playback
                const offset = offsetSeconds || 0;
                const audioUrl = offset > 0 ? audioSrc + (audioSrc.includes('?') ? '&' : '?') + 't=' + offset : audioSrc;
                const msgId = m.id || m.day_number;
                const gather = twiml.gather({
                    numDigits: '1',
                    action: '/handle-skip?msg_id=' + msgId + '&offset=' + (offset + 30),
                    method: 'POST',
                    timeout: '3600',
                    actionOnEmptyResult: false
                });
                gather.play(audioUrl);
                // If they don't press anything, audio finishes naturally
                promptPostMessage();
            } else {
                twiml.play(audioSrc);
                promptPostMessage();
            }
        };

        // Helper: list all PAST messages (only days that have already aired)
        // Today's message is on Press 1 — Press 3 is for previously-aired days only.
        const listAllMessages = async () => {
            const all = await pool.query(
                `SELECT * FROM nishmas_messages
                 WHERE is_active = true
                   AND program_date IS NOT NULL
                   AND program_date::date < CURRENT_DATE
                 ORDER BY day_number ASC`
            );
            if (!all.rows.length) {
                twiml.say('No previous messages available yet.');
                twiml.redirect('/webhook');
                return;
            }
            const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
            const s = settings.rows[0];
            if (s?.all_messages_intro_file) twiml.play(audioBase + s.all_messages_intro_file);
            else twiml.say('Here are all available messages:');
            all.rows.forEach((msg, i) => {
                twiml.say('Press ' + (i + 1) + ' for day ' + msg.day_number + ' message from');
                if (msg.speaker_name_audio) twiml.play(audioBase + msg.speaker_name_audio);
                else twiml.say(msg.speaker_name);
            });
            if (s?.return_menu_audio_file) twiml.play(audioBase + s.return_menu_audio_file);
            else twiml.say('Press 0 to return to the main menu.');
            twiml.gather({ numDigits: 3, action: '/handle-message-selection', method: 'POST', timeout: 25 });
        };

        // Helper: Nishmas prayer branch (nusach sub-menu)
        const nishmasBranch = async () => {
            const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
            const s = settings.rows[0];
            if (s?.nishmas_audio_file && !s?.nishmas_ashkenaz_file && !s?.nishmas_mizrach_file) {
                twiml.say('Here is the Nishmas prayer.');
                twiml.play(audioBase + s.nishmas_audio_file);
                twiml.say('Thank you for saying Nishmas.');
                twiml.redirect('/webhook');
            } else {
                const gather = twiml.gather({ numDigits: 1, action: '/handle-nusach-selection', method: 'POST', timeout: 10 });
                if (s?.nishmas_nusach_prompt_file) {
                    gather.play(audioBase + s.nishmas_nusach_prompt_file);
                } else {
                    gather.say('Press 1 for Ashkenaz or Sfard. Press 2 for Eidot HaMizrach.');
                }
                twiml.say("We didn't receive your selection.");
                twiml.redirect('/webhook');
            }
        };

        // --- MENU ROUTING ---
        // Donation campaigns take first priority on digit dispatch. If the pressed
        // digit matches any active campaign, route to /donate2/start?c=<id>.
        try {
            const dcMatch = await pool.query(
                "SELECT id FROM donation_campaigns WHERE active = TRUE AND digit = $1 ORDER BY sort_order ASC, id ASC LIMIT 1",
                [String(digit || '')]
            );
            if (dcMatch.rows[0]) {
                twiml.redirect('/donate2/start?c=' + dcMatch.rows[0].id);
                res.type('text/xml').send(twiml.toString());
                return;
            }
        } catch (e) { /* fall through to legacy */ }

        // Regular day: 1=today, 2=yesterday, 3=all, 4=nishmas
        // Press 8 (kvittel_digit) = donate $80 + kvittel; Press 9 (sponsor_digit) = sponsor a video
        const settingsForRoute = await pool.query('SELECT donation_digit, kvittel_digit, donation_enabled, sponsor_digit, sponsor_enabled FROM nishmas_settings LIMIT 1');
        const sRoute = settingsForRoute.rows[0] || {};
        // kvittel_digit takes precedence; fall back to legacy donation_digit
        const kvittelDigit = sRoute.kvittel_digit || sRoute.donation_digit || '8';
        const donationEnabled = sRoute.donation_enabled !== false;
        const sponsorDigit = sRoute.sponsor_digit || '9';
        const sponsorEnabled = sRoute.sponsor_enabled !== false;
        if (sponsorEnabled && digit === sponsorDigit) {
            twiml.redirect('/sponsor/start');
            res.type('text/xml').send(twiml.toString());
            return;
        }
        if (donationEnabled && digit === kvittelDigit) {
            twiml.redirect('/donate/start');
            res.type('text/xml').send(twiml.toString());
            return;
        }
        if (!isSkipDay) {
            if (digit === '1') {
                if (todaysMessage) playMessage(todaysMessage, "Here is today's message");
                else { twiml.say("Today's message is not yet available."); twiml.redirect('/webhook'); }
            } else if (digit === '2') {
                if (yesterdaysMessage) playMessage(yesterdaysMessage, "Here is yesterday's message");
                else { twiml.say("Yesterday's message is not available."); twiml.redirect('/webhook'); }
            } else if (digit === '3') {
                await listAllMessages();
            } else if (digit === '4') {
                await nishmasBranch();
            } else {
                twiml.say('Invalid selection.');
                twiml.redirect('/webhook');
            }
        } else {
            // Skip day branch
            if (digit === '1') {
                if (yesterdaysMessage) playMessage(yesterdaysMessage, "Here is yesterday's message");
                else { twiml.say("Yesterday's message is not available."); twiml.redirect('/webhook'); }
            } else if (digit === '2') {
                await listAllMessages();
            } else if (digit === '3') {
                await nishmasBranch();
            } else {
                twiml.say('Invalid selection.');
                twiml.redirect('/webhook');
            }
        }
    } catch (error) {
        console.error(error);
        twiml.say("Technical difficulties.");
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Handle nusach selection (from press-3 menu)
app.post('/handle-nusach-selection', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const digit = req.body.Digits;
    try {
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0];
        let audioFile = null;
        if (digit === '1') {
            audioFile = s?.nishmas_ashkenaz_file || s?.nishmas_audio_file;
        } else if (digit === '2') {
            audioFile = s?.nishmas_mizrach_file || s?.nishmas_audio_file;
        }
        if (audioFile) {
            twiml.play(req.protocol + '://' + req.get('host') + '/audio/' + audioFile);
            twiml.say('Thank you for saying Nishmas.');
        } else {
            twiml.say('That version is not available yet. Returning to the main menu.');
        }
        twiml.redirect('/webhook');
    } catch (e) {
        console.error(e);
        twiml.say('Error. Returning to main menu.');
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// After a message finishes: caller can press kvittel/sponsor digit, or anything else for menu
app.post('/handle-post-message', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const digit = req.body.Digits;
        const settings = await pool.query('SELECT donation_digit, kvittel_digit, donation_enabled, sponsor_digit, sponsor_enabled FROM nishmas_settings LIMIT 1');
        const r = settings.rows[0] || {};
        const kvittelDigit = r.kvittel_digit || r.donation_digit || '8';
        const sponsorDigit = r.sponsor_digit || '9';
        if (r.sponsor_enabled !== false && digit === sponsorDigit) {
            twiml.redirect('/sponsor/start');
        } else if (r.donation_enabled !== false && digit === kvittelDigit) {
            twiml.redirect('/donate/start');
        } else {
            twiml.redirect('/webhook');
        }
    } catch (e) {
        console.error('[handle-post-message]', e);
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/handle-skip', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const digit = req.body.Digits;
        const msgId = req.query.msg_id;
        const offset = parseInt(req.query.offset) || 30;

        // Only handle press-5 as skip; anything else = return to menu
        if (digit === '5') {
            // Find the message and replay from new offset
            const result = await pool.query('SELECT * FROM nishmas_messages WHERE id = $1 OR day_number = $1::int', [msgId]);
            const m = result.rows[0];
            if (m) {
                const audioBase = process.env.AUDIO_BASE_URL || '';
                const audioSrc = m.audio_url || (m.recorded_audio ? audioBase + m.recorded_audio : null);
                if (audioSrc) {
                    twiml.say('Skipping ahead 30 seconds.');
                    const gather = twiml.gather({
                        numDigits: '1',
                        action: '/handle-skip?msg_id=' + msgId + '&offset=' + (offset + 30),
                        method: 'POST',
                        timeout: '3600',
                        actionOnEmptyResult: false
                    });
                    // Note: not all audio URLs support time offset — works for direct MP3 links
                    gather.play(audioSrc + '#t=' + offset);
                    twiml.say('Press any key to return to the main menu.');
                    twiml.gather({ numDigits: 1, action: '/webhook', method: 'POST' });
                } else {
                    twiml.say('Audio not available.');
                    twiml.redirect('/webhook');
                }
            } else {
                twiml.redirect('/webhook');
            }
        } else {
            // Any other key = return to main menu
            twiml.redirect('/webhook');
        }
    } catch (err) {
        console.error('handle-skip error:', err);
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/handle-message-selection', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const digits = req.body.Digits;
    try {
        if (digits === '0') { twiml.redirect('/webhook'); return res.type('text/xml').send(twiml.toString()); }
        // Same filter as listAllMessages — only past messages, in same order.
        // Critical that this matches so the user's chosen number lines up with what was announced.
        const all = await pool.query(
            `SELECT * FROM nishmas_messages
             WHERE is_active = true
               AND program_date IS NOT NULL
               AND program_date::date < CURRENT_DATE
             ORDER BY day_number ASC`
        );
        const i = parseInt(digits) - 1;
        if (i >= 0 && i < all.rows.length) {
            const msg = all.rows[i];
            twiml.say('Day ' + msg.day_number + ' message from');
            if (msg.speaker_name_audio) twiml.play(req.protocol + '://' + req.get('host') + '/audio/' + msg.speaker_name_audio);
            else twiml.say(msg.speaker_name);
            if (msg.title_audio) twiml.play(req.protocol + '://' + req.get('host') + '/audio/' + msg.title_audio);
            else if (msg.title) twiml.say(msg.title);
            if (msg.audio_url) twiml.play(msg.audio_url);
            else if (msg.recorded_audio) twiml.play(req.protocol + '://' + req.get('host') + '/audio/' + msg.recorded_audio);
            else twiml.say('Audio not yet available.');
            twiml.say('Press any key to return to the main menu.');
            twiml.gather({ numDigits: 1, action: '/webhook', method: 'POST' });
        } else {
            twiml.say('Message not found.');
            twiml.redirect('/webhook');
        }
    } catch (error) {
        console.error(error);
        twiml.say('Error.');
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// ── DONATION FLOW (USAePay) ─────────────────────────────────────────────────
// Caller hits /donate/start either via menu Press 9, or via end-of-message offer.
// Flow: Start → card → expmonth → expyear → cvv → process → kvittel record → done

app.all('/donate/start', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const settingsRow = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settingsRow.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const amount = parseFloat((s.donation_amount_cents || 8000) / 100);
        const callSid = req.body?.CallSid || req.query?.CallSid || '';

        // Pre-create a pending donation row so we can match it later
        const ins = await pool.query(
            'INSERT INTO donations (amount_cents, caller_phone, ivr_call_sid, status) VALUES ($1,$2,$3,$4) RETURNING id',
            [Math.round(amount * 100), req.body?.From || '', callSid, 'pending']
        );
        const donationId = ins.rows[0].id;

        // Prompt for card number
        const gather = twiml.gather({
            input: 'dtmf',
            numDigits: 19,
            finishOnKey: '#',
            action: '/donate/card?d=' + donationId,
            method: 'POST',
            timeout: 30
        });
        if (s.donate_card_prompt_file) gather.play(audioBase + s.donate_card_prompt_file);
        else gather.say('To donate ' + amount + ' dollars, please enter your credit card number using the keypad. Press the pound key when done.');
        twiml.say("We didn't receive your card number.");
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[donate/start]', e);
        twiml.say('We are unable to process donations at this time.');
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/donate/card', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const cardDigits = (req.body.Digits || '').replace(/\D/g, '');
        const donationId = req.query.d;
        if (cardDigits.length < 13 || cardDigits.length > 19) {
            twiml.say('That card number does not appear valid.');
            twiml.redirect('/donate/start');
            res.type('text/xml').send(twiml.toString());
            return;
        }
        const settingsRow = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settingsRow.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        // Collect 4 digits MMYY (e.g. 0327 = March 2027)
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 4, action: '/donate/expiry?d=' + donationId + '&c=' + cardDigits,
            method: 'POST', timeout: 20, finishOnKey: '#'
        });
        if (s.donate_expiry_prompt_file) gather.play(audioBase + s.donate_expiry_prompt_file);
        else gather.say('Please enter your card expiration date as four digits — two digits for the month, then two digits for the year.');
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[donate/card]', e);
        twiml.say('Error processing card.');
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/donate/expiry', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const expDigits = (req.body.Digits || '').replace(/\D/g, '');
        const card = req.query.c;
        const donationId = req.query.d;
        if (expDigits.length !== 4) {
            // Re-prompt without restarting (don't lose the pending donation row)
            twiml.say('Expiration date should be four digits. Please try again.');
            const settingsRow = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
            const s = settingsRow.rows[0] || {};
            const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
            const gather = twiml.gather({
                input: 'dtmf', numDigits: 4, action: '/donate/expiry?d=' + donationId + '&c=' + card,
                method: 'POST', timeout: 20, finishOnKey: '#'
            });
            if (s.donate_expiry_prompt_file) gather.play(audioBase + s.donate_expiry_prompt_file);
            else gather.say('Please enter your card expiration date as four digits — two digits for the month, then two digits for the year.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString());
            return;
        }
        const expM = expDigits.slice(0, 2);
        const expY = expDigits.slice(2, 4);
        const settingsRow = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settingsRow.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 4, action: '/donate/process?d=' + donationId + '&c=' + card + '&em=' + expM + '&ey=' + expY,
            method: 'POST', timeout: 20, finishOnKey: '#'
        });
        if (s.donate_cvv_prompt_file) gather.play(audioBase + s.donate_cvv_prompt_file);
        else gather.say('Please enter the three or four digit security code on the back of your card, then press the pound key.');
        twiml.redirect('/webhook');
    } catch (e) { console.error('[donate/expiry]', e); twiml.say('Error.'); twiml.redirect('/webhook'); }
    res.type('text/xml').send(twiml.toString());
});

app.post('/donate/process', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const cvv = (req.body.Digits || '').replace(/\D/g, '');
        const card = req.query.c;
        const expM = req.query.em;
        const expY = req.query.ey;
        const donationId = parseInt(req.query.d);
        const settingsRow = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settingsRow.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const amount = parseFloat((s.donation_amount_cents || 8000) / 100);
        const last4 = String(card).slice(-4);

        // Charge via USAePay
        const result = await chargeUSAePay({
            amount, cardNumber: card, expMonth: expM, expYear: expY, cvv,
            description: 'Nishmas IVR Donation'
        });

        // Update donation row
        await pool.query(
            'UPDATE donations SET card_last4=$1, status=$2, transaction_id=$3, auth_code=$4, decline_reason=$5 WHERE id=$6',
            [last4,
             result.approved ? 'approved' : 'declined',
             String(result.transactionId || ''),
             String(result.authCode || ''),
             result.approved ? null : (result.error || result.status || 'Declined'),
             donationId]
        );

        if (result.approved) {
            // Approved → record kvittel
            if (s.donate_thank_you_file) twiml.play(audioBase + s.donate_thank_you_file);
            else twiml.say('Thank you. Your donation of ' + amount + ' dollars has been approved.');

            twiml.pause({ length: 1 });
            if (s.donate_kvittel_prompt_file) twiml.play(audioBase + s.donate_kvittel_prompt_file);
            else twiml.say('Please say one Hebrew name for your kvittel after the beep. Press the pound key when done.');

            twiml.record({
                action: '/donate/kvittel-saved?d=' + donationId,
                method: 'POST',
                maxLength: 15,
                finishOnKey: '#',
                playBeep: true,
                trim: 'trim-silence'
            });
            // If recording times out / hits maxLength without a Twilio callback,
            // bounce back to the main menu instead of hanging up.
            twiml.redirect('/webhook');
        } else {
            // Declined — offer retry instead of bouncing to main menu
            if (s.donate_decline_file) twiml.play(audioBase + s.donate_decline_file);
            else twiml.say('We were unable to process your card. ' + (result.error || 'Please try again.'));
            twiml.pause({ length: 1 });
            const retryGather = twiml.gather({
                input: 'dtmf', numDigits: 1, action: '/donate/retry-choice', method: 'POST', timeout: 10
            });
            retryGather.say('Press 1 to try a different card, or press 0 to return to the main menu.');
            // If they don't press anything, go to main menu
            twiml.redirect('/webhook');
        }
    } catch (e) {
        console.error('[donate/process]', e);
        twiml.say('We encountered an error processing your donation.');
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Retry choice after decline
app.post('/donate/retry-choice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const digit = req.body.Digits;
    if (digit === '1') {
        twiml.redirect('/donate/start');
    } else {
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Twilio sends the recorded kvittel here. Save the URL, play thank-you,
// then bounce to the main menu so caller hears "Today is day X of Nishmas".
app.post('/donate/kvittel-saved', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const donationId = parseInt(req.query.d);
        const recordingUrl = req.body.RecordingUrl;
        if (recordingUrl && donationId) {
            await pool.query('UPDATE donations SET kvittel_recording_url=$1 WHERE id=$2', [recordingUrl, donationId]);
        }
        const settingsRow = await pool.query('SELECT donate_kvittel_thank_file FROM nishmas_settings LIMIT 1');
        const s = settingsRow.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        if (s.donate_kvittel_thank_file) twiml.play(audioBase + s.donate_kvittel_thank_file);
        else twiml.say('Thank you. Your kvittel has been received. May Hashem grant you all the brachos.');
        twiml.pause({ length: 1 });
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[donate/kvittel-saved]', e);
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════════════════
// DONATE2 — multi-campaign generic donation flow
// Each call carries the campaign_id in a query string (?c=<id>) so the
// audio prompts and amount are pulled from donation_campaigns instead of
// being hardcoded in nishmas_settings. Old /donate/* routes remain as
// fallback for the legacy single-flow setup.
// ═══════════════════════════════════════════════════════════════════════════

// Tiny helper: fetch a campaign by id (or null) — used by every donate2 step
async function getCampaign(campaignId) {
    if (!campaignId) return null;
    const r = await pool.query('SELECT * FROM donation_campaigns WHERE id = $1', [campaignId]);
    return r.rows[0] || null;
}

// Step 1: caller pressed the campaign's digit on the main menu (or post-message).
// We create a pending donation row tied to this campaign, then prompt for card.
app.all('/donate2/start', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const cid = parseInt(req.query.c, 10);
        const c = await getCampaign(cid);
        if (!c) {
            twiml.say('We are unable to process donations at this time.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString());
            return;
        }
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const callSid = req.body?.CallSid || req.query?.CallSid || '';
        const amount = (c.amount_cents || 0) / 100;

        // Pre-create a pending donation row so we can match the charge result
        // to a row in the donations table. Note: campaign_id column was added
        // by the migration; for older DBs we still try to insert and gracefully
        // fall back if the column doesn't exist.
        let donationId;
        try {
            const ins = await pool.query(
                'INSERT INTO donations (amount_cents, caller_phone, ivr_call_sid, status, campaign_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
                [c.amount_cents, req.body?.From || '', callSid, 'pending', cid]
            );
            donationId = ins.rows[0].id;
        } catch (e) {
            const ins = await pool.query(
                'INSERT INTO donations (amount_cents, caller_phone, ivr_call_sid, status) VALUES ($1,$2,$3,$4) RETURNING id',
                [c.amount_cents, req.body?.From || '', callSid, 'pending']
            );
            donationId = ins.rows[0].id;
        }

        const gather = twiml.gather({
            input: 'dtmf', numDigits: 19, finishOnKey: '#',
            action: '/donate2/card?d=' + donationId + '&c=' + cid,
            method: 'POST', timeout: 30,
        });
        if (c.card_prompt_file) gather.play(audioBase + c.card_prompt_file);
        else gather.say('To donate ' + amount + ' dollars, please enter your credit card number using the keypad. Press the pound key when done.');
        twiml.say("We didn't receive your card number.");
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[donate2/start]', e);
        twiml.say('We are unable to process donations at this time.');
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Step 2: caller entered card number. Validate length, prompt for expiry.
app.post('/donate2/card', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const cardDigits = (req.body.Digits || '').replace(/\D/g, '');
        const donationId = req.query.d;
        const cid = parseInt(req.query.c, 10);
        const c = await getCampaign(cid);
        if (!c) { twiml.say('Error.'); twiml.redirect('/webhook'); res.type('text/xml').send(twiml.toString()); return; }
        if (cardDigits.length < 13 || cardDigits.length > 19) {
            twiml.say('That card number does not appear valid.');
            twiml.redirect('/donate2/start?c=' + cid);
            res.type('text/xml').send(twiml.toString());
            return;
        }
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 4,
            action: '/donate2/expiry?d=' + donationId + '&c=' + cid + '&card=' + cardDigits,
            method: 'POST', timeout: 20, finishOnKey: '#',
        });
        if (c.expiry_prompt_file) gather.play(audioBase + c.expiry_prompt_file);
        else gather.say('Please enter your card expiration date as four digits — two digits for the month, then two digits for the year.');
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[donate2/card]', e);
        twiml.say('Error processing card.');
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Step 3: caller entered expiry. Prompt for CVV.
app.post('/donate2/expiry', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const expDigits = (req.body.Digits || '').replace(/\D/g, '');
        const card = req.query.card;
        const donationId = req.query.d;
        const cid = parseInt(req.query.c, 10);
        const c = await getCampaign(cid);
        if (!c) { twiml.say('Error.'); twiml.redirect('/webhook'); res.type('text/xml').send(twiml.toString()); return; }
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        if (expDigits.length !== 4) {
            twiml.say('Expiration date should be four digits. Please try again.');
            const g = twiml.gather({
                input: 'dtmf', numDigits: 4,
                action: '/donate2/expiry?d=' + donationId + '&c=' + cid + '&card=' + card,
                method: 'POST', timeout: 20, finishOnKey: '#',
            });
            if (c.expiry_prompt_file) g.play(audioBase + c.expiry_prompt_file);
            else g.say('Please enter your card expiration date as four digits — two digits for the month, then two digits for the year.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString());
            return;
        }
        const expM = expDigits.slice(0, 2);
        const expY = expDigits.slice(2, 4);
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 4,
            action: '/donate2/process?d=' + donationId + '&c=' + cid + '&card=' + card + '&em=' + expM + '&ey=' + expY,
            method: 'POST', timeout: 20, finishOnKey: '#',
        });
        if (c.cvv_prompt_file) gather.play(audioBase + c.cvv_prompt_file);
        else gather.say('Please enter the three or four digit security code on the back of your card, then press the pound key.');
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[donate2/expiry]', e);
        twiml.say('Error.'); twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Step 4: caller entered CVV. Charge the card via USAePay, update the donation
// row, then route to either the kvittel recording (if kvittel_enabled on the
// campaign) or a thank-you-and-hangup.
app.post('/donate2/process', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const cvv = (req.body.Digits || '').replace(/\D/g, '');
        const card = req.query.card;
        const expM = req.query.em;
        const expY = req.query.ey;
        const donationId = parseInt(req.query.d);
        const cid = parseInt(req.query.c, 10);
        const c = await getCampaign(cid);
        if (!c) { twiml.say('Error.'); twiml.redirect('/webhook'); res.type('text/xml').send(twiml.toString()); return; }
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const amount = (c.amount_cents || 0) / 100;
        const last4 = String(card).slice(-4);

        const result = await chargeUSAePay({
            amount, cardNumber: card, expMonth: expM, expYear: expY, cvv,
            description: c.name || 'IVR Donation',
        });

        await pool.query(
            'UPDATE donations SET card_last4=$1, status=$2, transaction_id=$3, auth_code=$4, decline_reason=$5 WHERE id=$6',
            [last4,
             result.approved ? 'approved' : 'declined',
             String(result.transactionId || ''),
             String(result.authCode || ''),
             result.approved ? null : (result.error || result.status || 'Declined'),
             donationId]
        );

        if (result.approved) {
            if (c.thank_you_file) twiml.play(audioBase + c.thank_you_file);
            else twiml.say('Thank you. Your donation of ' + amount + ' dollars has been approved.');

            if (c.kvittel_enabled) {
                twiml.pause({ length: 1 });
                if (c.kvittel_prompt_file) twiml.play(audioBase + c.kvittel_prompt_file);
                else twiml.say('Please say one Hebrew name for your kvittel after the beep. Press the pound key when done.');
                twiml.record({
                    action: '/donate2/kvittel-saved?d=' + donationId + '&c=' + cid,
                    method: 'POST', maxLength: 15, finishOnKey: '#',
                    playBeep: true, trim: 'trim-silence',
                });
                // If recording times out / hits maxLength without a Twilio callback,
                // bounce back to the main menu instead of hanging up.
                twiml.redirect('/webhook');
            } else {
                // No kvittel needed — bounce straight back to the main menu so the
                // caller hears "Today is day X of Nishmas" + Press 1/2/3/etc again.
                twiml.pause({ length: 1 });
                twiml.redirect('/webhook');
            }
        } else {
            // Declined — offer retry instead of bouncing out
            if (c.decline_file) twiml.play(audioBase + c.decline_file);
            else twiml.say('We were unable to process your card. ' + (result.error || 'Please try again.'));
            twiml.pause({ length: 1 });
            const retryGather = twiml.gather({
                numDigits: 1,
                action: '/donate2/retry-choice?c=' + cid,
                method: 'POST', timeout: 10,
            });
            retryGather.say('Press 1 to try again, or press 0 to return to the main menu.');
            twiml.redirect('/webhook');
        }
    } catch (e) {
        console.error('[donate2/process]', e);
        twiml.say('We were unable to process your donation at this time.');
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Retry-or-quit choice after a decline
app.post('/donate2/retry-choice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const cid = parseInt(req.query.c, 10);
    const digit = req.body.Digits;
    if (digit === '1') twiml.redirect('/donate2/start?c=' + cid);
    else twiml.redirect('/webhook');
    res.type('text/xml').send(twiml.toString());
});

// Kvittel recording completed — save the URL to the donation row, play the
// kvittel-received thank-you, then bounce back to the main menu so the caller
// hears "Today is day X of Nishmas" + the regular Press 1/2/3/etc again.
app.post('/donate2/kvittel-saved', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const donationId = parseInt(req.query.d);
        const cid = parseInt(req.query.c, 10);
        const recordingUrl = req.body.RecordingUrl;
        if (recordingUrl && donationId) {
            await pool.query('UPDATE donations SET kvittel_recording_url=$1 WHERE id=$2', [recordingUrl, donationId]);
        }
        const c = await getCampaign(cid);
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        if (c?.kvittel_thank_file) twiml.play(audioBase + c.kvittel_thank_file);
        else twiml.say('Thank you. Your kvittel has been received. May Hashem grant you all the brachos.');
        twiml.pause({ length: 1 });
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[donate2/kvittel-saved]', e);
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// ── SPONSOR FLOW (Press 9) ──────────────────────────────────────────────────
// Flow: /sponsor/start → pick full ($500) or partial ($180)
//      → /sponsor/pick-day → pick day 1-40 or # for "no specific day"
//      → /sponsor/card → /sponsor/expiry → /sponsor/process (charge)
//      → /sponsor/anonymous-choice → /sponsor/record-name (or skip if anonymous)
//      → /sponsor/saved (hangup)

// Helper: how much is already sponsored on a given day_number (1-40)?
async function getDayAvailability(dayNumber) {
    if (!dayNumber) return { full: false, partialCount: 0, locked: false };
    const r = await pool.query(
        `SELECT sponsor_type, COUNT(*) AS c
         FROM sponsorships
         WHERE day_number=$1 AND status='approved'
         GROUP BY sponsor_type`,
        [dayNumber]
    );
    let full = false, partialCount = 0;
    for (const row of r.rows) {
        if (row.sponsor_type === 'full') full = true;
        if (row.sponsor_type === 'partial') partialCount = parseInt(row.c) || 0;
    }
    return { full, partialCount, locked: full };
}

// Helper: is this day_number a Shabbos / skip day in the program?
async function isSponsorBlockedDay(dayNumber) {
    if (!dayNumber) return { blocked: false };
    // Check admin-blocked days
    const blocked = await pool.query('SELECT * FROM sponsor_day_blocks WHERE day_number=$1', [dayNumber]);
    if (blocked.rows.length) return { blocked: true, reason: blocked.rows[0].reason || 'shabbos' };
    // Check is_skip_day on the message itself
    const m = await pool.query('SELECT is_skip_day FROM nishmas_messages WHERE day_number=$1', [dayNumber]);
    if (m.rows.length && m.rows[0].is_skip_day) return { blocked: true, reason: 'shabbos' };
    return { blocked: false };
}

app.all('/sponsor/start', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const fullAmt = ((s.sponsor_full_amount_cents || 50000) / 100).toFixed(0);
        const partAmt = ((s.sponsor_partial_amount_cents || 18000) / 100).toFixed(0);

        const gather = twiml.gather({ numDigits: 1, action: '/sponsor/type-chosen', method: 'POST', timeout: 10 });
        
        gather.say('To fully sponsor a video for ' + fullAmt + ' dollars, press 1.');
        gather.say('To partially sponsor a video for ' + partAmt + ' dollars, press 2.');
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[sponsor/start]', e);
        twiml.say('We are unable to process sponsorships at this time.');
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/sponsor/type-chosen', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const digit = req.body.Digits;
        if (digit !== '1' && digit !== '2') {
            twiml.say('Invalid selection.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString());
            return;
        }
        const sponsorType = digit === '1' ? 'full' : 'partial';
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';

        // Prompt for day selection
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 2,
            action: '/sponsor/day-chosen?type=' + sponsorType,
            method: 'POST',
            finishOnKey: '#',
            timeout: 15
        });
        if (s.sponsor_pick_day_prompt_file) gather.play(audioBase + s.sponsor_pick_day_prompt_file);
        else gather.say('Please select a day from 1 to 40 to sponsor. Press the pound key for no specific day.');
        twiml.redirect('/webhook');
    } catch (e) { console.error('[sponsor/type-chosen]', e); twiml.say('Error.'); twiml.redirect('/webhook'); }
    res.type('text/xml').send(twiml.toString());
});

app.post('/sponsor/day-chosen', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const sponsorType = req.query.type; // 'full' | 'partial'
        const rawDigits = (req.body.Digits || '').replace(/\D/g, '');
        const dayNumber = rawDigits ? parseInt(rawDigits) : null;
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';

        // If they entered nothing or "0" → no specific day
        if (dayNumber !== null) {
            // Validate range 1-40
            if (dayNumber < 1 || dayNumber > 40) {
                twiml.say('That is not a valid day. Please choose a number between 1 and 40.');
                twiml.redirect('/sponsor/type-chosen?retry=' + sponsorType);
                res.type('text/xml').send(twiml.toString());
                return;
            }
            // Check past day
            const currentDay = await getCurrentProgramDay();
            if (currentDay && dayNumber < currentDay) {
                if (s.sponsor_past_day_audio_file) twiml.play(audioBase + s.sponsor_past_day_audio_file);
                else twiml.say('That day has already passed. Please choose a future day.');
                twiml.redirect('/sponsor/start');
                res.type('text/xml').send(twiml.toString());
                return;
            }
            // Check Shabbos / blocked
            const blockedCheck = await isSponsorBlockedDay(dayNumber);
            if (blockedCheck.blocked) {
                if (s.sponsor_shabbos_audio_file) twiml.play(audioBase + s.sponsor_shabbos_audio_file);
                else twiml.say('There is no video on day ' + dayNumber + ' because it is Shabbos or Yom Tov. Please choose another day.');
                twiml.redirect('/sponsor/start');
                res.type('text/xml').send(twiml.toString());
                return;
            }
            // Check availability (full locks; partial allows up to N more partials)
            const avail = await getDayAvailability(dayNumber);
            const partialMax = parseInt(s.sponsor_partial_max_per_day) || 3;
            if (sponsorType === 'full' && (avail.full || avail.partialCount > 0)) {
                if (s.sponsor_day_taken_audio_file) twiml.play(audioBase + s.sponsor_day_taken_audio_file);
                else twiml.say('Day ' + dayNumber + ' is already sponsored. Please choose another day, or sponsor partially.');
                twiml.redirect('/sponsor/start');
                res.type('text/xml').send(twiml.toString());
                return;
            }
            if (sponsorType === 'partial' && (avail.locked || avail.partialCount >= partialMax)) {
                if (s.sponsor_day_taken_audio_file) twiml.play(audioBase + s.sponsor_day_taken_audio_file);
                else twiml.say('Day ' + dayNumber + ' is no longer available for partial sponsorship. Please choose another day.');
                twiml.redirect('/sponsor/start');
                res.type('text/xml').send(twiml.toString());
                return;
            }
        }

        // Pre-create pending sponsorship row
        const amountCents = sponsorType === 'full'
            ? (s.sponsor_full_amount_cents || 50000)
            : (s.sponsor_partial_amount_cents || 18000);
        const ins = await pool.query(
            `INSERT INTO sponsorships (sponsor_type, day_number, amount_cents, caller_phone, ivr_call_sid, status)
             VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
            [sponsorType, dayNumber, amountCents, req.body?.From || '', req.body?.CallSid || '']
        );
        const sponsorshipId = ins.rows[0].id;

        // Now ask for card
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 19, finishOnKey: '#',
            action: '/sponsor/card?s=' + sponsorshipId,
            method: 'POST', timeout: 30
        });
        if (s.donate_card_prompt_file) gather.play(audioBase + s.donate_card_prompt_file);
        else gather.say('Please enter your credit card number using the keypad. Press pound when done.');
        twiml.redirect('/webhook');
    } catch (e) { console.error('[sponsor/day-chosen]', e); twiml.say('Error.'); twiml.redirect('/webhook'); }
    res.type('text/xml').send(twiml.toString());
});

app.post('/sponsor/card', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const cardDigits = (req.body.Digits || '').replace(/\D/g, '');
        const sponsorshipId = req.query.s;
        if (cardDigits.length < 13 || cardDigits.length > 19) {
            twiml.say('That card number does not appear valid.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString());
            return;
        }
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 4,
            action: '/sponsor/expiry?s=' + sponsorshipId + '&c=' + cardDigits,
            method: 'POST', timeout: 20, finishOnKey: '#'
        });
        if (s.donate_expiry_prompt_file) gather.play(audioBase + s.donate_expiry_prompt_file);
        else gather.say('Please enter your card expiration date as four digits — month then year.');
        twiml.redirect('/webhook');
    } catch (e) { console.error('[sponsor/card]', e); twiml.say('Error.'); twiml.redirect('/webhook'); }
    res.type('text/xml').send(twiml.toString());
});

app.post('/sponsor/expiry', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const expDigits = (req.body.Digits || '').replace(/\D/g, '');
        const sponsorshipId = req.query.s;
        const card = req.query.c;
        if (expDigits.length !== 4) {
            twiml.say('Expiration date should be four digits.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString());
            return;
        }
        const expM = expDigits.slice(0, 2);
        const expY = expDigits.slice(2, 4);
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 4,
            action: '/sponsor/process?s=' + sponsorshipId + '&c=' + card + '&em=' + expM + '&ey=' + expY,
            method: 'POST', timeout: 15, finishOnKey: '#'
        });
        if (s.donate_cvv_prompt_file) gather.play(audioBase + s.donate_cvv_prompt_file);
        else gather.say('Please enter the three or four digit security code on the back of your card.');
        twiml.redirect('/webhook');
    } catch (e) { console.error('[sponsor/expiry]', e); twiml.say('Error.'); twiml.redirect('/webhook'); }
    res.type('text/xml').send(twiml.toString());
});

app.post('/sponsor/process', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const cvv = (req.body.Digits || '').replace(/\D/g, '');
        const card = req.query.c;
        const expM = req.query.em;
        const expY = req.query.ey;
        const sponsorshipId = parseInt(req.query.s);

        const sp = await pool.query('SELECT * FROM sponsorships WHERE id=$1', [sponsorshipId]);
        if (!sp.rows.length) {
            twiml.say('Sponsorship session expired.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString());
            return;
        }
        const sponsorshipRow = sp.rows[0];
        const amount = (sponsorshipRow.amount_cents || 0) / 100;
        const last4 = String(card).slice(-4);

        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';

        // Charge via USAePay
        const result = await chargeUSAePay({
            amount, cardNumber: card, expMonth: expM, expYear: expY, cvv,
            description: 'Nishmas Sponsor ' + sponsorshipRow.sponsor_type + (sponsorshipRow.day_number ? ' Day ' + sponsorshipRow.day_number : ' (no specific day)')
        });

        await pool.query(
            `UPDATE sponsorships SET card_last4=$1, status=$2, transaction_id=$3, auth_code=$4, decline_reason=$5 WHERE id=$6`,
            [last4,
             result.approved ? 'approved' : 'declined',
             String(result.transactionId || ''),
             String(result.authCode || ''),
             result.approved ? null : (result.error || result.status || 'Declined'),
             sponsorshipId]
        );

        if (result.approved) {
            if (s.sponsor_thank_you_file) twiml.play(audioBase + s.sponsor_thank_you_file);
            else twiml.say('Thank you. Your sponsorship of ' + amount + ' dollars has been approved.');
            twiml.pause({ length: 1 });
            // Ask anonymous vs record name
            const gather = twiml.gather({
                numDigits: 1, action: '/sponsor/anonymous-choice?s=' + sponsorshipId, method: 'POST', timeout: 10
            });
            if (s.sponsor_anonymous_prompt_file) gather.play(audioBase + s.sponsor_anonymous_prompt_file);
            else gather.say('To sponsor anonymously, press 1. To record your name and a kvittel, press 2.');
            twiml.redirect('/webhook');
        } else {
            if (s.sponsor_decline_file) twiml.play(audioBase + s.sponsor_decline_file);
            else twiml.say('We were unable to process your card. ' + (result.error || 'Please try again.'));
            twiml.pause({ length: 1 });
            const retry = twiml.gather({ numDigits: 1, action: '/sponsor/retry-choice', method: 'POST', timeout: 10 });
            retry.say('Press 1 to try a different card, or press 0 to return to the main menu.');
            twiml.redirect('/webhook');
        }
    } catch (e) {
        console.error('[sponsor/process]', e);
        twiml.say('We encountered an error processing your sponsorship.');
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/sponsor/retry-choice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    if (req.body.Digits === '1') twiml.redirect('/sponsor/start');
    else twiml.redirect('/webhook');
    res.type('text/xml').send(twiml.toString());
});

app.post('/sponsor/anonymous-choice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const digit = req.body.Digits;
        const sponsorshipId = parseInt(req.query.s);
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        if (digit === '1') {
            // Anonymous → mark and hang up
            await pool.query('UPDATE sponsorships SET anonymous=true WHERE id=$1', [sponsorshipId]);
            if (s.sponsor_thank_you_file) twiml.play(audioBase + s.sponsor_thank_you_file);
            else twiml.say('Thank you for your anonymous sponsorship. May Hashem grant you all the brachos. Goodbye.');
            twiml.hangup();
        } else {
            // Record name + kvittel
            if (s.sponsor_record_name_prompt_file) twiml.play(audioBase + s.sponsor_record_name_prompt_file);
            else twiml.say('Please record your name and any kvittel names you would like included after the beep. Press the pound key when done.');
            twiml.record({
                action: '/sponsor/saved?s=' + sponsorshipId,
                method: 'POST',
                maxLength: 60,
                finishOnKey: '#',
                playBeep: true,
                trim: 'trim-silence'
            });
            twiml.say('Thank you. Goodbye.');
            twiml.hangup();
        }
    } catch (e) {
        console.error('[sponsor/anonymous-choice]', e);
        twiml.say('Thank you. Goodbye.');
        twiml.hangup();
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/sponsor/saved', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const sponsorshipId = parseInt(req.query.s);
        const recordingUrl = req.body.RecordingUrl;
        if (recordingUrl && sponsorshipId) {
            await pool.query('UPDATE sponsorships SET kvittel_recording_url=$1 WHERE id=$2',
                             [recordingUrl, sponsorshipId]);
        }
        const settings = await pool.query('SELECT donate_kvittel_thank_file FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        if (s.donate_kvittel_thank_file) twiml.play(audioBase + s.donate_kvittel_thank_file);
        else twiml.say('Thank you. Your kvittel has been received. May Hashem grant you all the brachos. Goodbye.');
        twiml.hangup();
    } catch (e) {
        console.error('[sponsor/saved]', e);
        twiml.say('Thank you. Goodbye.');
        twiml.hangup();
    }
    res.type('text/xml').send(twiml.toString());
});

// ── Admin: Sponsorships ─────────────────────────────────────────────────────
app.get('/api/sponsorships', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM sponsorships ORDER BY created_at DESC LIMIT 1000');
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sponsorships/stats', async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT
                COALESCE(SUM(amount_cents) FILTER (WHERE status='approved'), 0) AS total_cents,
                COUNT(*) FILTER (WHERE status='approved') AS approved_count,
                COUNT(*) FILTER (WHERE status='approved' AND sponsor_type='full') AS full_count,
                COUNT(*) FILTER (WHERE status='approved' AND sponsor_type='partial') AS partial_count,
                COUNT(*) FILTER (WHERE status='declined') AS declined_count,
                COUNT(DISTINCT day_number) FILTER (WHERE status='approved' AND day_number IS NOT NULL) AS days_sponsored
            FROM sponsorships
        `);
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sponsorships/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM sponsorships WHERE id=$1', [req.params.id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: per-day availability — shaped for the admin grid (days[]: { day, past, skip, blocked, full, partials })
app.get('/api/sponsorships/by-day', async (req, res) => {
    try {
        // Sponsorships grouped by day + type
        const r = await pool.query(`
            SELECT day_number, sponsor_type, COUNT(*) AS c
            FROM sponsorships WHERE status='approved' AND day_number IS NOT NULL
            GROUP BY day_number, sponsor_type
        `);
        const sponsorMap = {};
        for (const row of r.rows) {
            const d = parseInt(row.day_number);
            if (!sponsorMap[d]) sponsorMap[d] = { full: false, partials: 0 };
            if (row.sponsor_type === 'full') sponsorMap[d].full = true;
            if (row.sponsor_type === 'partial') sponsorMap[d].partials = parseInt(row.c) || 0;
        }
        // Admin-blocked days
        const blockedRes = await pool.query('SELECT * FROM sponsor_day_blocks');
        const blockedMap = {};
        for (const row of blockedRes.rows) blockedMap[parseInt(row.day_number)] = row.reason || 'shabbos';
        // Skip days from messages table
        const skipRes = await pool.query('SELECT day_number FROM nishmas_messages WHERE is_skip_day=true');
        const skipSet = new Set(skipRes.rows.map(r => parseInt(r.day_number)));
        // Current program day (for marking past)
        const currentDay = await getCurrentProgramDay();

        const days = [];
        for (let d = 1; d <= 40; d++) {
            const sp = sponsorMap[d] || { full: false, partials: 0 };
            days.push({
                day: d,
                past: currentDay && d < currentDay,
                skip: skipSet.has(d),
                blocked: !!blockedMap[d],
                blocked_reason: blockedMap[d] || null,
                full: sp.full,
                partials: sp.partials
            });
        }
        res.json({ days });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: block/unblock a day (e.g. mark Shabbos)
// Accepts day in URL (/block-day/3) or body ({day_number:3})
app.post('/api/sponsorships/block-day/:day?', async (req, res) => {
    try {
        const day = parseInt(req.params.day || req.body?.day_number);
        if (!day || day < 1 || day > 40) return res.status(400).json({ error: 'Invalid day' });
        const reason = (req.body && req.body.reason) || 'shabbos';
        await pool.query(
            'INSERT INTO sponsor_day_blocks (day_number, reason) VALUES ($1,$2) ON CONFLICT (day_number) DO UPDATE SET reason=$2',
            [day, reason]
        );
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sponsorships/block-day/:day', async (req, res) => {
    try {
        await pool.query('DELETE FROM sponsor_day_blocks WHERE day_number=$1', [parseInt(req.params.day)]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/donations', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM donations ORDER BY created_at DESC LIMIT 1000');
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: donation stats (matches admin UI's expected shape)
app.get('/api/donations/stats', async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT
                COALESCE(SUM(amount_cents) FILTER (WHERE status='approved'), 0) AS total_cents,
                COUNT(*) FILTER (WHERE status='approved') AS approved_count,
                COUNT(*) FILTER (WHERE status='declined') AS declined_count,
                COUNT(*) FILTER (WHERE status='approved' AND created_at > NOW() - INTERVAL '24 hours') AS approved_today,
                COUNT(*) FILTER (WHERE kvittel_recording_url IS NOT NULL AND kvittel_recording_url != '') AS kvittels_recorded
            FROM donations
        `);
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: delete a donation row (does NOT refund — admin housekeeping only)
app.delete('/api/donations/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM donations WHERE id=$1', [req.params.id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// DONATION CAMPAIGNS — admin API (CRUD + per-campaign audio uploads)
// ═══════════════════════════════════════════════════════════════════════════

// List all donation campaigns (active + inactive), sorted in display order.
app.get('/api/donation-campaigns', async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT * FROM donation_campaigns ORDER BY sort_order ASC, id ASC'
        );
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get one campaign by id (used by admin edit form)
app.get('/api/donation-campaigns/:id', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM donation_campaigns WHERE id=$1', [req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create or update a campaign (pass id to update, omit to insert).
// Body fields: name, digit, amount_cents, description, kvittel_enabled, active, sort_order
// (audio files are uploaded via a separate endpoint after the row exists)
app.post('/api/donation-campaigns', async (req, res) => {
    try {
        const {
            id, name, digit, amount_cents, description,
            kvittel_enabled, active, sort_order,
        } = req.body || {};
        if (!name || !digit || amount_cents === undefined || amount_cents === null) {
            return res.status(400).json({ error: 'name, digit, amount_cents required' });
        }
        const d = String(digit).replace(/\D/g, '').slice(0, 1);
        if (!d) return res.status(400).json({ error: 'digit must be 0-9' });
        const amt = parseInt(amount_cents, 10);
        if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'amount_cents must be a positive integer' });

        // Validate: digit must be unique among ACTIVE campaigns (we let inactive
        // ones share a digit so admin can stage replacements without losing config).
        const isActive = active !== false && active !== 'false';
        if (isActive) {
            const dupArgs = id ? [d, id] : [d];
            const dupSql = id
                ? 'SELECT id FROM donation_campaigns WHERE digit=$1 AND active=TRUE AND id != $2'
                : 'SELECT id FROM donation_campaigns WHERE digit=$1 AND active=TRUE';
            const dup = await pool.query(dupSql, dupArgs);
            if (dup.rows[0]) return res.status(400).json({ error: 'Another active campaign already uses digit ' + d });
        }

        if (id) {
            const r = await pool.query(
                `UPDATE donation_campaigns
                 SET name=$1, digit=$2, amount_cents=$3, description=$4,
                     kvittel_enabled=$5, active=$6, sort_order=$7, updated_at=NOW()
                 WHERE id=$8 RETURNING *`,
                [name, d, amt, description || null,
                 !!kvittel_enabled, isActive, parseInt(sort_order, 10) || 0, id]
            );
            return res.json(r.rows[0]);
        }
        const r = await pool.query(
            `INSERT INTO donation_campaigns
              (name, digit, amount_cents, description, kvittel_enabled, active, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [name, d, amt, description || null,
             !!kvittel_enabled, isActive, parseInt(sort_order, 10) || 0]
        );
        res.json(r.rows[0]);
    } catch (e) {
        console.error('[POST /api/donation-campaigns]', e);
        res.status(500).json({ error: e.message });
    }
});

// Delete a campaign
app.delete('/api/donation-campaigns/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM donation_campaigns WHERE id=$1', [req.params.id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reorder campaigns. Body: { order: [id1, id2, id3] } — sort_order assigned by index.
app.post('/api/donation-campaigns/reorder', async (req, res) => {
    try {
        const order = Array.isArray(req.body?.order) ? req.body.order : [];
        for (let i = 0; i < order.length; i++) {
            await pool.query(
                'UPDATE donation_campaigns SET sort_order=$1, updated_at=NOW() WHERE id=$2',
                [i, order[i]]
            );
        }
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload one audio file for a campaign. Slot is one of:
//   intro / card_prompt / expiry_prompt / cvv_prompt / thank_you /
//   decline / kvittel_prompt / kvittel_thank
// File is saved into the uploads dir (same shared dir as message audio); the
// column gets the saved filename so /audio/<filename> serves it back.
const DC_AUDIO_SLOTS = {
    intro:          'intro_audio_file',
    card_prompt:    'card_prompt_file',
    expiry_prompt:  'expiry_prompt_file',
    cvv_prompt:     'cvv_prompt_file',
    thank_you:      'thank_you_file',
    decline:        'decline_file',
    kvittel_prompt: 'kvittel_prompt_file',
    kvittel_thank:  'kvittel_thank_file',
};

app.post('/api/donation-campaigns/:id/audio/:slot', upload.single('audio'), async (req, res) => {
    try {
        const col = DC_AUDIO_SLOTS[req.params.slot];
        if (!col) return res.status(400).json({ error: 'Invalid slot. Must be one of: ' + Object.keys(DC_AUDIO_SLOTS).join(', ') });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded (form field name must be "audio")' });
        // multer's diskStorage saved it under req.file.filename in /uploads
        const filename = req.file.filename;
        const r = await pool.query(
            `UPDATE donation_campaigns SET ${col} = $1, updated_at=NOW() WHERE id=$2 RETURNING *`,
            [filename, req.params.id]
        );
        if (!r.rows[0]) return res.status(404).json({ error: 'Campaign not found' });
        res.json({ ok: true, filename, campaign: r.rows[0] });
    } catch (e) {
        console.error('[POST /api/donation-campaigns/:id/audio]', e);
        res.status(500).json({ error: e.message });
    }
});

// Clear (unset) an audio slot — the IVR will fall back to TTS for that prompt.
app.delete('/api/donation-campaigns/:id/audio/:slot', async (req, res) => {
    try {
        const col = DC_AUDIO_SLOTS[req.params.slot];
        if (!col) return res.status(400).json({ error: 'Invalid slot' });
        await pool.query(
            `UPDATE donation_campaigns SET ${col} = NULL, updated_at=NOW() WHERE id=$1`,
            [req.params.id]
        );
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPONSOR FLOW (Press 9 — sponsor a daily video) ──────────────────────────
// Caller: Press 9 → /sponsor/start → choose full/partial → /sponsor/pick-day →
//         /sponsor/card → /sponsor/expiry → /sponsor/process (charge) →
//         /sponsor/anonymous-choice → optional /sponsor/record-name → /sponsor/done

// Helper: return the day's availability status
//   { status: 'available' | 'past' | 'shabbos' | 'blocked' | 'full' | 'partial-only',
//     partials_used: 0-3, full_taken: bool }
async function getDayAvailability(dayNum) {
    const today = await getCurrentProgramDay();
    if (dayNum < today) return { status: 'past' };
    // Check if message exists and is_skip_day
    const msg = await pool.query('SELECT is_skip_day FROM nishmas_messages WHERE day_number=$1', [dayNum]);
    if (msg.rows.length && msg.rows[0].is_skip_day) return { status: 'shabbos' };
    // Check admin block
    const blk = await pool.query('SELECT 1 FROM sponsor_day_blocks WHERE day_number=$1', [dayNum]);
    if (blk.rows.length) return { status: 'blocked' };
    // Check existing sponsorships (only count approved ones)
    const sp = await pool.query(
        "SELECT sponsor_type FROM sponsorships WHERE day_number=$1 AND status='approved'",
        [dayNum]
    );
    let fullTaken = false;
    let partials = 0;
    sp.rows.forEach(r => {
        if (r.sponsor_type === 'full') fullTaken = true;
        else if (r.sponsor_type === 'partial') partials++;
    });
    if (fullTaken) return { status: 'full', partials_used: partials, full_taken: true };
    return {
        status: partials >= 3 ? 'full' : (partials > 0 ? 'partial-only' : 'available'),
        partials_used: partials,
        full_taken: false
    };
}

// Step 1: caller pressed 9 → choose full vs partial
app.all('/sponsor/start', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const fullDollars = ((s.sponsor_full_amount_cents || 50000) / 100).toFixed(0);
        const partialDollars = ((s.sponsor_partial_amount_cents || 18000) / 100).toFixed(0);

        const gather = twiml.gather({
            input: 'dtmf', numDigits: 1,
            action: '/sponsor/pick-amount', method: 'POST', timeout: 12
        });
        if (s.sponsor_intro_audio_file) {
            gather.play(audioBase + s.sponsor_intro_audio_file);
        } else {
            gather.say('To sponsor a daily video that will be a source of chizuk for tens of thousands across the globe, ' +
                       'press 1 to fully sponsor a video for ' + fullDollars + ' dollars, ' +
                       'press 2 to partially sponsor a video for ' + partialDollars + ' dollars.');
        }
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[sponsor/start]', e);
        twiml.say('Error.'); twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Step 2: full ($500) or partial ($180) chosen → ask for day
app.post('/sponsor/pick-amount', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const digit = req.body.Digits;
        if (digit !== '1' && digit !== '2') {
            twiml.say('Invalid selection.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString()); return;
        }
        const sponsorType = digit === '1' ? 'full' : 'partial';
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';

        const gather = twiml.gather({
            input: 'dtmf', numDigits: 2,
            action: '/sponsor/check-day?type=' + sponsorType,
            method: 'POST', timeout: 15, finishOnKey: '#'
        });
        if (s.sponsor_pick_day_prompt_file) {
            gather.play(audioBase + s.sponsor_pick_day_prompt_file);
        } else {
            gather.say('Please select a day from 1 to 40 to sponsor. For no specific day, press the pound key.');
        }
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[sponsor/pick-amount]', e);
        twiml.say('Error.'); twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Step 3: day chosen — validate it
app.post('/sponsor/check-day', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const sponsorType = req.query.type; // 'full' or 'partial'
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const dayInput = (req.body.Digits || '').trim();
        let dayNum = null;

        // Empty digits = "no specific day"
        if (dayInput === '' || dayInput === '#') {
            dayNum = null;
        } else {
            const n = parseInt(dayInput, 10);
            if (!Number.isInteger(n) || n < 1 || n > 40) {
                twiml.say('That is not a valid day. Please choose a day from 1 to 40, or press pound for no specific day.');
                twiml.redirect('/sponsor/pick-amount-redirect?type=' + sponsorType);
                res.type('text/xml').send(twiml.toString()); return;
            }
            dayNum = n;

            // Validate availability
            const avail = await getDayAvailability(dayNum);

            const replayDayPrompt = (audioField, fallbackText) => {
                if (s[audioField]) twiml.play(audioBase + s[audioField]);
                else twiml.say(fallbackText);
                twiml.redirect('/sponsor/pick-amount-redirect?type=' + sponsorType);
            };

            if (avail.status === 'past') {
                return replayDayPrompt('sponsor_past_day_audio_file',
                    'That day has already passed. Please choose a future day.') ||
                    res.type('text/xml').send(twiml.toString());
            }
            if (avail.status === 'shabbos') {
                if (s.sponsor_shabbos_audio_file) twiml.play(audioBase + s.sponsor_shabbos_audio_file);
                else twiml.say('There is no video on Shabbos. Please choose another day.');
                twiml.redirect('/sponsor/pick-amount-redirect?type=' + sponsorType);
                res.type('text/xml').send(twiml.toString()); return;
            }
            if (avail.status === 'blocked' || avail.status === 'full') {
                if (s.sponsor_day_taken_audio_file) twiml.play(audioBase + s.sponsor_day_taken_audio_file);
                else twiml.say('That day is already fully sponsored. Please choose another day.');
                twiml.redirect('/sponsor/pick-amount-redirect?type=' + sponsorType);
                res.type('text/xml').send(twiml.toString()); return;
            }
            if (avail.status === 'partial-only' && sponsorType === 'full') {
                if (s.sponsor_day_taken_audio_file) twiml.play(audioBase + s.sponsor_day_taken_audio_file);
                else twiml.say('That day already has partial sponsors and cannot be fully sponsored. Please choose another day.');
                twiml.redirect('/sponsor/pick-amount-redirect?type=' + sponsorType);
                res.type('text/xml').send(twiml.toString()); return;
            }
        }

        // Day is valid (or null) — pre-create pending sponsorship row
        const amount = sponsorType === 'full'
            ? (s.sponsor_full_amount_cents || 50000)
            : (s.sponsor_partial_amount_cents || 18000);
        const ins = await pool.query(
            'INSERT INTO sponsorships (day_number, sponsor_type, amount_cents, status, caller_phone, ivr_call_sid) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [dayNum, sponsorType, amount, 'pending', req.body?.From || '', req.body?.CallSid || '']
        );
        const sponsorshipId = ins.rows[0].id;

        // Now ask for card number
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 19,
            finishOnKey: '#',
            action: '/sponsor/card?sid=' + sponsorshipId,
            method: 'POST', timeout: 30
        });
        if (s.donate_card_prompt_file) gather.play(audioBase + s.donate_card_prompt_file);
        else gather.say('Please enter your credit card number using the keypad. Press the pound key when done.');
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[sponsor/check-day]', e);
        twiml.say('Error.'); twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Helper redirect endpoint — re-asks the day selection (used after day rejected)
app.all('/sponsor/pick-amount-redirect', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const sponsorType = req.query.type;
    const settings = await pool.query('SELECT sponsor_pick_day_prompt_file FROM nishmas_settings LIMIT 1');
    const s = settings.rows[0] || {};
    const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
    const gather = twiml.gather({
        input: 'dtmf', numDigits: 2,
        action: '/sponsor/check-day?type=' + sponsorType,
        method: 'POST', timeout: 15, finishOnKey: '#'
    });
    if (s.sponsor_pick_day_prompt_file) gather.play(audioBase + s.sponsor_pick_day_prompt_file);
    else gather.say('Please select a day from 1 to 40, or press pound for no specific day.');
    twiml.redirect('/webhook');
    res.type('text/xml').send(twiml.toString());
});

// Step 4: card collected → ask expiry
app.post('/sponsor/card', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const cardDigits = (req.body.Digits || '').replace(/\D/g, '');
        const sid = req.query.sid;
        if (cardDigits.length < 13 || cardDigits.length > 19) {
            twiml.say('That card number does not appear valid.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString()); return;
        }
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 4,
            action: '/sponsor/expiry?sid=' + sid + '&c=' + cardDigits,
            method: 'POST', timeout: 20, finishOnKey: '#'
        });
        if (s.donate_expiry_prompt_file) gather.play(audioBase + s.donate_expiry_prompt_file);
        else gather.say('Please enter your card expiration date as four digits, two for the month and two for the year.');
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[sponsor/card]', e);
        twiml.say('Error.'); twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Step 5: expiry collected → ask CVV
app.post('/sponsor/expiry', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const expDigits = (req.body.Digits || '').replace(/\D/g, '');
        const sid = req.query.sid;
        const card = req.query.c;
        if (expDigits.length !== 4) {
            twiml.say('Expiration date should be four digits.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString()); return;
        }
        const expM = expDigits.slice(0, 2);
        const expY = expDigits.slice(2, 4);
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 4,
            action: '/sponsor/process?sid=' + sid + '&c=' + card + '&em=' + expM + '&ey=' + expY,
            method: 'POST', timeout: 15, finishOnKey: '#'
        });
        if (s.donate_cvv_prompt_file) gather.play(audioBase + s.donate_cvv_prompt_file);
        else gather.say('Please enter the three or four digit security code on the back of your card.');
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[sponsor/expiry]', e);
        twiml.say('Error.'); twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

// Step 6: CVV collected → CHARGE the card via Sola
app.post('/sponsor/process', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const cvv = (req.body.Digits || '').replace(/\D/g, '');
        const sid = parseInt(req.query.sid);
        const card = req.query.c;
        const expM = req.query.em;
        const expY = req.query.ey;
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';
        // Look up sponsorship row for amount + type
        const sp = await pool.query('SELECT * FROM sponsorships WHERE id=$1', [sid]);
        if (!sp.rows.length) {
            twiml.say('We could not find your sponsorship record.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString()); return;
        }
        const sponsorship = sp.rows[0];
        const amount = sponsorship.amount_cents / 100;
        const last4 = String(card).slice(-4);

        // Charge via Sola
        const result = await chargeSola({
            amount, cardNumber: card, expMonth: expM, expYear: expY, cvv,
            description: 'Nishmas Sponsorship Day ' + (sponsorship.day_number || 'unspecified'),
            invoice: 'NISHMAS-SP-' + sid
        });

        await pool.query(
            'UPDATE sponsorships SET card_last4=$1, status=$2, transaction_id=$3, auth_code=$4, decline_reason=$5 WHERE id=$6',
            [last4,
             result.approved ? 'approved' : 'declined',
             String(result.transactionId || ''),
             String(result.authCode || ''),
             result.approved ? null : (result.error || result.status || 'Declined'),
             sid]
        );

        if (!result.approved) {
            // Declined
            if (s.sponsor_decline_file) twiml.play(audioBase + s.sponsor_decline_file);
            else twiml.say('We were unable to process your card. ' + (result.error || 'Please try again later.'));
            twiml.pause({ length: 1 });
            const retry = twiml.gather({ input: 'dtmf', numDigits: 1, action: '/sponsor/retry-choice', method: 'POST', timeout: 10 });
            retry.say('Press 1 to try a different card, or press 0 to return to the main menu.');
            twiml.redirect('/webhook');
            res.type('text/xml').send(twiml.toString()); return;
        }

        // Approved → ask if anonymous or wants to record name
        if (s.sponsor_thank_you_file) twiml.play(audioBase + s.sponsor_thank_you_file);
        else twiml.say('Thank you. Your sponsorship of ' + amount + ' dollars has been approved.');
        twiml.pause({ length: 1 });
        const gather = twiml.gather({
            input: 'dtmf', numDigits: 1,
            action: '/sponsor/anonymous-choice?sid=' + sid,
            method: 'POST', timeout: 12
        });
        if (s.sponsor_anonymous_prompt_file) {
            gather.play(audioBase + s.sponsor_anonymous_prompt_file);
        } else {
            gather.say('Press 1 to sponsor anonymously, or press 2 to record your name for the dedication.');
        }
        twiml.redirect('/webhook');
    } catch (e) {
        console.error('[sponsor/process]', e);
        twiml.say('We encountered an error processing your sponsorship.');
        twiml.redirect('/webhook');
    }
    res.type('text/xml').send(twiml.toString());
});

app.post('/sponsor/retry-choice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    if (req.body.Digits === '1') twiml.redirect('/sponsor/start');
    else twiml.redirect('/webhook');
    res.type('text/xml').send(twiml.toString());
});

// Step 7: anonymous or record name?
app.post('/sponsor/anonymous-choice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const digit = req.body.Digits;
        const sid = parseInt(req.query.sid);
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const s = settings.rows[0] || {};
        const audioBase = req.protocol + '://' + req.get('host') + '/audio/';

        if (digit === '1') {
            // Anonymous
            await pool.query('UPDATE sponsorships SET anonymous=true WHERE id=$1', [sid]);
            twiml.say('Your sponsorship has been marked anonymous. Thank you and may Hashem grant you all the brachos. Goodbye.');
            twiml.hangup();
        } else {
            // Record name
            if (s.sponsor_record_name_prompt_file) twiml.play(audioBase + s.sponsor_record_name_prompt_file);
            else twiml.say('Please record your name for the dedication after the beep. Press the pound key when done.');
            twiml.record({
                action: '/sponsor/name-saved?sid=' + sid,
                method: 'POST',
                maxLength: 30,
                finishOnKey: '#',
                playBeep: true,
                trim: 'trim-silence'
            });
            twiml.say('Thank you. Goodbye.');
            twiml.hangup();
        }
    } catch (e) {
        console.error('[sponsor/anonymous-choice]', e);
        twiml.say('Thank you. Goodbye.'); twiml.hangup();
    }
    res.type('text/xml').send(twiml.toString());
});

// Step 8: name recording saved
app.post('/sponsor/name-saved', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const sid = parseInt(req.query.sid);
        const recordingUrl = req.body.RecordingUrl;
        if (recordingUrl && sid) {
            await pool.query('UPDATE sponsorships SET sponsor_name=$1, kvittel_recording_url=$2 WHERE id=$3',
                [recordingUrl, recordingUrl, sid]);
        }
        twiml.say('Thank you. Your sponsorship has been received. May Hashem grant you all the brachos. Goodbye.');
        twiml.hangup();
    } catch (e) {
        console.error('[sponsor/name-saved]', e);
        twiml.say('Thank you. Goodbye.'); twiml.hangup();
    }
    res.type('text/xml').send(twiml.toString());
});

// Admin: list sponsorships
app.get('/api/sponsorships', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM sponsorships ORDER BY created_at DESC LIMIT 1000');
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: sponsorship stats
app.get('/api/sponsorships/stats', async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT
                COALESCE(SUM(amount_cents) FILTER (WHERE status='approved'), 0) AS total_cents,
                COUNT(*) FILTER (WHERE status='approved' AND sponsor_type='full') AS full_count,
                COUNT(*) FILTER (WHERE status='approved' AND sponsor_type='partial') AS partial_count,
                COUNT(*) FILTER (WHERE status='approved') AS approved_count,
                COUNT(*) FILTER (WHERE status='declined') AS declined_count,
                COUNT(DISTINCT day_number) FILTER (WHERE status='approved' AND day_number IS NOT NULL) AS days_sponsored,
                COUNT(*) FILTER (WHERE status='approved' AND day_number IS NULL) AS unspecified_day_count
            FROM sponsorships
        `);
        res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: per-day availability map (1-40) — for the admin UI to show what's free/taken/blocked
app.get('/api/sponsorships/by-day', async (req, res) => {
    try {
        const today = await getCurrentProgramDay();
        const sp = await pool.query(
            "SELECT day_number, sponsor_type FROM sponsorships WHERE status='approved' AND day_number IS NOT NULL"
        );
        const blocks = await pool.query('SELECT day_number, reason FROM sponsor_day_blocks');
        const skips = await pool.query('SELECT day_number FROM nishmas_messages WHERE is_skip_day = true');
        const dayMap = {};
        for (let d = 1; d <= 40; d++) {
            dayMap[d] = { day: d, full: false, partials: 0, blocked: false, skip: false, past: d < today, blocked_reason: null };
        }
        sp.rows.forEach(r => {
            if (!dayMap[r.day_number]) return;
            if (r.sponsor_type === 'full') dayMap[r.day_number].full = true;
            else if (r.sponsor_type === 'partial') dayMap[r.day_number].partials++;
        });
        blocks.rows.forEach(r => {
            if (dayMap[r.day_number]) {
                dayMap[r.day_number].blocked = true;
                dayMap[r.day_number].blocked_reason = r.reason;
            }
        });
        skips.rows.forEach(r => { if (dayMap[r.day_number]) dayMap[r.day_number].skip = true; });
        res.json({ today, days: Object.values(dayMap) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: block/unblock a day
app.post('/api/sponsorships/block-day', async (req, res) => {
    try {
        const { day_number, reason } = req.body;
        const n = parseInt(day_number, 10);
        if (!Number.isInteger(n) || n < 1 || n > 40) return res.status(400).json({ error: 'day_number must be 1-40' });
        await pool.query(
            'INSERT INTO sponsor_day_blocks (day_number, reason) VALUES ($1, $2) ON CONFLICT (day_number) DO UPDATE SET reason=EXCLUDED.reason, blocked_at=NOW()',
            [n, reason || null]
        );
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sponsorships/block-day/:day', async (req, res) => {
    try {
        await pool.query('DELETE FROM sponsor_day_blocks WHERE day_number=$1', [req.params.day]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sponsorships/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM sponsorships WHERE id=$1', [req.params.id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Chunked upload endpoint — splits large files into small pieces to bypass Railway timeout
const uploadChunks = {};

app.post('/api/upload-chunk', upload.single('chunk'), async (req, res) => {
  try {
    const { upload_id, chunk_index, total_chunks, filename } = req.body;
    if (!upload_id || chunk_index === undefined || !total_chunks || !filename) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!uploadChunks[upload_id]) uploadChunks[upload_id] = { chunks: {}, filename, total: parseInt(total_chunks) };
    uploadChunks[upload_id].chunks[parseInt(chunk_index)] = req.file.path;

    const received = Object.keys(uploadChunks[upload_id].chunks).length;
    const total = uploadChunks[upload_id].total;

    if (received === total) {
      // All chunks received — assemble
      const ext = path.extname(filename).toLowerCase();
      const safeName = Date.now() + '_' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalPath = 'uploads/' + safeName;
      const writeStream = fs.createWriteStream(finalPath);
      for (let i = 0; i < total; i++) {
        const chunkPath = uploadChunks[upload_id].chunks[i];
        const data = fs.readFileSync(chunkPath);
        writeStream.write(data);
        fs.unlinkSync(chunkPath);
      }
      writeStream.end();
      delete uploadChunks[upload_id];

      // If not already mp3, convert
      let finalFile = safeName;
      if (ext !== '.mp3') {
        try {
          const mp3Name = safeName.replace(ext, '.mp3');
          await new Promise((resolve, reject) => {
            ffmpeg(finalPath).toFormat('mp3').on('end', resolve).on('error', reject).save('uploads/' + mp3Name);
          });
          fs.unlinkSync(finalPath);
          finalFile = mp3Name;
        } catch(e) { console.error('Conversion error:', e.message); }
      }
      return res.json({ ok: true, filename: finalFile, url: '/audio/' + finalFile });
    }

    res.json({ ok: true, received, total });
  } catch(e) {
    console.error('Chunk upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/messages', async (req, res) => {
    const messages = await pool.query('SELECT * FROM nishmas_messages ORDER BY day_number ASC');
    res.json(messages.rows);
});

app.post('/api/messages', upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'speaker_audio', maxCount: 1 },
    { name: 'title_audio', maxCount: 1 },
    { name: 'dedication_audio', maxCount: 1 }
]), async (req, res) => {
    try {
        const { day_number, title, speaker_name, audio_url, program_date } = req.body;
        let recorded_audio = null, speaker_name_audio = null, title_audio = null, dedication_audio = null;
        if (req.files?.audio) recorded_audio = await convertToMp3(req.files.audio[0].filename);
        if (req.files?.speaker_audio) speaker_name_audio = await convertToMp3(req.files.speaker_audio[0].filename);
        if (req.files?.title_audio) title_audio = await convertToMp3(req.files.title_audio[0].filename);
        if (req.files?.dedication_audio) dedication_audio = await convertToMp3(req.files.dedication_audio[0].filename);

        const allow_skip = req.body.allow_skip === 'true' || req.body.allow_skip === true;
        const is_skip_day = req.body.is_skip_day === 'true' || req.body.is_skip_day === true;
        const existing = await pool.query('SELECT id FROM nishmas_messages WHERE day_number = $1', [day_number]);
        if (existing.rows.length) {
            let query = 'UPDATE nishmas_messages SET title = $2, speaker_name = $3, date_recorded = NOW(), program_date = $4, allow_skip = $5, is_skip_day = $6';
            const params = [day_number, title, speaker_name, program_date || null, allow_skip, is_skip_day];
            let p = 7;
            if (speaker_name_audio) { query += ', speaker_name_audio = $' + p; params.push(speaker_name_audio); p++; }
            if (title_audio) { query += ', title_audio = $' + p; params.push(title_audio); p++; }
            if (dedication_audio) { query += ', dedication_audio_file = $' + p; params.push(dedication_audio); p++; }
            // Only update audio_url when a non-empty URL is provided. An empty
            // value during an edit must NOT wipe the existing saved audio.
            if (audio_url !== undefined && String(audio_url).trim() !== '') {
              query += ', audio_url = $' + p; params.push(String(audio_url).trim()); p++;
            }
            if (recorded_audio) { query += ', recorded_audio = $' + p; params.push(recorded_audio); p++; }
            query += ' WHERE day_number = $1';
            await pool.query(query, params);
        } else {
            await pool.query(
                'INSERT INTO nishmas_messages (day_number, title, title_audio, speaker_name, speaker_name_audio, audio_url, recorded_audio, program_date, allow_skip, is_skip_day, dedication_audio_file, date_recorded) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())',
                [day_number, title, title_audio, speaker_name, speaker_name_audio, audio_url || null, recorded_audio, program_date || null, allow_skip, is_skip_day, dedication_audio]
            );
        }
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/messages/:day/dedication-audio', async (req, res) => {
    try { await pool.query('UPDATE nishmas_messages SET dedication_audio_file = NULL WHERE day_number = $1', [req.params.day]); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/messages/:day/speaker-audio', async (req, res) => {
    try { await pool.query('UPDATE nishmas_messages SET speaker_name_audio = NULL WHERE day_number = $1', [req.params.day]); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/messages/:day/title-audio', async (req, res) => {
    try { await pool.query('UPDATE nishmas_messages SET title_audio = NULL WHERE day_number = $1', [req.params.day]); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/messages/:day', async (req, res) => {
    try { 
        const result = await pool.query('DELETE FROM nishmas_messages WHERE day_number = $1 RETURNING id', [req.params.day]); 
        res.json({ success: true, deleted: result.rowCount }); 
    }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/settings', async (req, res) => {
    const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
    const currentDay = await getCurrentProgramDay();
    res.json({ settings: settings.rows[0] || {}, current_program_day: currentDay });
});

app.post('/api/settings', upload.fields([
    { name: 'greeting_audio', maxCount: 1 },
    { name: 'press1_audio', maxCount: 1 },
    { name: 'press2_audio', maxCount: 1 },
    { name: 'press3_audio', maxCount: 1 },
    { name: 'nishmas_audio', maxCount: 1 },
    { name: 'nishmas_ashkenaz', maxCount: 1 },
    { name: 'nishmas_mizrach', maxCount: 1 },
    { name: 'nishmas_nusach_prompt', maxCount: 1 },
    { name: 'all_messages_intro', maxCount: 1 },
    { name: 'return_menu_audio', maxCount: 1 },
    { name: 'closing_audio', maxCount: 1 },
    // Donation prompts
    { name: 'donate_intro_audio', maxCount: 1 },
    { name: 'donate_card_prompt', maxCount: 1 },
    { name: 'donate_expiry_prompt', maxCount: 1 },
    { name: 'donate_cvv_prompt', maxCount: 1 },
    { name: 'donate_kvittel_prompt', maxCount: 1 },
    { name: 'donate_thank_you', maxCount: 1 },
    { name: 'donate_decline', maxCount: 1 },
    { name: 'donate_kvittel_thank', maxCount: 1 },
    // Sponsor prompts
    { name: 'sponsor_intro_audio', maxCount: 1 },
    { name: 'sponsor_pick_day_prompt', maxCount: 1 },
    { name: 'sponsor_day_taken_audio', maxCount: 1 },
    { name: 'sponsor_shabbos_audio', maxCount: 1 },
    { name: 'sponsor_past_day_audio', maxCount: 1 },
    { name: 'sponsor_anonymous_prompt', maxCount: 1 },
    { name: 'sponsor_record_name_prompt', maxCount: 1 },
    { name: 'sponsor_thank_you', maxCount: 1 },
    { name: 'sponsor_decline', maxCount: 1 }
]), async (req, res) => {
    try {
        const { program_start_date, donation_enabled, donation_amount_cents, donation_digit, kvittel_digit,
                sponsor_enabled, sponsor_digit, sponsor_full_amount_cents, sponsor_partial_amount_cents,
                sponsor_partial_max_per_day } = req.body;
        const f = {};
        if (req.files) {
            if (req.files.greeting_audio) f.greeting_audio_file = await convertToMp3(req.files.greeting_audio[0].filename);
            if (req.files.press1_audio) f.press1_audio_file = await convertToMp3(req.files.press1_audio[0].filename);
            if (req.files.press2_audio) f.press2_audio_file = await convertToMp3(req.files.press2_audio[0].filename);
            if (req.files.press3_audio) f.press3_audio_file = await convertToMp3(req.files.press3_audio[0].filename);
            if (req.files.nishmas_audio) f.nishmas_audio_file = await convertToMp3(req.files.nishmas_audio[0].filename);
            if (req.files.nishmas_ashkenaz) f.nishmas_ashkenaz_file = await convertToMp3(req.files.nishmas_ashkenaz[0].filename);
            if (req.files.nishmas_mizrach) f.nishmas_mizrach_file = await convertToMp3(req.files.nishmas_mizrach[0].filename);
            if (req.files.nishmas_nusach_prompt) f.nishmas_nusach_prompt_file = await convertToMp3(req.files.nishmas_nusach_prompt[0].filename);
            if (req.files.all_messages_intro) f.all_messages_intro_file = await convertToMp3(req.files.all_messages_intro[0].filename);
            if (req.files.return_menu_audio) f.return_menu_audio_file = await convertToMp3(req.files.return_menu_audio[0].filename);
            if (req.files.closing_audio) f.closing_audio_file = await convertToMp3(req.files.closing_audio[0].filename);
            if (req.files.donate_intro_audio) f.donate_intro_audio_file = await convertToMp3(req.files.donate_intro_audio[0].filename);
            if (req.files.donate_card_prompt) f.donate_card_prompt_file = await convertToMp3(req.files.donate_card_prompt[0].filename);
            if (req.files.donate_expiry_prompt) f.donate_expiry_prompt_file = await convertToMp3(req.files.donate_expiry_prompt[0].filename);
            if (req.files.donate_cvv_prompt) f.donate_cvv_prompt_file = await convertToMp3(req.files.donate_cvv_prompt[0].filename);
            if (req.files.donate_kvittel_prompt) f.donate_kvittel_prompt_file = await convertToMp3(req.files.donate_kvittel_prompt[0].filename);
            if (req.files.donate_thank_you) f.donate_thank_you_file = await convertToMp3(req.files.donate_thank_you[0].filename);
            if (req.files.donate_decline) f.donate_decline_file = await convertToMp3(req.files.donate_decline[0].filename);
            if (req.files.donate_kvittel_thank) f.donate_kvittel_thank_file = await convertToMp3(req.files.donate_kvittel_thank[0].filename);
            if (req.files.sponsor_intro_audio) f.sponsor_intro_audio_file = await convertToMp3(req.files.sponsor_intro_audio[0].filename);
            if (req.files.sponsor_pick_day_prompt) f.sponsor_pick_day_prompt_file = await convertToMp3(req.files.sponsor_pick_day_prompt[0].filename);
            if (req.files.sponsor_day_taken_audio) f.sponsor_day_taken_audio_file = await convertToMp3(req.files.sponsor_day_taken_audio[0].filename);
            if (req.files.sponsor_shabbos_audio) f.sponsor_shabbos_audio_file = await convertToMp3(req.files.sponsor_shabbos_audio[0].filename);
            if (req.files.sponsor_past_day_audio) f.sponsor_past_day_audio_file = await convertToMp3(req.files.sponsor_past_day_audio[0].filename);
            if (req.files.sponsor_anonymous_prompt) f.sponsor_anonymous_prompt_file = await convertToMp3(req.files.sponsor_anonymous_prompt[0].filename);
            if (req.files.sponsor_record_name_prompt) f.sponsor_record_name_prompt_file = await convertToMp3(req.files.sponsor_record_name_prompt[0].filename);
            if (req.files.sponsor_thank_you) f.sponsor_thank_you_file = await convertToMp3(req.files.sponsor_thank_you[0].filename);
            if (req.files.sponsor_decline) f.sponsor_decline_file = await convertToMp3(req.files.sponsor_decline[0].filename);
        }
        const fields = {};
        if (program_start_date) fields.program_start_date = program_start_date;
        if (donation_enabled !== undefined) fields.donation_enabled = donation_enabled === 'true' || donation_enabled === true;
        if (donation_amount_cents !== undefined) fields.donation_amount_cents = parseInt(donation_amount_cents, 10) || 8000;
        if (donation_digit !== undefined && /^[0-9]$/.test(String(donation_digit))) fields.donation_digit = String(donation_digit);
        if (kvittel_digit !== undefined && /^[0-9]$/.test(String(kvittel_digit))) fields.kvittel_digit = String(kvittel_digit);
        if (sponsor_enabled !== undefined) fields.sponsor_enabled = sponsor_enabled === 'true' || sponsor_enabled === true;
        if (sponsor_digit !== undefined && /^[0-9]$/.test(String(sponsor_digit))) fields.sponsor_digit = String(sponsor_digit);
        if (sponsor_full_amount_cents !== undefined) fields.sponsor_full_amount_cents = parseInt(sponsor_full_amount_cents, 10) || 50000;
        if (sponsor_partial_amount_cents !== undefined) fields.sponsor_partial_amount_cents = parseInt(sponsor_partial_amount_cents, 10) || 18000;
        if (sponsor_partial_max_per_day !== undefined) fields.sponsor_partial_max_per_day = parseInt(sponsor_partial_max_per_day, 10) || 3;
        Object.assign(fields, f);
        const keys = Object.keys(fields);
        if (keys.length) {
            const sets = keys.map((k, i) => k + ' = $' + (i + 1)).join(', ');
            const vals = keys.map(k => fields[k]);
            await pool.query('UPDATE nishmas_settings SET ' + sets + ' WHERE id = (SELECT id FROM nishmas_settings LIMIT 1)', vals);
        }
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/settings/audio/:field', async (req, res) => {
    const allowed = ['greeting_audio_file','press1_audio_file','press2_audio_file','press3_audio_file',
                     'nishmas_audio_file','nishmas_ashkenaz_file','nishmas_mizrach_file','nishmas_nusach_prompt_file',
                     'all_messages_intro_file','return_menu_audio_file','closing_audio_file',
                     'donate_intro_audio_file','donate_card_prompt_file','donate_expiry_prompt_file','donate_cvv_prompt_file',
                     'donate_kvittel_prompt_file','donate_thank_you_file','donate_decline_file','donate_kvittel_thank_file',
                     'sponsor_intro_audio_file','sponsor_pick_day_prompt_file','sponsor_day_taken_audio_file',
                     'sponsor_shabbos_audio_file','sponsor_past_day_audio_file','sponsor_anonymous_prompt_file',
                     'sponsor_record_name_prompt_file','sponsor_thank_you_file','sponsor_decline_file'];
    const field = req.params.field;
    if (!allowed.includes(field)) return res.status(400).json({ error: 'Invalid field' });
    try { await pool.query('UPDATE nishmas_settings SET ' + field + ' = NULL WHERE id = (SELECT id FROM nishmas_settings LIMIT 1)'); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// === Call log API — for the Bgold Platform Callers page ===
// Default window: last 30 days

// Chronological log — one row per call
app.get('/api/call-logs', async (req, res) => {
    try {
        const days = parseInt(req.query.days || '30', 10);
        const limit = Math.min(parseInt(req.query.limit || '2000', 10), 5000);
        const r = await pool.query(
            `SELECT id, call_sid, phone_number, program_day, created_at
             FROM nishmas_call_logs
             WHERE created_at > NOW() - ($1 || ' days')::interval
             ORDER BY created_at DESC
             LIMIT $2`,
            [String(days), limit]
        );
        res.json({ calls: r.rows, total: r.rowCount, window_days: days });
    } catch (e) {
        console.error('call-logs error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Grouped by caller — one row per phone number
app.get('/api/call-logs/by-caller', async (req, res) => {
    try {
        const days = parseInt(req.query.days || '30', 10);
        const r = await pool.query(
            `SELECT
                phone_number,
                COUNT(*)::int AS call_count,
                MIN(created_at) AS first_call,
                MAX(created_at) AS last_call,
                ARRAY_AGG(DISTINCT program_day ORDER BY program_day) FILTER (WHERE program_day IS NOT NULL) AS days_heard
             FROM nishmas_call_logs
             WHERE created_at > NOW() - ($1 || ' days')::interval
               AND phone_number IS NOT NULL
             GROUP BY phone_number
             ORDER BY MAX(created_at) DESC`,
            [String(days)]
        );
        res.json({ callers: r.rows, window_days: days });
    } catch (e) {
        console.error('by-caller error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Summary counts
app.get('/api/call-logs/summary', async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT
                (SELECT COUNT(*)::int FROM nishmas_call_logs WHERE created_at > NOW() - INTERVAL '30 days') AS calls_30d,
                (SELECT COUNT(*)::int FROM nishmas_call_logs WHERE created_at > NOW() - INTERVAL '7 days')  AS calls_7d,
                (SELECT COUNT(*)::int FROM nishmas_call_logs WHERE created_at > NOW() - INTERVAL '1 day')   AS calls_today,
                (SELECT COUNT(DISTINCT phone_number)::int FROM nishmas_call_logs WHERE created_at > NOW() - INTERVAL '30 days' AND phone_number IS NOT NULL) AS unique_callers_30d
        `);
        res.json(r.rows[0] || {});
    } catch (e) {
        console.error('summary error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/admin', (req, res) => { res.send(ADMIN_HTML); });

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>40 Days of Nishmas - Audio Admin</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
/* ── Bgold-matching design tokens ───────────────────────────────────── */
:root {
  --bg: #F9FAFB;
  --bg2: #FFFFFF;
  --bg3: #F3F4F6;
  --border: #E5E7EB;
  --border2: #D1D5DB;
  --text: #111827;
  --text2: #4B5563;
  --text3: #9CA3AF;
  --accent: #3B82F6;
  --accent-hover: #2563EB;
  --accent-dim: rgba(59, 130, 246, 0.10);
  --success: #10B981;
  --warning: #F59E0B;
  --danger: #EF4444;
  --radius: 12px;
  --radius-sm: 8px;
  --shadow: 0 4px 12px rgba(0,0,0,0.06);
  --text-light: var(--text2);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); min-height: 100vh; color: var(--text); line-height: 1.6; -webkit-font-smoothing: antialiased; }
.container { max-width: 1200px; margin: 0 auto; padding: 20px; }
.header { background: var(--bg2); padding: 2rem; border-radius: var(--radius); margin-bottom: 2rem; text-align: center; border: 1px solid var(--border); box-shadow: var(--shadow); }
.header h1 { font-size: 2.2rem; margin-bottom: 0.4rem; color: var(--accent); font-weight: 700; letter-spacing: -0.02em; }
.header p { color: var(--text2); font-size: 0.95rem; }
.status-bar { background: var(--bg2); padding: 1.1rem 1.4rem; border-radius: var(--radius); margin-bottom: 2rem; text-align: center; border: 1px solid var(--border); border-left: 4px solid var(--accent); color: var(--text2); font-size: 0.95rem; }
.status-text strong { color: var(--accent); font-weight: 700; }
.nav-tabs { display: flex; background: var(--bg2); border-radius: var(--radius); padding: 6px; margin-bottom: 2rem; gap: 4px; border: 1px solid var(--border); box-shadow: var(--shadow); }
.nav-tab { flex: 1; padding: .85rem 1.5rem; background: transparent; border: none; border-radius: var(--radius-sm); cursor: pointer; font-size: .9rem; color: var(--text2); font-weight: 600; font-family: inherit; transition: .2s ease; }
.nav-tab:hover { background: var(--bg3); color: var(--text); }
.nav-tab.active { background: var(--accent); color: #fff; }
.tab-content { display: none; }
.tab-content.active { display: block; }
.card { background: var(--bg2); border-radius: var(--radius); padding: 2rem; margin-bottom: 2rem; border: 1px solid var(--border); box-shadow: var(--shadow); }
.card h2 { color: var(--text); margin-bottom: 1.5rem; font-size: 1.3rem; font-weight: 700; letter-spacing: -0.01em; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 1.5rem; }
.form-group { margin-bottom: 1.5rem; }
.form-group label { display: block; margin-bottom: 0.5rem; color: var(--text2); font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
.form-group input, .form-group textarea { width: 100%; padding: 0.7rem 0.9rem; border: 1px solid var(--border2); border-radius: var(--radius-sm); font-size: .95rem; background: var(--bg2); color: var(--text); font-family: inherit; transition: .2s ease; }
.form-group input:focus, .form-group textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
.upload-area { border: 2px dashed var(--border2); border-radius: var(--radius-sm); padding: 1.25rem; text-align: center; cursor: pointer; background: var(--bg); transition: .2s ease; }
.upload-area:hover { border-color: var(--accent); background: var(--accent-dim); }
.upload-area.has-file { border-color: var(--success); border-style: solid; background: rgba(16, 185, 129, 0.05); }
.upload-icon { font-size: 1.6rem; margin-bottom: 0.3rem; color: var(--text3); }
.upload-text { font-weight: 600; color: var(--text); font-size: .9rem; }
.upload-subtext { font-size: .78rem; color: var(--text2); margin-top: .25rem; }
.speaker-audio-section, .menu-audio-section { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 1.25rem; margin-bottom: 1rem; }
.section-title { font-size: .82rem; color: var(--accent); font-weight: 700; margin-bottom: 1rem; display: block; text-transform: uppercase; letter-spacing: .08em; }
.btn { padding: .65rem 1.4rem; border: none; border-radius: var(--radius-sm); cursor: pointer; font-size: .9rem; font-weight: 600; font-family: inherit; display: inline-flex; align-items: center; gap: .4rem; transition: .2s ease; letter-spacing: .01em; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { background: var(--accent-hover); }
.btn-success { background: var(--success); color: #fff; }
.btn-success:hover { filter: brightness(0.95); }
.btn-danger { background: rgba(239, 68, 68, .08); color: var(--danger); border: 1px solid rgba(239, 68, 68, .25); }
.btn-danger:hover { background: rgba(239, 68, 68, .15); }
.btn-full { width: 100%; justify-content: center; }
.record-row { display: flex; gap: .5rem; align-items: center; justify-content: center; margin-top: .75rem; flex-wrap: wrap; }
.record-btn { background: rgba(239, 68, 68, .08); color: var(--danger); border: 1px solid rgba(239, 68, 68, .25); padding: .6rem 1.3rem; border-radius: var(--radius-sm); cursor: pointer; font-weight: 600; font-size: .9rem; font-family: inherit; display: inline-flex; align-items: center; gap: .4rem; transition: .2s ease; }
.record-btn:hover { background: rgba(239, 68, 68, .15); }
.record-btn.recording { background: var(--danger); color: #fff; animation: pulse 1.2s infinite; }
@keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,.5); } 50% { box-shadow: 0 0 0 10px rgba(239,68,68,0); } }
.or-divider { text-align: center; margin: .75rem 0; color: var(--text3); font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; }
.recorded-preview { margin-top: .75rem; padding: .9rem; background: rgba(16, 185, 129, 0.06); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: var(--radius-sm); display: none; }
.recorded-preview.active { display: block; }
.recorded-preview-label { color: var(--success); font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; margin-bottom: .5rem; }
.recorded-preview-row { display: flex; align-items: center; gap: .5rem; }
.recorded-preview-row audio { flex: 1; margin: 0; }
.messages-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1.5rem; }
.message-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.25rem; transition: .2s ease; box-shadow: var(--shadow); }
.message-card:hover { border-color: var(--accent); }
.day-badge { background: var(--accent); color: #fff; padding: .3rem .85rem; border-radius: 20px; font-weight: 700; font-size: .78rem; display: inline-block; letter-spacing: .02em; }
.message-title { font-weight: 600; margin: .5rem 0; color: var(--text); }
.speaker-info { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: .5rem .75rem; margin: .5rem 0; }
.speaker-name { color: var(--accent); font-weight: 600; font-size: .9rem; }
.speaker-audio-indicator { font-size: .75rem; color: var(--success); margin-top: .2rem; }
.message-date { color: var(--text2); font-size: .8rem; }
.message-actions { display: flex; gap: .5rem; margin-top: 1rem; }
.message-actions .btn { padding: .45rem 1rem; font-size: .8rem; }
.alert { padding: .85rem 1.2rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem; font-weight: 500; font-size: .9rem; }
.alert-success { background: rgba(16, 185, 129, .08); color: #047857; border: 1px solid rgba(16, 185, 129, .25); }
.alert-error { background: rgba(239, 68, 68, .08); color: #B91C1C; border: 1px solid rgba(239, 68, 68, .25); }
audio { width: 100%; margin: .5rem 0; }
.current-audio { margin-top: 1rem; padding: .85rem; background: var(--bg); border-radius: var(--radius-sm); border: 1px solid var(--border); border-left: 4px solid var(--success); }
.current-audio-row { display: flex; align-items: center; gap: .5rem; margin-top: .5rem; }
.current-audio-row audio { flex: 1; margin: 0; }
.delete-icon-btn { background: rgba(239, 68, 68, .08); color: var(--danger); border: 1px solid rgba(239, 68, 68, .25); border-radius: 6px; width: 36px; height: 36px; cursor: pointer; font-size: 1rem; flex-shrink: 0; transition: .2s ease; }
.delete-icon-btn:hover { background: rgba(239, 68, 68, .15); }
.empty-state { text-align: center; padding: 3rem; color: var(--text2); }
.empty-state-icon { font-size: 3rem; margin-bottom: 1rem; opacity: .5; }
body.embedded .header { display: none; }
body.embedded .container { padding-top: 8px; }
@media (max-width: 768px) { .form-grid { grid-template-columns: 1fr; } .nav-tabs { flex-direction: column; } .messages-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<script>
  // When loaded inside Bgold via iframe with ?embedded=1, hide the big header
  if (new URLSearchParams(location.search).has('embedded')) {
    document.body.classList.add('embedded');
  }
</script>
<div class="container">
  <div class="header">
    <h1>🕯️ 40 Days of Nishmas</h1>
    <p>Audio Control Panel</p>
  </div>

  <div class="status-bar">
    <div class="status-text" id="statusText">Loading...</div>
  </div>

  <div class="nav-tabs">
    <button class="nav-tab active" data-tab="add-message">📝 Add Message</button>
    <button class="nav-tab" data-tab="messages">📚 All Messages</button>
    <button class="nav-tab" data-tab="settings">⚙️ Menu Audio</button>
    <button class="nav-tab" data-tab="donate-campaigns">💝 Donate Campaigns</button>
  </div>

  <div class="tab-content active" id="add-message">
    <div class="card">
      <h2>Add Daily Message</h2>
      <div id="add-alert"></div>
      <form id="messageForm" enctype="multipart/form-data">
        <div class="form-grid">
          <div class="form-group">
            <label for="dayNumber">Day Number</label>
            <input type="number" id="dayNumber" min="1" max="40" required>
          </div>
          <div class="form-group">
            <label for="speakerName">Speaker Name</label>
            <input type="text" id="speakerName" placeholder="e.g., Rabbi Goldstein" required>
          </div>
        </div>
        <div class="form-group">
          <label for="messageTitle">Message Title</label>
          <input type="text" id="messageTitle" placeholder="e.g., Introduction to Nishmas" required>
        </div>
        <div class="speaker-audio-section">
          <label class="section-title">🏷️ Message Title Audio <span style="font-weight:400;font-size:.8rem;color:var(--text2)">(optional — record/upload someone saying the title)</span></label>
          <div class="upload-area" id="titleUploadArea">
            <div class="upload-icon">📁</div>
            <div class="upload-text">Upload a file</div>
            <div class="upload-subtext">MP3 / WAV / M4A</div>
            <input type="file" id="titleAudio" name="title_audio" accept="audio/*" style="display:none">
          </div>
          <div class="or-divider">— or —</div>
          <div class="record-row">
            <button type="button" class="record-btn" data-target="titleAudio" data-area="titleUploadArea" data-preview="titlePreview">
              <span class="icon">🎙️</span><span class="label">Record</span>
            </button>
          </div>
          <div class="recorded-preview" id="titlePreview">
            <div class="recorded-preview-label">✅ Recording ready — listen, then save message or discard</div>
            <div class="recorded-preview-row">
              <audio controls></audio>
              <button type="button" class="delete-icon-btn" data-discard="titleAudio" data-preview="titlePreview" data-area="titleUploadArea" title="Discard recording">🗑️</button>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label for="programDate">Program Date (for your reference)</label>
          <input type="date" id="programDate">
          <div style="margin-top:1rem;display:flex;align-items:center;gap:.75rem;background:var(--bg2,#111318);border:1px solid var(--border,#1e2230);border-radius:8px;padding:.75rem 1rem;">
            <input type="checkbox" id="allowSkip" style="width:18px;height:18px;cursor:pointer;accent-color:#d4a017;">
            <div>
              <label for="allowSkip" style="font-weight:600;cursor:pointer;color:var(--text,#e8eaf0);">Enable 30-second skip (Press 5)</label>
              <div style="font-size:.8rem;color:var(--text2,#8b93a8);margin-top:.2rem;">Callers will hear "Press 5 to skip ahead 30 seconds" before the message plays</div>
            </div>
          </div>
        </div>
        <div class="speaker-audio-section">
          <label class="section-title">🎙️ Speaker Name Audio (2-3 seconds)</label>
          <div class="upload-area" id="speakerUploadArea">
            <div class="upload-icon">📁</div>
            <div class="upload-text">Upload a file</div>
            <div class="upload-subtext">MP3 / WAV / M4A</div>
            <input type="file" id="speakerAudio" name="speaker_audio" accept="audio/*" style="display:none">
          </div>
          <div class="or-divider">— or —</div>
          <div class="record-row">
            <button type="button" class="record-btn" data-target="speakerAudio" data-area="speakerUploadArea" data-preview="speakerPreview">
              <span class="icon">🎙️</span><span class="label">Record</span>
            </button>
          </div>
          <div class="recorded-preview" id="speakerPreview">
            <div class="recorded-preview-label">✅ Recording ready — listen, then save message or discard</div>
            <div class="recorded-preview-row">
              <audio controls></audio>
              <button type="button" class="delete-icon-btn" data-discard="speakerAudio" data-preview="speakerPreview" data-area="speakerUploadArea" title="Discard recording">🗑️</button>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>Complete Message Audio</label>
          <!-- Option 1: Chunked upload (bypasses Railway timeout) -->
          <div id="cloudinaryUploadArea" style="background:var(--bg2,#111318);border:2px dashed #d4a017;border-radius:8px;padding:1.25rem;text-align:center;cursor:pointer;margin-bottom:.75rem;" onclick="document.getElementById('cloudinaryFileInput').click()">
            <div style="font-size:1.5rem;margin-bottom:.3rem;">🎵</div>
            <div style="font-weight:600;color:#d4a017;font-size:.95rem;">Upload Any Size Audio</div>
            <div style="font-size:.78rem;color:var(--text2,#8b93a8);margin-top:.2rem;">Uploads in chunks — works for large files without timeout</div>
            <input type="file" id="cloudinaryFileInput" accept="audio/*" style="display:none" onchange="uploadToCloudinary(this.files[0])">
          </div>
          <div id="cloudinaryProgress" style="display:none;margin-bottom:.75rem;">
            <div style="background:var(--bg3,#0d1017);border-radius:100px;height:8px;overflow:hidden;margin-bottom:.4rem;">
              <div id="cloudinaryProgressBar" style="height:100%;background:#d4a017;width:0%;transition:.3s;border-radius:100px;"></div>
            </div>
            <div id="cloudinaryProgressText" style="font-size:.8rem;color:var(--text2,#8b93a8);text-align:center;">Uploading...</div>
          </div>
          <div id="cloudinaryResult" style="display:none;margin-bottom:.75rem;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:.75rem;">
            <div style="color:#34D399;font-size:.85rem;font-weight:600;margin-bottom:.4rem;">✓ Uploaded to Cloudinary!</div>
            <audio id="cloudinaryAudioPreview" controls style="width:100%;margin-bottom:.4rem;"></audio>
          </div>
          <!-- Option 2: Paste URL -->
          <div class="or-divider">— or paste a URL (Dropbox, etc.) —</div>
          <input type="url" id="audioUrlInput" placeholder="https://www.dropbox.com/s/xxx/file.mp3?dl=1"
            style="width:100%;padding:.6rem .9rem;background:var(--bg2,#111318);border:1px solid var(--border,#1e2230);border-radius:8px;color:var(--text,#e8eaf0);font-size:.9rem;margin-bottom:.5rem;box-sizing:border-box;"
            oninput="let v=this.value.trim();if(v.includes('dropbox.com')){v=v.replace('dl=0','dl=1');if(!v.includes('dl='))v+=(v.includes('?')?'&':'?')+'dl=1';this.value=v;}document.getElementById('audioUrlPreview').style.display=v?'block':'none';document.getElementById('audioUrlPreviewSrc').src=v;">
          <div id="audioUrlPreview" style="display:none;margin-bottom:.5rem;">
            <audio id="audioUrlPreviewSrc" controls style="width:100%;"></audio>
          </div>
          <!-- Option 3: Small file upload via server -->
          <div class="or-divider">— or upload small file (under 10MB) —</div>
          <div class="upload-area" id="audioFileArea">
            <div class="upload-icon">🎵</div>
            <div class="upload-text">Upload small audio file</div>
            <div class="upload-subtext">MP3/WAV under 10MB</div>
            <input type="file" id="audioFile" accept="audio/*" style="display:none">
          </div>
          <!-- Option 4: Record -->
          <div class="or-divider">— or record —</div>
          <div class="record-row">
            <button type="button" class="record-btn" data-target="audioFile" data-area="audioFileArea" data-preview="audioFilePreview">
              <span class="icon">🎙️</span><span class="label">Record</span>
            </button>
          </div>
          <div class="recorded-preview" id="audioFilePreview">
            <div class="recorded-preview-label">✅ Recording ready — listen, then save or discard</div>
            <div class="recorded-preview-row">
              <audio controls></audio>
              <button type="button" class="delete-icon-btn" data-discard="audioFile" data-preview="audioFilePreview" data-area="audioFileArea">🗑️</button>
            </div>
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-full">💾 Save Message</button>
      </form>
    </div>
  </div>

  <div class="tab-content" id="messages">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;margin-bottom:1rem;">
        <h2 style="margin:0;">All Messages</h2>
        <div id="messagesStatusSummary" style="font-size:.9rem;color:var(--text-light);"></div>
      </div>
      <div id="messagesAlert"></div>
      <div class="messages-grid" id="messagesContainer">
        <div class="empty-state"><div class="empty-state-icon">⏳</div><p>Loading...</p></div>
      </div>
    </div>
  </div>

  <div class="tab-content" id="settings">
    <div class="card">
      <h2>Menu Audio Settings</h2>
      <div id="settings-alert"></div>
      <form id="settingsForm" enctype="multipart/form-data">
        <div class="form-group">
          <label for="startDate">Program Start Date</label>
          <input type="date" id="startDate" required>
        </div>

        <div class="menu-audio-section">
          <label class="section-title">🎤 Complete Welcome Message</label>
          <div class="upload-area" id="greetingAudioArea">
            <div class="upload-icon">📞</div>
            <div class="upload-text">Upload complete welcome greeting</div>
            <input type="file" id="greetingAudio" name="greeting_audio" accept="audio/*" style="display:none">
          </div>
          <div class="or-divider">— or —</div>
          <div class="record-row">
            <button type="button" class="record-btn" data-target="greetingAudio" data-area="greetingAudioArea" data-preview="greetingPreview">
              <span class="icon">🎙️</span><span class="label">Record</span>
            </button>
          </div>
          <div class="recorded-preview" id="greetingPreview">
            <div class="recorded-preview-label">✅ Recording ready — listen, then save or discard</div>
            <div class="recorded-preview-row">
              <audio controls></audio>
              <button type="button" class="delete-icon-btn" data-discard="greetingAudio" data-preview="greetingPreview" data-area="greetingAudioArea">🗑️</button>
            </div>
          </div>
          <div id="current-greeting"></div>
        </div>

        <div class="menu-audio-section">
          <label class="section-title">🔢 Menu Components (short - record or upload)</label>

          <div class="form-group">
            <label>Press 1 Audio</label>
            <div class="upload-area" id="press1AudioArea">
              <div class="upload-icon">1️⃣</div>
              <div class="upload-text">Upload "Press 1 for today's message"</div>
              <input type="file" id="press1Audio" name="press1_audio" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row">
              <button type="button" class="record-btn" data-target="press1Audio" data-area="press1AudioArea" data-preview="press1Preview">
                <span class="icon">🎙️</span><span class="label">Record</span>
              </button>
            </div>
            <div class="recorded-preview" id="press1Preview">
              <div class="recorded-preview-label">✅ Recording ready</div>
              <div class="recorded-preview-row">
                <audio controls></audio>
                <button type="button" class="delete-icon-btn" data-discard="press1Audio" data-preview="press1Preview" data-area="press1AudioArea">🗑️</button>
              </div>
            </div>
            <div id="current-press1"></div>
          </div>

          <div class="form-group">
            <label>Press 2 Audio</label>
            <div class="upload-area" id="press2AudioArea">
              <div class="upload-icon">2️⃣</div>
              <div class="upload-text">Upload "Press 2 for all previous"</div>
              <input type="file" id="press2Audio" name="press2_audio" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row">
              <button type="button" class="record-btn" data-target="press2Audio" data-area="press2AudioArea" data-preview="press2Preview">
                <span class="icon">🎙️</span><span class="label">Record</span>
              </button>
            </div>
            <div class="recorded-preview" id="press2Preview">
              <div class="recorded-preview-label">✅ Recording ready</div>
              <div class="recorded-preview-row">
                <audio controls></audio>
                <button type="button" class="delete-icon-btn" data-discard="press2Audio" data-preview="press2Preview" data-area="press2AudioArea">🗑️</button>
              </div>
            </div>
            <div id="current-press2"></div>
          </div>

          <div class="form-group">
            <label>Press 3 Audio</label>
            <div class="upload-area" id="press3AudioArea">
              <div class="upload-icon">3️⃣</div>
              <div class="upload-text">Upload "Press 3 for Nishmas"</div>
              <input type="file" id="press3Audio" name="press3_audio" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row">
              <button type="button" class="record-btn" data-target="press3Audio" data-area="press3AudioArea" data-preview="press3Preview">
                <span class="icon">🎙️</span><span class="label">Record</span>
              </button>
            </div>
            <div class="recorded-preview" id="press3Preview">
              <div class="recorded-preview-label">✅ Recording ready</div>
              <div class="recorded-preview-row">
                <audio controls></audio>
                <button type="button" class="delete-icon-btn" data-discard="press3Audio" data-preview="press3Preview" data-area="press3AudioArea">🗑️</button>
              </div>
            </div>
            <div id="current-press3"></div>
          </div>
        </div>

        <div class="menu-audio-section">
          <label class="section-title">🕊️ Nishmas Prayer (by Nusach)</label>
          <p style="color:var(--text-light);font-size:.82rem;margin-bottom:1rem;">When a caller presses 3 on the main menu, they'll be asked to choose a nusach.</p>

          <div class="form-group">
            <label>🇦 Ashkenaz / Sfard</label>
            <div class="upload-area" id="nishmasAshkenazArea">
              <div class="upload-icon">🙏</div>
              <div class="upload-text">Upload Ashkenaz/Sfard Nishmas</div>
              <input type="file" id="nishmasAshkenaz" name="nishmas_ashkenaz" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row">
              <button type="button" class="record-btn" data-target="nishmasAshkenaz" data-area="nishmasAshkenazArea" data-preview="nishmasAshkenazPreview">
                <span class="icon">🎙️</span><span class="label">Record</span>
              </button>
            </div>
            <div class="recorded-preview" id="nishmasAshkenazPreview">
              <div class="recorded-preview-label">✅ Recording ready</div>
              <div class="recorded-preview-row">
                <audio controls></audio>
                <button type="button" class="delete-icon-btn" data-discard="nishmasAshkenaz" data-preview="nishmasAshkenazPreview" data-area="nishmasAshkenazArea">🗑️</button>
              </div>
            </div>
            <div id="current-nishmas-ashkenaz"></div>
          </div>

          <div class="form-group">
            <label>🇲 Eidot HaMizrach</label>
            <div class="upload-area" id="nishmasMizrachArea">
              <div class="upload-icon">🙏</div>
              <div class="upload-text">Upload Eidot HaMizrach Nishmas</div>
              <input type="file" id="nishmasMizrach" name="nishmas_mizrach" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row">
              <button type="button" class="record-btn" data-target="nishmasMizrach" data-area="nishmasMizrachArea" data-preview="nishmasMizrachPreview">
                <span class="icon">🎙️</span><span class="label">Record</span>
              </button>
            </div>
            <div class="recorded-preview" id="nishmasMizrachPreview">
              <div class="recorded-preview-label">✅ Recording ready</div>
              <div class="recorded-preview-row">
                <audio controls></audio>
                <button type="button" class="delete-icon-btn" data-discard="nishmasMizrach" data-preview="nishmasMizrachPreview" data-area="nishmasMizrachArea">🗑️</button>
              </div>
            </div>
            <div id="current-nishmas-mizrach"></div>
          </div>

          <div class="form-group">
            <label>Nusach Selection Prompt (optional — otherwise uses robot voice)</label>
            <div class="upload-area" id="nishmasNusachPromptArea">
              <div class="upload-icon">🔢</div>
              <div class="upload-text">Upload "Press 1 for Ashkenaz or Sfard, Press 2 for Eidot HaMizrach"</div>
              <input type="file" id="nishmasNusachPrompt" name="nishmas_nusach_prompt" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row">
              <button type="button" class="record-btn" data-target="nishmasNusachPrompt" data-area="nishmasNusachPromptArea" data-preview="nishmasNusachPromptPreview">
                <span class="icon">🎙️</span><span class="label">Record</span>
              </button>
            </div>
            <div class="recorded-preview" id="nishmasNusachPromptPreview">
              <div class="recorded-preview-label">✅ Recording ready</div>
              <div class="recorded-preview-row">
                <audio controls></audio>
                <button type="button" class="delete-icon-btn" data-discard="nishmasNusachPrompt" data-preview="nishmasNusachPromptPreview" data-area="nishmasNusachPromptArea">🗑️</button>
              </div>
            </div>
            <div id="current-nishmas-nusach-prompt"></div>
          </div>
        </div>

        <div class="menu-audio-section">
          <label class="section-title">📋 All Messages Menu Audio</label>

          <div class="form-group">
            <label>Menu Intro Audio</label>
            <div class="upload-area" id="allMessagesIntroArea">
              <div class="upload-icon">📢</div>
              <div class="upload-text">Upload menu intro</div>
              <input type="file" id="allMessagesIntro" name="all_messages_intro" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row">
              <button type="button" class="record-btn" data-target="allMessagesIntro" data-area="allMessagesIntroArea" data-preview="allIntroPreview">
                <span class="icon">🎙️</span><span class="label">Record</span>
              </button>
            </div>
            <div class="recorded-preview" id="allIntroPreview">
              <div class="recorded-preview-label">✅ Recording ready</div>
              <div class="recorded-preview-row">
                <audio controls></audio>
                <button type="button" class="delete-icon-btn" data-discard="allMessagesIntro" data-preview="allIntroPreview" data-area="allMessagesIntroArea">🗑️</button>
              </div>
            </div>
            <div id="current-all-intro"></div>
          </div>

          <div class="form-group">
            <label>Return to Menu Audio</label>
            <div class="upload-area" id="returnMenuAudioArea">
              <div class="upload-icon">↩️</div>
              <div class="upload-text">Upload "Press 0 to return"</div>
              <input type="file" id="returnMenuAudio" name="return_menu_audio" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row">
              <button type="button" class="record-btn" data-target="returnMenuAudio" data-area="returnMenuAudioArea" data-preview="returnPreview">
                <span class="icon">🎙️</span><span class="label">Record</span>
              </button>
            </div>
            <div class="recorded-preview" id="returnPreview">
              <div class="recorded-preview-label">✅ Recording ready</div>
              <div class="recorded-preview-row">
                <audio controls></audio>
                <button type="button" class="delete-icon-btn" data-discard="returnMenuAudio" data-preview="returnPreview" data-area="returnMenuAudioArea">🗑️</button>
              </div>
            </div>
            <div id="current-return"></div>
          </div>
        </div>

        <!-- ─────── DONATIONS ─────── -->
        <h3 style="margin-top:30px;color:#0f766e;">💛 Donations (USAePay)</h3>
        <p style="color:#64748b;font-size:14px;margin:5px 0 15px;">Allow callers to donate via the IVR. Configure the digit, amount, and recorded prompts. After a successful charge, the caller is asked to record a kvittel name.</p>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin-bottom:20px;background:#f0fdfa;padding:18px;border-radius:8px;border:1px solid #99f6e4;">
          <div class="form-group" style="margin:0;">
            <label>Donation Enabled</label>
            <select name="donation_enabled" id="donationEnabled" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1;">
              <option value="true">Yes — allow donations</option>
              <option value="false">No — hide from menu</option>
            </select>
          </div>
          <div class="form-group" style="margin:0;">
            <label>Amount ($)</label>
            <input type="number" name="donation_amount_dollars" id="donationAmount" min="1" step="1" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1;" placeholder="40">
          </div>
          <div class="form-group" style="margin:0;">
            <label>Menu Digit</label>
            <input type="text" name="donation_digit" id="donationDigit" maxlength="1" pattern="[0-9]" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1;" placeholder="9">
          </div>
        </div>

        <div class="form-grid">
          <div class="form-group">
            <label>1. Donation Intro Prompt</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "Press 9 to donate $40 to sponsor today's video"</p>
            <div class="upload-area" id="donateIntroArea">
              <div class="upload-icon">💛</div>
              <div class="upload-text">Upload donation intro prompt</div>
              <input type="file" id="donateIntroAudio" name="donate_intro_audio" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="donateIntroAudio" data-area="donateIntroArea" data-preview="donateIntroPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="donateIntroPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="donateIntroAudio" data-preview="donateIntroPreview" data-area="donateIntroArea">🗑️</button></div></div>
            <div id="current-donateIntro"></div>
          </div>

          <div class="form-group">
            <label>2. Card Number Prompt</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "Please enter your credit card number, press # when done"</p>
            <div class="upload-area" id="donateCardArea">
              <div class="upload-icon">💳</div>
              <div class="upload-text">Upload card prompt</div>
              <input type="file" id="donateCardPrompt" name="donate_card_prompt" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="donateCardPrompt" data-area="donateCardArea" data-preview="donateCardPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="donateCardPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="donateCardPrompt" data-preview="donateCardPreview" data-area="donateCardArea">🗑️</button></div></div>
            <div id="current-donateCard"></div>
          </div>

          <div class="form-group">
            <label>3. Expiry Date Prompt</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "Enter expiry as 4 digits — month then year"</p>
            <div class="upload-area" id="donateExpiryArea">
              <div class="upload-icon">📅</div>
              <div class="upload-text">Upload expiry prompt</div>
              <input type="file" id="donateExpiryPrompt" name="donate_expiry_prompt" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="donateExpiryPrompt" data-area="donateExpiryArea" data-preview="donateExpiryPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="donateExpiryPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="donateExpiryPrompt" data-preview="donateExpiryPreview" data-area="donateExpiryArea">🗑️</button></div></div>
            <div id="current-donateExpiry"></div>
          </div>

          <div class="form-group">
            <label>4. CVV Prompt</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "Enter the 3 or 4 digit security code"</p>
            <div class="upload-area" id="donateCvvArea">
              <div class="upload-icon">🔒</div>
              <div class="upload-text">Upload CVV prompt</div>
              <input type="file" id="donateCvvPrompt" name="donate_cvv_prompt" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="donateCvvPrompt" data-area="donateCvvArea" data-preview="donateCvvPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="donateCvvPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="donateCvvPrompt" data-preview="donateCvvPreview" data-area="donateCvvArea">🗑️</button></div></div>
            <div id="current-donateCvv"></div>
          </div>

          <div class="form-group">
            <label>5. Thank You (after charge approved)</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "Thank you, your donation has been processed"</p>
            <div class="upload-area" id="donateThankArea">
              <div class="upload-icon">🙏</div>
              <div class="upload-text">Upload thank-you prompt</div>
              <input type="file" id="donateThankYou" name="donate_thank_you" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="donateThankYou" data-area="donateThankArea" data-preview="donateThankPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="donateThankPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="donateThankYou" data-preview="donateThankPreview" data-area="donateThankArea">🗑️</button></div></div>
            <div id="current-donateThank"></div>
          </div>

          <div class="form-group">
            <label>6. Decline Message (charge failed)</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "Sorry, your card was declined"</p>
            <div class="upload-area" id="donateDeclineArea">
              <div class="upload-icon">⚠️</div>
              <div class="upload-text">Upload decline message</div>
              <input type="file" id="donateDecline" name="donate_decline" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="donateDecline" data-area="donateDeclineArea" data-preview="donateDeclinePreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="donateDeclinePreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="donateDecline" data-preview="donateDeclinePreview" data-area="donateDeclineArea">🗑️</button></div></div>
            <div id="current-donateDecline"></div>
          </div>

          <div class="form-group">
            <label>7. Kvittel Recording Prompt</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "Please record the name for your kvittel after the beep, press # when done"</p>
            <div class="upload-area" id="donateKvittelArea">
              <div class="upload-icon">📝</div>
              <div class="upload-text">Upload kvittel prompt</div>
              <input type="file" id="donateKvittelPrompt" name="donate_kvittel_prompt" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="donateKvittelPrompt" data-area="donateKvittelArea" data-preview="donateKvittelPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="donateKvittelPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="donateKvittelPrompt" data-preview="donateKvittelPreview" data-area="donateKvittelArea">🗑️</button></div></div>
            <div id="current-donateKvittel"></div>
          </div>

          <div class="form-group">
            <label>8. Kvittel Thank You</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "Thank you, your kvittel has been recorded"</p>
            <div class="upload-area" id="donateKvittelThankArea">
              <div class="upload-icon">💛</div>
              <div class="upload-text">Upload kvittel thank-you</div>
              <input type="file" id="donateKvittelThank" name="donate_kvittel_thank" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="donateKvittelThank" data-area="donateKvittelThankArea" data-preview="donateKvittelThankPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="donateKvittelThankPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="donateKvittelThank" data-preview="donateKvittelThankPreview" data-area="donateKvittelThankArea">🗑️</button></div></div>
            <div id="current-donateKvittelThank"></div>
          </div>
        </div>

        <!-- ─────── SPONSOR A VIDEO ─────── -->
        <h3 style="margin-top:30px;color:#7c3aed;">🎬 Sponsor A Video (Press 9)</h3>
        <p style="color:#64748b;font-size:14px;margin:5px 0 15px;">Caller can sponsor a video — full ($500) or partial ($180), optionally tied to a specific day. After charge they choose anonymous or record their name.</p>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:15px;margin-bottom:20px;background:#faf5ff;padding:18px;border-radius:8px;border:1px solid #d8b4fe;">
          <div class="form-group" style="margin:0;">
            <label>Sponsor Enabled</label>
            <select name="sponsor_enabled" id="sponsorEnabled" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1;">
              <option value="true">Yes — show in menu</option>
              <option value="false">No — hide</option>
            </select>
          </div>
          <div class="form-group" style="margin:0;">
            <label>Menu Digit</label>
            <input type="text" name="sponsor_digit" id="sponsorDigit" maxlength="1" pattern="[0-9]" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1;" placeholder="9">
          </div>
          <div class="form-group" style="margin:0;">
            <label>Full Sponsor ($)</label>
            <input type="number" name="sponsor_full_amount_dollars" id="sponsorFullAmount" min="1" step="1" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1;" placeholder="500">
          </div>
          <div class="form-group" style="margin:0;">
            <label>Partial Sponsor ($)</label>
            <input type="number" name="sponsor_partial_amount_dollars" id="sponsorPartialAmount" min="1" step="1" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1;" placeholder="180">
          </div>
          <div class="form-group" style="margin:0;">
            <label>Max Partials/Day</label>
            <input type="number" name="sponsor_partial_max_per_day" id="sponsorPartialMax" min="1" max="10" step="1" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1;" placeholder="3">
          </div>
        </div>

        <div class="form-grid">
          <div class="form-group">
            <label>1. Sponsor Intro Prompt</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "To sponsor a daily video that will be a source of chizuk for tens of thousands across the globe, press 1 to fully sponsor for $500, press 2 to partially sponsor for $180"</p>
            <div class="upload-area" id="sponsorIntroArea">
              <div class="upload-icon">🎬</div>
              <div class="upload-text">Upload sponsor intro prompt</div>
              <input type="file" id="sponsorIntroAudio" name="sponsor_intro_audio" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="sponsorIntroAudio" data-area="sponsorIntroArea" data-preview="sponsorIntroPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="sponsorIntroPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="sponsorIntroAudio" data-preview="sponsorIntroPreview" data-area="sponsorIntroArea">🗑️</button></div></div>
            <div id="current-sponsorIntro"></div>
          </div>

          <div class="form-group">
            <label>2. Pick Day Prompt</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "Please select a day from 1 to 40 to sponsor, or press # for no specific day"</p>
            <div class="upload-area" id="sponsorPickDayArea">
              <div class="upload-icon">📅</div>
              <div class="upload-text">Upload pick-day prompt</div>
              <input type="file" id="sponsorPickDayPrompt" name="sponsor_pick_day_prompt" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="sponsorPickDayPrompt" data-area="sponsorPickDayArea" data-preview="sponsorPickDayPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="sponsorPickDayPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="sponsorPickDayPrompt" data-preview="sponsorPickDayPreview" data-area="sponsorPickDayArea">🗑️</button></div></div>
            <div id="current-sponsorPickDay"></div>
          </div>

          <div class="form-group">
            <label>3. Day Already Taken</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "That day is already fully sponsored. Please choose another day."</p>
            <div class="upload-area" id="sponsorDayTakenArea">
              <div class="upload-icon">🚫</div>
              <div class="upload-text">Upload day-taken message</div>
              <input type="file" id="sponsorDayTaken" name="sponsor_day_taken_audio" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="sponsorDayTaken" data-area="sponsorDayTakenArea" data-preview="sponsorDayTakenPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="sponsorDayTakenPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="sponsorDayTaken" data-preview="sponsorDayTakenPreview" data-area="sponsorDayTakenArea">🗑️</button></div></div>
            <div id="current-sponsorDayTaken"></div>
          </div>

          <div class="form-group">
            <label>4. Shabbos Day Message</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "There is no video on Shabbos. Please choose another day."</p>
            <div class="upload-area" id="sponsorShabbosArea">
              <div class="upload-icon">🕊</div>
              <div class="upload-text">Upload Shabbos message</div>
              <input type="file" id="sponsorShabbos" name="sponsor_shabbos_audio" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="sponsorShabbos" data-area="sponsorShabbosArea" data-preview="sponsorShabbosPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="sponsorShabbosPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="sponsorShabbos" data-preview="sponsorShabbosPreview" data-area="sponsorShabbosArea">🗑️</button></div></div>
            <div id="current-sponsorShabbos"></div>
          </div>

          <div class="form-group">
            <label>5. Past Day Message</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "That day has already passed. Please choose a future day."</p>
            <div class="upload-area" id="sponsorPastDayArea">
              <div class="upload-icon">⏪</div>
              <div class="upload-text">Upload past-day message</div>
              <input type="file" id="sponsorPastDay" name="sponsor_past_day_audio" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="sponsorPastDay" data-area="sponsorPastDayArea" data-preview="sponsorPastDayPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="sponsorPastDayPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="sponsorPastDay" data-preview="sponsorPastDayPreview" data-area="sponsorPastDayArea">🗑️</button></div></div>
            <div id="current-sponsorPastDay"></div>
          </div>

          <div class="form-group">
            <label>6. Anonymous/Name Prompt</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "Press 1 to sponsor anonymously, press 2 to record your name"</p>
            <div class="upload-area" id="sponsorAnonymousArea">
              <div class="upload-icon">🕶</div>
              <div class="upload-text">Upload anonymous prompt</div>
              <input type="file" id="sponsorAnonymous" name="sponsor_anonymous_prompt" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="sponsorAnonymous" data-area="sponsorAnonymousArea" data-preview="sponsorAnonymousPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="sponsorAnonymousPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="sponsorAnonymous" data-preview="sponsorAnonymousPreview" data-area="sponsorAnonymousArea">🗑️</button></div></div>
            <div id="current-sponsorAnonymous"></div>
          </div>

          <div class="form-group">
            <label>7. Record Name Prompt</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">e.g. "Please record your name for the dedication after the beep, press # when done"</p>
            <div class="upload-area" id="sponsorRecordNameArea">
              <div class="upload-icon">🎤</div>
              <div class="upload-text">Upload record-name prompt</div>
              <input type="file" id="sponsorRecordName" name="sponsor_record_name_prompt" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="sponsorRecordName" data-area="sponsorRecordNameArea" data-preview="sponsorRecordNamePreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="sponsorRecordNamePreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="sponsorRecordName" data-preview="sponsorRecordNamePreview" data-area="sponsorRecordNameArea">🗑️</button></div></div>
            <div id="current-sponsorRecordName"></div>
          </div>

          <div class="form-group">
            <label>8. Sponsor Thank You</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">Plays after card approves</p>
            <div class="upload-area" id="sponsorThankYouArea">
              <div class="upload-icon">🙏</div>
              <div class="upload-text">Upload thank you</div>
              <input type="file" id="sponsorThankYou" name="sponsor_thank_you" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="sponsorThankYou" data-area="sponsorThankYouArea" data-preview="sponsorThankYouPreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="sponsorThankYouPreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="sponsorThankYou" data-preview="sponsorThankYouPreview" data-area="sponsorThankYouArea">🗑️</button></div></div>
            <div id="current-sponsorThankYou"></div>
          </div>

          <div class="form-group">
            <label>9. Sponsor Decline</label>
            <p style="font-size:12px;color:#64748b;margin:0 0 8px;">Plays if card declines</p>
            <div class="upload-area" id="sponsorDeclineArea">
              <div class="upload-icon">❌</div>
              <div class="upload-text">Upload decline message</div>
              <input type="file" id="sponsorDecline" name="sponsor_decline" accept="audio/*" style="display:none">
            </div>
            <div class="or-divider">— or —</div>
            <div class="record-row"><button type="button" class="record-btn" data-target="sponsorDecline" data-area="sponsorDeclineArea" data-preview="sponsorDeclinePreview"><span class="icon">🎙️</span><span class="label">Record</span></button></div>
            <div class="recorded-preview" id="sponsorDeclinePreview"><div class="recorded-preview-label">✅ Recording ready</div><div class="recorded-preview-row"><audio controls></audio><button type="button" class="delete-icon-btn" data-discard="sponsorDecline" data-preview="sponsorDeclinePreview" data-area="sponsorDeclineArea">🗑️</button></div></div>
            <div id="current-sponsorDecline"></div>
          </div>
        </div>

        <button type="submit" class="btn btn-success btn-full">💾 Save All Audio Settings</button>
      </form>

      <!-- ─────── DONATIONS HISTORY ─────── -->
      <div class="section-card" id="donationsCard" style="margin-top:30px;">
        <h3 style="color:#0f766e;margin-top:0;">📊 Donations History</h3>
        <div id="donationStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:18px;">
          <!-- filled by JS -->
        </div>
        <button type="button" class="btn" onclick="loadDonations()" style="margin-bottom:10px;">🔄 Refresh</button>
        <div id="donationsList" style="max-height:500px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;"></div>
      </div>

      <!-- ─────── SPONSORSHIPS HISTORY + DAY GRID ─────── -->
      <div class="section-card" id="sponsorshipsCard" style="margin-top:30px;">
        <h3 style="color:#7c3aed;margin-top:0;">🎬 Video Sponsorships</h3>
        <div id="sponsorStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:18px;"></div>

        <h4 style="color:#1e293b;margin-bottom:8px;">Day Grid (1–40)</h4>
        <div style="font-size:12px;color:#64748b;margin-bottom:8px;">
          🟢 Available · 🟡 Partial · 🔴 Full · ⏸ Blocked · 🕊 Shabbos · ⚪ Past
        </div>
        <div id="sponsorDayGrid" style="display:grid;grid-template-columns:repeat(8,1fr);gap:6px;margin-bottom:18px;"></div>

        <button type="button" class="btn" onclick="loadSponsorships()" style="margin-bottom:10px;">🔄 Refresh</button>
        <div id="sponsorshipsList" style="max-height:500px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;"></div>
      </div>
    </div>
  </div>

  <!-- ════════════════════════════════════════════════════════════════════
       DONATE CAMPAIGNS TAB — manage multiple "press X to donate $Y to <cause>"
       ════════════════════════════════════════════════════════════════════ -->
  <div class="tab-content" id="donate-campaigns">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;flex-wrap:wrap;gap:.5rem;">
        <h2 style="margin:0;">💝 Donate Campaigns</h2>
        <button type="button" class="btn btn-primary" id="newCampaignBtn">+ New Campaign</button>
      </div>
      <div style="padding:.85rem 1rem;background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.3);border-radius:8px;margin-bottom:1.2rem;font-size:.85rem;line-height:1.55;color:#1E3A8A;">
        Each campaign is one "press X to donate $Y to &lt;cause&gt;" option on the main menu.
        The caller hears each active campaign's intro audio in sort order, then the digit they press
        routes them through the card/expiry/CVV flow with that campaign's preset amount. If
        <strong>Record kvittel</strong> is on, after approval the caller records a Hebrew name.
        All payments go to the same USAePay merchant account.
      </div>
      <div id="campaigns-alert"></div>
      <div id="campaignsList" style="display:flex;flex-direction:column;gap:.6rem;"></div>
    </div>

    <!-- ─── Edit/create modal ─── -->
    <div id="campaignModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;align-items:center;justify-content:center;padding:1rem;">
      <div style="background:var(--bg2);border-radius:var(--radius);max-width:680px;width:100%;max-height:92vh;overflow:auto;padding:1.4rem;box-shadow:var(--shadow);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <h2 style="margin:0;" id="campaignModalTitle">New Campaign</h2>
          <button type="button" class="btn btn-danger" onclick="closeCampaignModal()" style="padding:.4rem .7rem;">✕</button>
        </div>
        <form id="campaignForm">
          <input type="hidden" id="campaignId" value="">
          <div class="form-grid">
            <div class="form-group">
              <label for="campaignName">Name (internal label) *</label>
              <input type="text" id="campaignName" placeholder="e.g. Nishmas $80 + kvittel" required>
            </div>
            <div class="form-group">
              <label for="campaignDigit">Menu digit (0-9) *</label>
              <input type="text" id="campaignDigit" maxlength="1" placeholder="8" required pattern="[0-9]">
            </div>
          </div>
          <div class="form-grid">
            <div class="form-group">
              <label for="campaignAmount">Amount in dollars *</label>
              <input type="number" id="campaignAmount" min="1" step="1" placeholder="80" required>
            </div>
            <div class="form-group">
              <label for="campaignSortOrder">Sort order</label>
              <input type="number" id="campaignSortOrder" step="1" value="0">
            </div>
          </div>
          <div class="form-group">
            <label for="campaignDescription">Cause description (used only if no intro audio uploaded)</label>
            <input type="text" id="campaignDescription" placeholder="e.g. XYZ Yeshiva — used in fallback TTS only">
          </div>

          <div style="margin:1rem 0;display:flex;gap:1.5rem;flex-wrap:wrap;">
            <label style="display:flex;align-items:center;gap:.4rem;cursor:pointer;font-size:.92rem;">
              <input type="checkbox" id="campaignActive" checked> Active (shown on main menu)
            </label>
            <label style="display:flex;align-items:center;gap:.4rem;cursor:pointer;font-size:.92rem;">
              <input type="checkbox" id="campaignKvittel"> Record kvittel after approval
            </label>
          </div>

          <button type="submit" class="btn btn-success btn-full">💾 Save Campaign Details</button>
        </form>

        <!-- Audio uploads (visible only after the campaign row exists) -->
        <div id="campaignAudios" style="display:none;margin-top:1.5rem;">
          <h3 style="margin-bottom:.8rem;font-size:1.05rem;">🎙️ Audio Files</h3>
          <div style="font-size:.78rem;color:var(--text2);margin-bottom:.8rem;">
            Upload an audio file for each prompt. If a slot is empty the IVR uses robot voice (TTS) for that prompt. The intro audio is what plays on the main menu — e.g. "To donate $80 to Nishmas, press 8."
          </div>
          <div id="campaignAudioSlots" style="display:flex;flex-direction:column;gap:.6rem;"></div>
        </div>
      </div>
    </div>
  </div>

</div>

<script>
let currentMessages = [];
let currentSettings = {};
let mediaRecorder = null;
let recordedChunks = [];
let recordedObjectUrls = {}; // track object URLs to revoke

// ===== TAB SWITCHING =====
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.getAttribute('data-tab');
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(tabName).classList.add('active');
    tab.classList.add('active');
  });
});

// ===== RECORDING =====
document.querySelectorAll('.record-btn').forEach(btn => {
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (btn.classList.contains('recording')) {
      stopRecording(btn);
    } else {
      await startRecording(btn);
    }
  });
});

async function startRecording(btn) {
  const targetId = btn.getAttribute('data-target');
  const previewId = btn.getAttribute('data-preview');
  const fileInput = document.getElementById(targetId);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    recordedChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      const file = new File([blob], 'recording-' + Date.now() + '.webm', { type: 'audio/webm' });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('recording');
      btn.querySelector('.icon').textContent = '🎙️';
      btn.querySelector('.label').textContent = 'Record';

      // Show the preview player
      const preview = document.getElementById(previewId);
      if (preview) {
        const audio = preview.querySelector('audio');
        // revoke any prior URL to avoid leaks
        if (recordedObjectUrls[previewId]) URL.revokeObjectURL(recordedObjectUrls[previewId]);
        const objUrl = URL.createObjectURL(blob);
        recordedObjectUrls[previewId] = objUrl;
        audio.src = objUrl;
        preview.classList.add('active');
      }
    };

    mediaRecorder.start();
    btn.classList.add('recording');
    btn.querySelector('.icon').textContent = '⏹️';
    btn.querySelector('.label').textContent = 'Stop';
  } catch (err) {
    alert('Could not access microphone. Please allow mic access. Error: ' + err.message);
  }
}

function stopRecording(btn) {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

// ===== UPLOAD AREAS =====
document.querySelectorAll('.upload-area').forEach(area => {
  area.addEventListener('click', () => {
    const fileInput = area.querySelector('input[type=file]');
    if (fileInput) fileInput.click();
  });
});

['audioFile', 'speakerAudio', 'titleAudio', 'greetingAudio', 'press1Audio', 'press2Audio', 'press3Audio', 'nishmasAshkenaz', 'nishmasMizrach', 'nishmasNusachPrompt', 'allMessagesIntro', 'returnMenuAudio'].forEach(inputId => {
  const el = document.getElementById(inputId);
  if (el) {
    el.addEventListener('change', (e) => {
      const file = e.target.files[0];
      const areaId = inputId + 'Area';
      const area = document.getElementById(areaId) || e.target.closest('.upload-area');
      if (!area) return;
      const text = area.querySelector('.upload-text');
      if (file) {
        area.classList.add('has-file');
        text.textContent = '✓ ' + (file.name.startsWith('recording-') ? 'Recorded audio attached' : file.name);
      } else {
        area.classList.remove('has-file');
        // Reset text (reload the data-original or the original label set in HTML)
      }
    });
  }
});

// ===== LOAD DATA =====
document.addEventListener('DOMContentLoaded', () => {
  loadMessages();
  loadSettings();
});

async function loadMessages() {
  try {
    const r = await fetch('/api/messages');
    currentMessages = await r.json();
    displayMessages();
  } catch (e) { console.error(e); }
}

async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    const data = await r.json();
    currentSettings = data.settings;
    document.getElementById('statusText').innerHTML = 'Today is <strong>Day ' + data.current_program_day + '</strong> of the 40 Days of Nishmas program';
    document.getElementById('dayNumber').value = data.current_program_day;
    if (currentSettings.program_start_date) document.getElementById('startDate').value = currentSettings.program_start_date.split('T')[0];
    showCurrentAudio('greeting_audio_file', 'current-greeting', 'Current Welcome Message');
    showCurrentAudio('press1_audio_file', 'current-press1', 'Current Press 1 Audio');
    showCurrentAudio('press2_audio_file', 'current-press2', 'Current Press 2 Audio');
    showCurrentAudio('press3_audio_file', 'current-press3', 'Current Press 3 Audio');
    showCurrentAudio('nishmas_ashkenaz_file', 'current-nishmas-ashkenaz', 'Current Ashkenaz/Sfard Nishmas');
    showCurrentAudio('nishmas_mizrach_file', 'current-nishmas-mizrach', 'Current Eidot HaMizrach Nishmas');
    showCurrentAudio('nishmas_nusach_prompt_file', 'current-nishmas-nusach-prompt', 'Current Nusach Selection Prompt');
    showCurrentAudio('all_messages_intro_file', 'current-all-intro', 'Current Menu Intro');
    showCurrentAudio('return_menu_audio_file', 'current-return', 'Current Return Menu Audio');

    // Donation settings
    if (document.getElementById('donationEnabled')) {
      document.getElementById('donationEnabled').value = (currentSettings.donation_enabled === false) ? 'false' : 'true';
      document.getElementById('donationAmount').value = ((currentSettings.donation_amount_cents || 8000) / 100).toFixed(0);
      document.getElementById('donationDigit').value = currentSettings.kvittel_digit || currentSettings.donation_digit || '8';
      showCurrentAudio('donate_intro_audio_file', 'current-donateIntro', 'Current Donation Intro');
      showCurrentAudio('donate_card_prompt_file', 'current-donateCard', 'Current Card Prompt');
      showCurrentAudio('donate_expiry_prompt_file', 'current-donateExpiry', 'Current Expiry Prompt');
      showCurrentAudio('donate_cvv_prompt_file', 'current-donateCvv', 'Current CVV Prompt');
      showCurrentAudio('donate_thank_you_file', 'current-donateThank', 'Current Thank You');
      showCurrentAudio('donate_decline_file', 'current-donateDecline', 'Current Decline Message');
      showCurrentAudio('donate_kvittel_prompt_file', 'current-donateKvittel', 'Current Kvittel Prompt');
      showCurrentAudio('donate_kvittel_thank_file', 'current-donateKvittelThank', 'Current Kvittel Thank You');
    }

    // Sponsor settings
    if (document.getElementById('sponsorEnabled')) {
      document.getElementById('sponsorEnabled').value = (currentSettings.sponsor_enabled === false) ? 'false' : 'true';
      document.getElementById('sponsorDigit').value = currentSettings.sponsor_digit || '9';
      document.getElementById('sponsorFullAmount').value = ((currentSettings.sponsor_full_amount_cents || 50000) / 100).toFixed(0);
      document.getElementById('sponsorPartialAmount').value = ((currentSettings.sponsor_partial_amount_cents || 18000) / 100).toFixed(0);
      document.getElementById('sponsorPartialMax').value = currentSettings.sponsor_partial_max_per_day || 3;
      showCurrentAudio('sponsor_intro_audio_file', 'current-sponsorIntro', 'Current Sponsor Intro');
      showCurrentAudio('sponsor_pick_day_prompt_file', 'current-sponsorPickDay', 'Current Pick-Day Prompt');
      showCurrentAudio('sponsor_day_taken_audio_file', 'current-sponsorDayTaken', 'Current Day-Taken Message');
      showCurrentAudio('sponsor_shabbos_audio_file', 'current-sponsorShabbos', 'Current Shabbos Message');
      showCurrentAudio('sponsor_past_day_audio_file', 'current-sponsorPastDay', 'Current Past-Day Message');
      showCurrentAudio('sponsor_anonymous_prompt_file', 'current-sponsorAnonymous', 'Current Anonymous Prompt');
      showCurrentAudio('sponsor_record_name_prompt_file', 'current-sponsorRecordName', 'Current Record-Name Prompt');
      showCurrentAudio('sponsor_thank_you_file', 'current-sponsorThankYou', 'Current Thank You');
      showCurrentAudio('sponsor_decline_file', 'current-sponsorDecline', 'Current Decline Message');
    }
    loadDonations();
    loadSponsorships();
  } catch (e) { console.error(e); }
}

async function loadDonations() {
  try {
    const [statsR, listR] = await Promise.all([
      fetch('/api/donations/stats'),
      fetch('/api/donations')
    ]);
    const stats = await statsR.json();
    const donations = await listR.json();

    const totalDollars = ((parseInt(stats.total_cents)||0) / 100).toFixed(2);
    document.getElementById('donationStats').innerHTML =
      '<div style="background:#fff;padding:14px;border-radius:8px;border:1px solid #e2e8f0;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Total Raised</div><div style="font-size:24px;font-weight:700;color:#0f766e;margin-top:4px;">$' + totalDollars + '</div></div>' +
      '<div style="background:#fff;padding:14px;border-radius:8px;border:1px solid #e2e8f0;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Approved</div><div style="font-size:24px;font-weight:700;color:#15803d;margin-top:4px;">' + (stats.approved_count||0) + '</div></div>' +
      '<div style="background:#fff;padding:14px;border-radius:8px;border:1px solid #e2e8f0;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Today</div><div style="font-size:24px;font-weight:700;color:#1e293b;margin-top:4px;">' + (stats.approved_today||0) + '</div></div>' +
      '<div style="background:#fff;padding:14px;border-radius:8px;border:1px solid #e2e8f0;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Declined</div><div style="font-size:24px;font-weight:700;color:#dc2626;margin-top:4px;">' + (stats.declined_count||0) + '</div></div>' +
      '<div style="background:#fff;padding:14px;border-radius:8px;border:1px solid #e2e8f0;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Kvittels Recorded</div><div style="font-size:24px;font-weight:700;color:#7c3aed;margin-top:4px;">' + (stats.kvittels_recorded||0) + '</div></div>';

    if (!donations.length) {
      document.getElementById('donationsList').innerHTML = '<div style="padding:30px;text-align:center;color:#64748b;">No donations yet.</div>';
      return;
    }
    document.getElementById('donationsList').innerHTML = donations.map(d => {
      const dollars = (d.amount_cents/100).toFixed(2);
      const isApproved = d.status === 'approved';
      const statusBadge = isApproved
        ? '<span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">✓ APPROVED</span>'
        : '<span style="background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">✗ DECLINED</span>';
      const kvittelHtml = d.kvittel_recording_url
        ? '<audio controls preload="none" style="height:30px;width:100%;max-width:280px;"><source src="' + d.kvittel_recording_url + '.mp3"></audio>'
        : '<span style="font-size:12px;color:#94a3b8;">No kvittel recording</span>';
      return '<div style="padding:12px 14px;border-bottom:1px solid #e2e8f0;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">' +
          '<div style="flex:1;min-width:180px;">' +
            '<div style="font-weight:600;color:#1e293b;font-size:15px;">$' + dollars + ' &nbsp;' + statusBadge + '</div>' +
            '<div style="font-size:12px;color:#64748b;margin-top:3px;">' +
              new Date(d.created_at).toLocaleString() +
              (d.caller_phone ? ' · ' + d.caller_phone : '') +
              (d.card_last4 ? ' · ****' + d.card_last4 : '') +
              (d.transaction_id ? ' · TX: ' + d.transaction_id : '') +
            '</div>' +
            (d.decline_reason ? '<div style="font-size:12px;color:#dc2626;margin-top:3px;">⚠️ ' + d.decline_reason + '</div>' : '') +
          '</div>' +
          '<div style="flex:1;min-width:200px;">' + kvittelHtml + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) { console.error('loadDonations:', e); }
}

async function loadSponsorships() {
  try {
    const [statsR, listR, gridR] = await Promise.all([
      fetch('/api/sponsorships/stats'),
      fetch('/api/sponsorships'),
      fetch('/api/sponsorships/by-day')
    ]);
    const stats = await statsR.json();
    const sps = await listR.json();
    const grid = await gridR.json();

    const totalDollars = ((parseInt(stats.total_cents)||0) / 100).toFixed(2);
    document.getElementById('sponsorStats').innerHTML =
      '<div style="background:#fff;padding:14px;border-radius:8px;border:1px solid #e2e8f0;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Total Raised</div><div style="font-size:24px;font-weight:700;color:#7c3aed;margin-top:4px;">$' + totalDollars + '</div></div>' +
      '<div style="background:#fff;padding:14px;border-radius:8px;border:1px solid #e2e8f0;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Full ($500)</div><div style="font-size:24px;font-weight:700;color:#15803d;margin-top:4px;">' + (stats.full_count||0) + '</div></div>' +
      '<div style="background:#fff;padding:14px;border-radius:8px;border:1px solid #e2e8f0;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Partial ($180)</div><div style="font-size:24px;font-weight:700;color:#0891b2;margin-top:4px;">' + (stats.partial_count||0) + '</div></div>' +
      '<div style="background:#fff;padding:14px;border-radius:8px;border:1px solid #e2e8f0;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Days Sponsored</div><div style="font-size:24px;font-weight:700;color:#1e293b;margin-top:4px;">' + (stats.days_sponsored||0) + '/40</div></div>' +
      '<div style="background:#fff;padding:14px;border-radius:8px;border:1px solid #e2e8f0;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Declined</div><div style="font-size:24px;font-weight:700;color:#dc2626;margin-top:4px;">' + (stats.declined_count||0) + '</div></div>';

    // Day grid
    document.getElementById('sponsorDayGrid').innerHTML = (grid.days||[]).map(d => {
      let icon = '🟢', bg = '#dcfce7', label = 'Available';
      if (d.past) { icon = '⚪'; bg = '#f1f5f9'; label = 'Past'; }
      else if (d.skip) { icon = '🕊'; bg = '#fef3c7'; label = 'Shabbos'; }
      else if (d.blocked) { icon = '⏸'; bg = '#e2e8f0'; label = d.blocked_reason || 'Blocked'; }
      else if (d.full) { icon = '🔴'; bg = '#fee2e2'; label = 'Full ($500)'; }
      else if (d.partials >= 3) { icon = '🔴'; bg = '#fee2e2'; label = '3 partials'; }
      else if (d.partials > 0) { icon = '🟡'; bg = '#fef9c3'; label = d.partials + '/3 partial'; }
      const canBlock = !d.past && !d.skip && !d.full;
      const blockBtn = d.blocked
        ? '<button type="button" onclick="unblockDay(' + d.day + ')" style="font-size:9px;padding:2px 4px;background:#7c3aed;color:white;border:none;border-radius:3px;cursor:pointer;margin-top:2px;">Unblock</button>'
        : (canBlock ? '<button type="button" onclick="blockDay(' + d.day + ')" style="font-size:9px;padding:2px 4px;background:#1e293b;color:white;border:none;border-radius:3px;cursor:pointer;margin-top:2px;">Block</button>' : '');
      return '<div style="background:' + bg + ';padding:8px 4px;border-radius:6px;text-align:center;border:1px solid #e2e8f0;">' +
        '<div style="font-size:14px;">' + icon + '</div>' +
        '<div style="font-size:13px;font-weight:700;color:#1e293b;">Day ' + d.day + '</div>' +
        '<div style="font-size:9px;color:#64748b;margin-top:2px;">' + label + '</div>' +
        blockBtn +
      '</div>';
    }).join('');

    // Sponsorships list
    if (!sps.length) {
      document.getElementById('sponsorshipsList').innerHTML = '<div style="padding:30px;text-align:center;color:#64748b;">No sponsorships yet.</div>';
      return;
    }
    document.getElementById('sponsorshipsList').innerHTML = sps.map(sp => {
      const dollars = (sp.amount_cents/100).toFixed(2);
      const isApproved = sp.status === 'approved';
      const badge = isApproved
        ? '<span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">✓ ' + sp.sponsor_type.toUpperCase() + '</span>'
        : '<span style="background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">✗ ' + (sp.status||'').toUpperCase() + '</span>';
      const dayLabel = sp.day_number ? 'Day ' + sp.day_number : 'No specific day';
      const anonLabel = sp.anonymous ? '🕶 Anonymous' : '';
      const nameAudio = sp.kvittel_recording_url
        ? '<audio controls preload="none" style="height:30px;width:100%;max-width:280px;"><source src="' + sp.kvittel_recording_url + '.mp3"></audio>'
        : (sp.anonymous ? '<span style="font-size:12px;color:#94a3b8;">Anonymous</span>' : '<span style="font-size:12px;color:#94a3b8;">No recording</span>');
      return '<div style="padding:12px 14px;border-bottom:1px solid #e2e8f0;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">' +
          '<div style="flex:1;min-width:180px;">' +
            '<div style="font-weight:600;color:#1e293b;font-size:15px;">$' + dollars + ' &nbsp;' + badge + '</div>' +
            '<div style="font-size:12px;color:#64748b;margin-top:3px;">' +
              dayLabel + ' · ' + new Date(sp.created_at).toLocaleString() +
              (sp.caller_phone ? ' · ' + sp.caller_phone : '') +
              (sp.card_last4 ? ' · ****' + sp.card_last4 : '') +
              (sp.transaction_id ? ' · TX: ' + sp.transaction_id : '') +
              (anonLabel ? ' · ' + anonLabel : '') +
            '</div>' +
            (sp.decline_reason ? '<div style="font-size:12px;color:#dc2626;margin-top:3px;">⚠️ ' + sp.decline_reason + '</div>' : '') +
          '</div>' +
          '<div style="flex:1;min-width:200px;">' + nameAudio + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) { console.error('loadSponsorships:', e); }
}

async function blockDay(day) {
  const reason = prompt('Reason for blocking day ' + day + '? (optional)') || '';
  try {
    await fetch('/api/sponsorships/block-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day_number: day, reason })
    });
    loadSponsorships();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function unblockDay(day) {
  if (!confirm('Unblock day ' + day + '?')) return;
  try {
    await fetch('/api/sponsorships/block-day/' + day, { method: 'DELETE' });
    loadSponsorships();
  } catch (e) { alert('Failed: ' + e.message); }
}

function showCurrentAudio(key, containerId, label) {
  const container = document.getElementById(containerId);
  if (currentSettings[key]) {
    container.innerHTML =
      '<div class="current-audio">' +
        '<strong style="color:var(--text-light);font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;">' + label + '</strong>' +
        '<div class="current-audio-row">' +
          '<audio controls><source src="/audio/' + currentSettings[key] + '"></audio>' +
          '<button type="button" class="delete-icon-btn" data-field="' + key + '" data-action="delete-settings-audio">🗑️</button>' +
        '</div>' +
      '</div>';
  } else {
    container.innerHTML = '';
  }
}

function formatProgramDate(dateStr) {
  if (!dateStr) return '';
  // Parse YYYY-MM-DD as local date (not UTC, to avoid off-by-one day shifts)
  const iso = String(dateStr).split('T')[0].slice(0,10);
  const parts = iso.split('-');
  if (parts.length !== 3) return iso;
  const d = new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function displayMessages() {
  const container = document.getElementById('messagesContainer');
  const summary = document.getElementById('messagesStatusSummary');

  // Summary counts
  const total = currentMessages.length;
  const withAudio = currentMessages.filter(m => m.recorded_audio).length;
  const withNameAudio = currentMessages.filter(m => m.speaker_name_audio).length;
  const missingAudio = total - withAudio;
  if (summary) {
    if (total === 0) {
      summary.innerHTML = '';
    } else {
      summary.innerHTML =
        '<span style="color:var(--success,#10b981);font-weight:600;">✅ ' + withAudio + ' with audio</span>' +
        (missingAudio > 0 ? ' · <span style="color:var(--warning,#f59e0b);font-weight:600;">⚠️ ' + missingAudio + ' missing audio</span>' : '') +
        ' · <span style="color:var(--text-light);">' + total + ' total</span>';
    }
  }

  if (!currentMessages.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><p>No messages yet.</p></div>';
    return;
  }
  container.innerHTML = currentMessages.map(msg => {
    const ready = !!((msg.recorded_audio || msg.audio_url) && msg.speaker_name && msg.title);
    const readyBadge = ready
      ? '<div style="display:inline-block;background:rgba(16,185,129,.15);color:#10b981;padding:.2rem .55rem;border-radius:6px;font-size:.7rem;font-weight:700;margin-left:.4rem;">✅ READY</div>'
      : '<div style="display:inline-block;background:rgba(245,158,11,.15);color:#f59e0b;padding:.2rem .55rem;border-radius:6px;font-size:.7rem;font-weight:700;margin-left:.4rem;">⚠️ INCOMPLETE</div>';
    return '<div class="message-card">' +
      '<div style="display:flex;align-items:center;flex-wrap:wrap;">' +
        '<div class="day-badge">Day ' + msg.day_number + '</div>' +
        readyBadge +
      '</div>' +
      '<div class="speaker-info">' +
        '<div class="speaker-name">Speaker: ' + (msg.speaker_name || 'Not specified') + '</div>' +
        (msg.speaker_name_audio ?
          '<div class="speaker-audio-indicator">✅ Name audio recorded</div>' +
          '<div class="current-audio-row" style="margin-top:.4rem;">' +
            '<audio controls><source src="/audio/' + msg.speaker_name_audio + '"></audio>' +
            '<button type="button" class="delete-icon-btn" data-day="' + msg.day_number + '" data-action="delete-speaker-audio">🗑️</button>' +
          '</div>' :
          '<div style="color:var(--warning);font-size:.75rem;">⚠️ No name audio</div>') +
      '</div>' +
      '<div class="message-title">' + (msg.title || 'No title') + '</div>' +
      (msg.title_audio ?
        '<div class="current-audio-row" style="margin-top:.4rem;">' +
          '<span style="font-size:.75rem;color:var(--text2);margin-right:.4rem;">🏷️ Title audio:</span>' +
          '<audio controls><source src="/audio/' + msg.title_audio + '"></audio>' +
          '<button type="button" class="delete-icon-btn" data-day="' + msg.day_number + '" data-action="delete-title-audio">🗑️</button>' +
        '</div>' : '') +
      (msg.program_date ? '<div class="message-date" style="color:var(--gold,#d4a017);font-weight:600;">📅 ' + formatProgramDate(msg.program_date) + '</div>' : '') +
      (msg.allow_skip ? '<div style="display:inline-block;background:rgba(212,160,23,.15);color:#d4a017;font-size:.72rem;font-weight:700;padding:.15rem .5rem;border-radius:10px;margin:.3rem 0;">⏩ Skip enabled</div>' : '') +
      '<div class="message-date">Added: ' + new Date(msg.date_recorded).toLocaleDateString() + '</div>' +
      (msg.recorded_audio || msg.audio_url ?
        '<audio controls><source src="' + (msg.audio_url || ('/audio/' + msg.recorded_audio)) + '"></audio>' :
        '<p style="color:var(--warning);margin-top:.5rem;font-size:.8rem;">⚠️ No message audio</p>') +
      '<div class="message-actions">' +
        '<button class="btn btn-primary" data-day="' + msg.day_number + '" data-action="edit">Edit</button>' +
        '<button class="btn btn-danger" data-day="' + msg.day_number + '" data-action="delete">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

// Event delegation for dynamically rendered buttons AND discard buttons
document.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-action], [data-discard]');
  if (!target) return;

  const action = target.getAttribute('data-action');
  const discard = target.getAttribute('data-discard');

  if (discard) {
    e.preventDefault();
    // Clear the file input and hide the preview
    const fileInput = document.getElementById(discard);
    if (fileInput) fileInput.value = '';
    const previewId = target.getAttribute('data-preview');
    const areaId = target.getAttribute('data-area');
    const preview = document.getElementById(previewId);
    if (preview) {
      const audio = preview.querySelector('audio');
      if (audio) audio.src = '';
      preview.classList.remove('active');
    }
    if (recordedObjectUrls[previewId]) {
      URL.revokeObjectURL(recordedObjectUrls[previewId]);
      delete recordedObjectUrls[previewId];
    }
    const area = document.getElementById(areaId);
    if (area) area.classList.remove('has-file');
    return;
  }

  e.preventDefault();

  if (action === 'edit') {
    const day = target.getAttribute('data-day');
    const m = currentMessages.find(x => x.day_number == day);
    if (!m) return;
    document.getElementById('dayNumber').value = m.day_number;
    document.getElementById('speakerName').value = m.speaker_name || '';
    document.getElementById('messageTitle').value = m.title;
    document.getElementById('programDate').value = m.program_date ? String(m.program_date).split('T')[0].slice(0,10) : '';
    document.getElementById('allowSkip').checked = !!m.allow_skip;
    const urlInput = document.getElementById('audioUrlInput');
    if (m.audio_url) {
      urlInput.value = m.audio_url;
      document.getElementById('audioUrlPreview').style.display = 'block';
      document.getElementById('audioUrlPreviewSrc').src = m.audio_url;
    } else {
      urlInput.value = '';
      document.getElementById('audioUrlPreview').style.display = 'none';
    }
    // Show staff what audio is ALREADY saved so they don't think it was lost.
    // (File-based audio can't pre-fill a file input, so we show a status banner.)
    let banner = document.getElementById('editAudioStatus');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'editAudioStatus';
      banner.style.cssText = 'background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.4);border-radius:8px;padding:.6rem .8rem;margin:.6rem 0;font-size:.82rem;color:#10b981;';
      const form = document.getElementById('messageForm');
      form.insertBefore(banner, form.firstChild);
    }
    const have = [];
    const miss = [];
    (m.recorded_audio || m.audio_url) ? have.push('message audio') : miss.push('message audio');
    m.speaker_name_audio ? have.push('name audio') : miss.push('name audio');
    m.title_audio ? have.push('title audio') : miss.push('title audio');
    banner.innerHTML = '<strong>Editing Day ' + m.day_number + '.</strong> Already saved: ' +
      (have.length ? '✓ ' + have.join(', ✓ ') : 'none') +
      (miss.length ? ' &nbsp;|&nbsp; <span style="color:#f59e0b;">Missing: ' + miss.join(', ') + '</span>' : '') +
      '<br><span style="color:var(--text2,#8b93a8);font-size:.76rem;">Leaving an upload box empty keeps the existing audio — it will NOT be erased. Only upload to replace.</span>';
    document.querySelector('.nav-tab[data-tab="add-message"]').click();
  } else if (action === 'delete') {
    const day = target.getAttribute('data-day');
    const msg = currentMessages.find(x => x.day_number == day);
    const speaker = (msg && msg.speaker_name) || 'Unknown speaker';
    const title = (msg && msg.title) || 'No title';
    const NL = String.fromCharCode(10);
    if (!confirm('Delete Day ' + day + '?' + NL + NL + 'Speaker: ' + speaker + NL + 'Title: ' + title + NL + NL + 'This will permanently remove the message from the database. Callers will no longer hear this day. This cannot be undone.')) return;
    try {
      const r = await fetch('/api/messages/' + day, { method: 'DELETE' });
      const result = await r.json().catch(() => ({}));
      if (r.ok && result.success && result.deleted > 0) {
        showAlert('messagesAlert', '✅ Day ' + day + ' deleted and verified', 'success');
        await loadMessages();
      } else {
        showAlert('messagesAlert', '❌ Delete may not have completed. Please refresh the page to verify.', 'error');
      }
    } catch (err) {
      showAlert('messagesAlert', '❌ Error: ' + err.message, 'error');
    }
  } else if (action === 'delete-speaker-audio') {
    const day = target.getAttribute('data-day');
    if (!confirm('Delete speaker audio for Day ' + day + '?')) return;
    const r = await fetch('/api/messages/' + day + '/speaker-audio', { method: 'DELETE' });
    if (r.ok) { showAlert('add-alert', 'Speaker audio deleted', 'success'); loadMessages(); }
    else showAlert('add-alert', 'Error deleting', 'error');
  } else if (action === 'delete-title-audio') {
    const day = target.getAttribute('data-day');
    if (!confirm('Delete title audio for Day ' + day + '?')) return;
    const r = await fetch('/api/messages/' + day + '/title-audio', { method: 'DELETE' });
    if (r.ok) { showAlert('add-alert', 'Title audio deleted', 'success'); loadMessages(); }
    else showAlert('add-alert', 'Error deleting', 'error');
  } else if (action === 'delete-settings-audio') {
    const field = target.getAttribute('data-field');
    if (!confirm('Delete this audio?')) return;
    const r = await fetch('/api/settings/audio/' + field, { method: 'DELETE' });
    if (r.ok) { showAlert('settings-alert', 'Audio deleted', 'success'); loadSettings(); }
    else showAlert('settings-alert', 'Error deleting', 'error');
  }
});

function showAlert(containerId, message, type) {
  const c = document.getElementById(containerId);
  c.innerHTML = '<div class="alert alert-' + type + '">' + message + '</div>';
  setTimeout(() => { c.innerHTML = ''; }, 5000);
}

// Chunked upload — splits file into 2MB pieces to bypass Railway timeout
async function uploadToCloudinary(file) {
  if (!file) return;
  const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = Date.now() + '_' + Math.random().toString(36).slice(2);

  document.getElementById('cloudinaryProgress').style.display = 'block';
  document.getElementById('cloudinaryResult').style.display = 'none';
  document.getElementById('cloudinaryProgressBar').style.width = '0%';
  document.getElementById('cloudinaryProgressText').textContent = 'Uploading 0 of ' + totalChunks + ' parts...';

  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      const fd = new FormData();
      fd.append('chunk', chunk, file.name);
      fd.append('upload_id', uploadId);
      fd.append('chunk_index', i);
      fd.append('total_chunks', totalChunks);
      fd.append('filename', file.name);

      const resp = await fetch('/api/upload-chunk', { method: 'POST', body: fd });
      const data = await resp.json();

      const pct = Math.round(((i + 1) / totalChunks) * 100);
      document.getElementById('cloudinaryProgressBar').style.width = pct + '%';
      document.getElementById('cloudinaryProgressText').textContent = 'Uploading part ' + (i+1) + ' of ' + totalChunks + '...';

      if (data.ok && data.url) {
        // All chunks done — file assembled
        const fullUrl = window.location.origin + data.url;
        document.getElementById('audioUrlInput').value = fullUrl;
        document.getElementById('cloudinaryProgress').style.display = 'none';
        document.getElementById('cloudinaryResult').style.display = 'block';
        document.getElementById('cloudinaryAudioPreview').src = fullUrl;
        document.getElementById('cloudinaryProgressText').textContent = 'Upload complete!';
        return;
      }

      if (!resp.ok) {
        throw new Error(data.error || 'Upload failed at chunk ' + i);
      }
    }
  } catch(e) {
    document.getElementById('cloudinaryProgress').style.display = 'none';
    alert('Upload failed: ' + e.message);
  }
}

document.getElementById('messageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('day_number', document.getElementById('dayNumber').value);
  fd.append('speaker_name', document.getElementById('speakerName').value);
  fd.append('title', document.getElementById('messageTitle').value);
  fd.append('program_date', document.getElementById('programDate').value);
  fd.append('allow_skip', document.getElementById('allowSkip').checked ? 'true' : 'false');
  const pastedUrl = document.getElementById('audioUrlInput').value.trim();
  if (pastedUrl) fd.append('audio_url', pastedUrl);
  const af = document.getElementById('audioFile').files[0];
  const sf = document.getElementById('speakerAudio').files[0];
  const tf = document.getElementById('titleAudio').files[0];
  if (af) fd.append('audio', af);
  if (sf) fd.append('speaker_audio', sf);
  if (tf) fd.append('title_audio', tf);

  try {
    const r = await fetch('/api/messages', { method: 'POST', body: fd });
    if (r.ok) {
      // Re-fetch and verify the save actually persisted
      const dayNum = parseInt(document.getElementById('dayNumber').value, 10);
      const verifyRes = await fetch('/api/messages');
      const allMessages = await verifyRes.json();
      const saved = allMessages.find(m => m.day_number === dayNum);
      if (saved) {
        const savedTime = new Date().toLocaleTimeString();
        const hasMsgAudio = !!(saved.recorded_audio || saved.audio_url);
        const status = hasMsgAudio ? '✓ message audio attached' : '✗ NO message audio yet';
        const tone = hasMsgAudio ? 'success' : 'error';
        showAlert('add-alert', (hasMsgAudio ? '✅' : '⚠️') + ' Saved at ' + savedTime + ' — Day ' + dayNum + ' (' + (saved.title || 'no title') + '). ' + status + '.', tone);
      } else {
        showAlert('add-alert', '⚠️ Save appeared to succeed but could not be verified. Please check All Messages tab.', 'error');
      }
      document.getElementById('messageForm').reset();
      document.getElementById('audioUrlInput').value = '';
      const eb = document.getElementById('editAudioStatus'); if (eb) eb.remove();
      document.getElementById('audioUrlPreview').style.display = 'none';
      document.querySelectorAll('.upload-area').forEach(a => a.classList.remove('has-file'));
      document.querySelectorAll('.recorded-preview').forEach(p => p.classList.remove('active'));
      loadMessages();
    } else {
      showAlert('add-alert', '❌ Error saving — the server rejected the request', 'error');
    }
  } catch (err) { showAlert('add-alert', '❌ Error: ' + err.message, 'error'); }
});

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('program_start_date', document.getElementById('startDate').value);
  // Donation non-audio settings
  const donationEnabledEl = document.getElementById('donationEnabled');
  if (donationEnabledEl) {
    fd.append('donation_enabled', donationEnabledEl.value);
    const dollars = parseFloat(document.getElementById('donationAmount').value || '80');
    fd.append('donation_amount_cents', String(Math.round(dollars * 100)));
    const digit = (document.getElementById('donationDigit').value || '8').trim();
    if (/^[0-9]$/.test(digit)) fd.append('kvittel_digit', digit);
  }
  // Sponsor non-audio settings
  const sponsorEnabledEl = document.getElementById('sponsorEnabled');
  if (sponsorEnabledEl) {
    fd.append('sponsor_enabled', sponsorEnabledEl.value);
    const sDigit = (document.getElementById('sponsorDigit').value || '9').trim();
    if (/^[0-9]$/.test(sDigit)) fd.append('sponsor_digit', sDigit);
    const fullD = parseFloat(document.getElementById('sponsorFullAmount').value || '500');
    fd.append('sponsor_full_amount_cents', String(Math.round(fullD * 100)));
    const partD = parseFloat(document.getElementById('sponsorPartialAmount').value || '180');
    fd.append('sponsor_partial_amount_cents', String(Math.round(partD * 100)));
    const maxP = parseInt(document.getElementById('sponsorPartialMax').value || '3');
    fd.append('sponsor_partial_max_per_day', String(maxP));
  }
  [
    ['greetingAudio', 'greeting_audio'],
    ['press1Audio', 'press1_audio'],
    ['press2Audio', 'press2_audio'],
    ['press3Audio', 'press3_audio'],
    ['nishmasAshkenaz', 'nishmas_ashkenaz'],
    ['nishmasMizrach', 'nishmas_mizrach'],
    ['nishmasNusachPrompt', 'nishmas_nusach_prompt'],
    ['allMessagesIntro', 'all_messages_intro'],
    ['returnMenuAudio', 'return_menu_audio'],
    // Donation prompts
    ['donateIntroAudio', 'donate_intro_audio'],
    ['donateCardPrompt', 'donate_card_prompt'],
    ['donateExpiryPrompt', 'donate_expiry_prompt'],
    ['donateCvvPrompt', 'donate_cvv_prompt'],
    ['donateThankYou', 'donate_thank_you'],
    ['donateDecline', 'donate_decline'],
    ['donateKvittelPrompt', 'donate_kvittel_prompt'],
    ['donateKvittelThank', 'donate_kvittel_thank'],
    // Sponsor prompts
    ['sponsorIntroAudio', 'sponsor_intro_audio'],
    ['sponsorPickDayPrompt', 'sponsor_pick_day_prompt'],
    ['sponsorDayTaken', 'sponsor_day_taken_audio'],
    ['sponsorShabbos', 'sponsor_shabbos_audio'],
    ['sponsorPastDay', 'sponsor_past_day_audio'],
    ['sponsorAnonPrompt', 'sponsor_anonymous_prompt'],
    ['sponsorRecordName', 'sponsor_record_name_prompt'],
    ['sponsorThankYou', 'sponsor_thank_you'],
    ['sponsorDecline', 'sponsor_decline']
  ].forEach(([inputId, fieldName]) => {
    const el = document.getElementById(inputId);
    if (!el) return;
    const f = el.files[0];
    if (f) fd.append(fieldName, f);
  });
  try {
    const r = await fetch('/api/settings', { method: 'POST', body: fd });
    if (r.ok) {
      showAlert('settings-alert', 'Settings saved!', 'success');
      document.querySelectorAll('.recorded-preview').forEach(p => p.classList.remove('active'));
      loadSettings();
      loadSponsorships();
    }
    else showAlert('settings-alert', 'Error saving', 'error');
  } catch (err) { showAlert('settings-alert', 'Error: ' + err.message, 'error'); }
});

// ═══════════════════════════════════════════════════════════════════════════
// DONATE CAMPAIGNS — admin tab logic
// ═══════════════════════════════════════════════════════════════════════════

// All audio slots a campaign can have, in display order.
const DC_AUDIO_SLOT_LIST = [
  { slot: 'intro',          col: 'intro_audio_file',     label: '📣 Main menu intro',    hint: 'Played on the main menu, e.g. "To donate $80 to XYZ press 8."' },
  { slot: 'card_prompt',    col: 'card_prompt_file',     label: '💳 Card number prompt', hint: 'After they pressed the digit. Asks for credit card number.' },
  { slot: 'expiry_prompt',  col: 'expiry_prompt_file',   label: '📅 Expiry date prompt', hint: 'Asks for 4 digit MM/YY expiration.' },
  { slot: 'cvv_prompt',     col: 'cvv_prompt_file',      label: '🔢 CVV / security code prompt', hint: '"Please enter the three or four digit code on the back."' },
  { slot: 'thank_you',      col: 'thank_you_file',       label: '🙏 Thank you (approved)', hint: 'Played after a successful charge.' },
  { slot: 'decline',        col: 'decline_file',         label: '❌ Card declined message', hint: 'Played if the charge fails.' },
  { slot: 'kvittel_prompt', col: 'kvittel_prompt_file',  label: '📝 Kvittel record prompt (only if Record kvittel is on)', hint: '"Please say one Hebrew name after the beep."' },
  { slot: 'kvittel_thank',  col: 'kvittel_thank_file',   label: '✡️  Kvittel received thank you', hint: 'Played after the kvittel recording finishes.' },
];

let currentCampaigns = [];
let editingCampaignId = null;

async function loadCampaigns() {
  try {
    const r = await fetch('/api/donation-campaigns');
    currentCampaigns = await r.json();
    renderCampaignsList();
  } catch (e) {
    showAlert('campaigns-alert', 'Failed to load campaigns: ' + e.message, 'error');
  }
}

function renderCampaignsList() {
  const list = document.getElementById('campaignsList');
  if (!currentCampaigns.length) {
    list.innerHTML = '<div style="padding:1.4rem;text-align:center;color:var(--text2);background:var(--bg);border:1px dashed var(--border2);border-radius:8px;">No donation campaigns yet. Click <strong>+ New Campaign</strong> to create your first one.</div>';
    return;
  }
  list.innerHTML = currentCampaigns.map(c => {
    const dollars = ((c.amount_cents || 0) / 100).toFixed(0);
    const audioFilled = DC_AUDIO_SLOT_LIST.filter(s => c[s.col]).length;
    return '' +
      '<div style="background:var(--bg);border:1px solid ' + (c.active ? 'var(--accent)' : 'var(--border)') + ';border-left:4px solid ' + (c.active ? 'var(--success)' : 'var(--text3)') + ';border-radius:8px;padding:.9rem 1rem;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.6rem;flex-wrap:wrap;">' +
          '<div style="flex:1;min-width:200px;">' +
            '<div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">' +
              '<span style="font-weight:700;font-size:1.05rem;">' + esc(c.name) + '</span>' +
              '<span style="padding:.2rem .55rem;background:var(--accent);color:#fff;border-radius:4px;font-size:.72rem;font-weight:700;">Press ' + esc(c.digit) + '</span>' +
              '<span style="padding:.2rem .55rem;background:var(--success);color:#fff;border-radius:4px;font-size:.72rem;font-weight:700;">$' + dollars + '</span>' +
              (c.kvittel_enabled ? '<span style="padding:.2rem .55rem;background:#7C3AED;color:#fff;border-radius:4px;font-size:.7rem;font-weight:700;">📝 KVITTEL</span>' : '') +
              (!c.active ? '<span style="padding:.2rem .55rem;background:var(--text3);color:#fff;border-radius:4px;font-size:.7rem;font-weight:700;">INACTIVE</span>' : '') +
            '</div>' +
            (c.description ? '<div style="font-size:.78rem;color:var(--text2);margin-top:.35rem;">' + esc(c.description) + '</div>' : '') +
            '<div style="font-size:.74rem;color:var(--text2);margin-top:.3rem;">' +
              '🎙️ ' + audioFilled + ' / ' + DC_AUDIO_SLOT_LIST.length + ' audio files uploaded · sort #' + (c.sort_order || 0) +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:.3rem;">' +
            '<button type="button" class="btn" onclick="editCampaign(' + c.id + ')" style="padding:.4rem .8rem;font-size:.8rem;">✏️ Edit</button>' +
            '<button type="button" class="btn btn-danger" onclick="deleteCampaign(' + c.id + ')" style="padding:.4rem .7rem;font-size:.8rem;">🗑</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }).join('');
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function openCampaignModal(camp) {
  editingCampaignId = camp && camp.id ? camp.id : null;
  document.getElementById('campaignModalTitle').textContent = camp && camp.id ? 'Edit Campaign' : 'New Campaign';
  document.getElementById('campaignId').value          = camp && camp.id ? camp.id : '';
  document.getElementById('campaignName').value        = camp && camp.name || '';
  document.getElementById('campaignDigit').value       = camp && camp.digit || '';
  document.getElementById('campaignAmount').value      = camp ? ((camp.amount_cents || 0) / 100) : '';
  document.getElementById('campaignSortOrder').value   = camp && camp.sort_order != null ? camp.sort_order : 0;
  document.getElementById('campaignDescription').value = camp && camp.description || '';
  document.getElementById('campaignActive').checked    = camp ? camp.active !== false : true;
  document.getElementById('campaignKvittel').checked   = !!(camp && camp.kvittel_enabled);
  if (camp && camp.id) renderCampaignAudioSlots(camp);
  else document.getElementById('campaignAudios').style.display = 'none';
  document.getElementById('campaignModal').style.display = 'flex';
}

function closeCampaignModal() {
  document.getElementById('campaignModal').style.display = 'none';
  editingCampaignId = null;
}

function renderCampaignAudioSlots(camp) {
  const wrap = document.getElementById('campaignAudios');
  wrap.style.display = 'block';
  const slots = document.getElementById('campaignAudioSlots');
  slots.innerHTML = DC_AUDIO_SLOT_LIST.map(s => {
    const current = camp[s.col];
    const audioBase = '/audio/';
    return '' +
      '<div style="border:1px solid var(--border);border-radius:8px;padding:.8rem;background:var(--bg);">' +
        '<div style="font-weight:600;font-size:.92rem;">' + s.label + '</div>' +
        '<div style="font-size:.74rem;color:var(--text2);margin:.25rem 0 .6rem;">' + s.hint + '</div>' +
        (current
          ? '<div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem;">' +
              '<audio controls src="' + audioBase + esc(current) + '" style="height:32px;flex:1;min-width:200px;"></audio>' +
              '<button type="button" class="btn btn-danger" onclick="clearCampaignAudio(' + camp.id + ',\\''+ s.slot +'\\')" style="padding:.3rem .6rem;font-size:.75rem;">🗑 Remove</button>' +
            '</div>'
          : '<div style="font-size:.78rem;color:var(--text3);margin-bottom:.5rem;font-style:italic;">No file — using robot voice (TTS) for this prompt.</div>'
        ) +
        '<input type="file" accept="audio/*" data-slot="' + s.slot + '" data-camp="' + camp.id + '" class="dc-audio-upload" style="font-size:.8rem;">' +
      '</div>';
  }).join('');
  // Wire up file inputs
  slots.querySelectorAll('.dc-audio-upload').forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const slot = inp.getAttribute('data-slot');
      const id   = inp.getAttribute('data-camp');
      const fd = new FormData();
      fd.append('audio', f);
      try {
        const r = await fetch('/api/donation-campaigns/' + id + '/audio/' + slot, {
          method: 'POST', body: fd
        });
        const data = await r.json();
        if (data.error) {
          showAlert('campaigns-alert', 'Upload failed: ' + data.error, 'error');
        } else {
          showAlert('campaigns-alert', 'Audio uploaded', 'success');
          // Re-render the modal with fresh state
          await loadCampaigns();
          const fresh = currentCampaigns.find(x => x.id == id);
          if (fresh) renderCampaignAudioSlots(fresh);
        }
      } catch (err) {
        showAlert('campaigns-alert', 'Upload error: ' + err.message, 'error');
      }
    });
  });
}

async function clearCampaignAudio(id, slot) {
  if (!confirm('Remove this audio file? The IVR will fall back to robot voice for this prompt.')) return;
  try {
    const r = await fetch('/api/donation-campaigns/' + id + '/audio/' + slot, { method: 'DELETE' });
    const data = await r.json();
    if (data.error) { showAlert('campaigns-alert', data.error, 'error'); return; }
    await loadCampaigns();
    const fresh = currentCampaigns.find(x => x.id == id);
    if (fresh) renderCampaignAudioSlots(fresh);
  } catch (e) {
    showAlert('campaigns-alert', e.message, 'error');
  }
}

async function editCampaign(id) {
  const c = currentCampaigns.find(x => x.id === id);
  if (!c) return;
  openCampaignModal(c);
}

async function deleteCampaign(id) {
  const c = currentCampaigns.find(x => x.id === id);
  if (!c) return;
  if (!confirm('Delete the campaign "' + c.name + '"? This also unsets digit ' + c.digit + ' on the main menu.')) return;
  try {
    await fetch('/api/donation-campaigns/' + id, { method: 'DELETE' });
    await loadCampaigns();
    showAlert('campaigns-alert', 'Campaign deleted', 'success');
  } catch (e) {
    showAlert('campaigns-alert', e.message, 'error');
  }
}

// New-campaign button
document.getElementById('newCampaignBtn').addEventListener('click', () => openCampaignModal(null));

// Save (create or update) campaign details
document.getElementById('campaignForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id          = document.getElementById('campaignId').value;
  const name        = document.getElementById('campaignName').value.trim();
  const digit       = document.getElementById('campaignDigit').value.trim();
  const amount      = parseFloat(document.getElementById('campaignAmount').value || '0');
  const sortOrder   = parseInt(document.getElementById('campaignSortOrder').value || '0', 10);
  const description = document.getElementById('campaignDescription').value.trim();
  const active      = document.getElementById('campaignActive').checked;
  const kvittel     = document.getElementById('campaignKvittel').checked;

  if (!name || !digit || !amount || amount <= 0) {
    showAlert('campaigns-alert', 'Name, digit, and a positive amount are required.', 'error');
    return;
  }

  const body = {
    name, digit,
    amount_cents: Math.round(amount * 100),
    description: description || null,
    kvittel_enabled: kvittel,
    active,
    sort_order: sortOrder,
  };
  if (id) body.id = parseInt(id, 10);

  try {
    const r = await fetch('/api/donation-campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.error) { showAlert('campaigns-alert', data.error, 'error'); return; }
    showAlert('campaigns-alert', id ? 'Campaign updated' : 'Campaign created', 'success');
    await loadCampaigns();
    // After create, switch into edit mode so audio uploads become available
    const fresh = currentCampaigns.find(x => x.id === data.id);
    if (fresh) openCampaignModal(fresh);
  } catch (e) {
    showAlert('campaigns-alert', e.message, 'error');
  }
});

// Auto-load campaigns when the donate-campaigns tab is opened
document.querySelectorAll('.nav-tab').forEach(t => {
  t.addEventListener('click', () => {
    if (t.getAttribute('data-tab') === 'donate-campaigns') loadCampaigns();
  });
});

</script>
</body>
</html>`;

initDB().then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log('Nishmas IVR server running on port ' + PORT);
    });
});
