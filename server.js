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
const USAEPAY_HOST       = process.env.USAEPAY_HOST       || 'usaepay.com'; // production host
const DONATION_AMOUNT    = parseFloat(process.env.DONATION_AMOUNT || '80');  // $80 default

// Charge a card via USAePay v2 REST. Returns { ok, approved, transactionId, error }
async function chargeUSAePay({ amount, cardNumber, expMonth, expYear, cvv, description }) {
  return new Promise((resolve) => {
    // USAePay v2 REST API auth format (per https://help.usaepay.info/api/rest/):
    //   prehash = apikey + seed + apipin
    //   apihash = 's2/' + seed + '/' + sha256(prehash)
    //   Authorization: Basic base64(apikey + ':' + apihash)
    const crypto = require('crypto');
    const seed = crypto.randomBytes(16).toString('hex'); // random seed
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
        const approved = parsed?.result === 'Approved' ||
                         parsed?.result_code === 'A' ||
                         (parsed?.response && parsed.response.toLowerCase().includes('approved'));
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
            ['allow_skip', 'BOOLEAN DEFAULT false']
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
            // Press configurable digit — donate (second menu option, only if enabled)
            if (s?.donation_enabled !== false) {
                if (s?.donate_intro_audio_file) gather.play(audioBase + s.donate_intro_audio_file);
                else gather.say('Press ' + (s?.donation_digit || '9') + ' to make a donation.');
                gather.pause({ length: 1 });
            }
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
            // Press configurable digit — donate (second menu option, only if enabled)
            if (s?.donation_enabled !== false) {
                if (s?.donate_intro_audio_file) gather.play(audioBase + s.donate_intro_audio_file);
                else gather.say('Press ' + (s?.donation_digit || '9') + ' to make a donation.');
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
        const donationDigitNow = ms.donation_digit || '9';

        // Helper: at the end of any played message, prompt donate-or-menu
        const promptPostMessage = () => {
            if (donationOn) {
                const g = twiml.gather({ numDigits: 1, action: '/handle-post-message', method: 'POST', timeout: 8 });
                if (ms.donate_intro_audio_file) g.play(audioBase + ms.donate_intro_audio_file);
                else g.say('Press ' + donationDigitNow + ' to make a donation. Press 0 to return to the main menu.');
                twiml.redirect('/webhook');
            } else {
                twiml.say('Press any key to return to the main menu.');
                twiml.gather({ numDigits: 1, action: '/webhook', method: 'POST' });
            }
        };

        // Helper: play a message with optional skip support
        const playMessage = (m, introText, offsetSeconds) => {
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
            twiml.gather({ numDigits: 2, action: '/handle-message-selection', method: 'POST', timeout: 25 });
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
        // Regular day: 1=today, 2=yesterday, 3=all, 4=nishmas, 9=donate (configurable)
        // Skip day:    1=yesterday, 2=all, 3=nishmas, 9=donate
        const settingsForRoute = await pool.query('SELECT donation_digit, donation_enabled FROM nishmas_settings LIMIT 1');
        const donationDigit = settingsForRoute.rows[0]?.donation_digit || '9';
        const donationEnabled = settingsForRoute.rows[0]?.donation_enabled !== false;
        if (donationEnabled && digit === donationDigit) {
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

// After a message finishes: caller can press donation digit to donate, 0 (or anything else) for menu
app.post('/handle-post-message', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    try {
        const digit = req.body.Digits;
        const settings = await pool.query('SELECT donation_digit, donation_enabled FROM nishmas_settings LIMIT 1');
        const donationDigit = settings.rows[0]?.donation_digit || '9';
        const donationOn = settings.rows[0]?.donation_enabled !== false;
        if (donationOn && digit === donationDigit) {
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
            method: 'POST', timeout: 15, finishOnKey: '#'
        });
        if (s.donate_cvv_prompt_file) gather.play(audioBase + s.donate_cvv_prompt_file);
        else gather.say('Please enter the three or four digit security code on the back of your card.');
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

        // Charge USAePay
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
            twiml.say('Thank you. Goodbye.');
            twiml.hangup();
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

// Twilio sends the recorded kvittel here. Save the URL so admin can play it back.
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
        else twiml.say('Thank you. Your kvittel has been received. May Hashem grant you all the brachos. Goodbye.');
        twiml.hangup();
    } catch (e) {
        console.error('[donate/kvittel-saved]', e);
        twiml.say('Thank you. Goodbye.');
        twiml.hangup();
    }
    res.type('text/xml').send(twiml.toString());
});

// Admin: list donations (with optional filters)
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
    { name: 'title_audio', maxCount: 1 }
]), async (req, res) => {
    try {
        const { day_number, title, speaker_name, audio_url, program_date } = req.body;
        let recorded_audio = null, speaker_name_audio = null, title_audio = null;
        if (req.files?.audio) recorded_audio = await convertToMp3(req.files.audio[0].filename);
        if (req.files?.speaker_audio) speaker_name_audio = await convertToMp3(req.files.speaker_audio[0].filename);
        if (req.files?.title_audio) title_audio = await convertToMp3(req.files.title_audio[0].filename);
        
        const allow_skip = req.body.allow_skip === 'true' || req.body.allow_skip === true;
        const existing = await pool.query('SELECT id FROM nishmas_messages WHERE day_number = $1', [day_number]);
        if (existing.rows.length) {
            let query = 'UPDATE nishmas_messages SET title = $2, speaker_name = $3, date_recorded = NOW(), program_date = $4, allow_skip = $5';
            const params = [day_number, title, speaker_name, program_date || null, allow_skip];
            let p = 6;
            if (speaker_name_audio) { query += ', speaker_name_audio = $' + p; params.push(speaker_name_audio); p++; }
            if (title_audio) { query += ', title_audio = $' + p; params.push(title_audio); p++; }
            if (audio_url !== undefined) { query += ', audio_url = $' + p; params.push(audio_url || null); p++; }
            if (recorded_audio) { query += ', recorded_audio = $' + p; params.push(recorded_audio); p++; }
            query += ' WHERE day_number = $1';
            await pool.query(query, params);
        } else {
            await pool.query(
                'INSERT INTO nishmas_messages (day_number, title, title_audio, speaker_name, speaker_name_audio, audio_url, recorded_audio, program_date, allow_skip, date_recorded) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())',
                [day_number, title, title_audio, speaker_name, speaker_name_audio, audio_url || null, recorded_audio, program_date || null, allow_skip]
            );
        }
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
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
    { name: 'donate_kvittel_thank', maxCount: 1 }
]), async (req, res) => {
    try {
        const { program_start_date, donation_enabled, donation_amount_cents, donation_digit } = req.body;
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
        }
        const fields = {};
        if (program_start_date) fields.program_start_date = program_start_date;
        if (donation_enabled !== undefined) fields.donation_enabled = donation_enabled === 'true' || donation_enabled === true;
        if (donation_amount_cents !== undefined) fields.donation_amount_cents = parseInt(donation_amount_cents, 10) || 8000;
        if (donation_digit !== undefined && /^[0-9]$/.test(String(donation_digit))) fields.donation_digit = String(donation_digit);
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
                     'donate_kvittel_prompt_file','donate_thank_you_file','donate_decline_file','donate_kvittel_thank_file'];
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
<style>
:root {
  --bg: #0f1117; --bg2: #1a1d2e; --bg3: #111318;
  --accent: #d4a017; --accent-hover: #e8a820;
  --success: #10b981; --warning: #f59e0b; --danger: #ef4444;
  --border: #252a38; --text: #e8eaf0; --text-light: #8b93a8;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', sans-serif; background: var(--bg); min-height: 100vh; color: var(--text); line-height: 1.6; }
.container { max-width: 1200px; margin: 0 auto; padding: 20px; }
.header { background: linear-gradient(135deg, var(--bg2), var(--border)); padding: 2rem; border-radius: 12px; margin-bottom: 2rem; text-align: center; border: 1px solid var(--border); }
.header h1 { font-size: 2.5rem; margin-bottom: 0.5rem; color: var(--accent); }
.header p { color: var(--text-light); }
.status-bar { background: var(--bg2); padding: 1.25rem; border-radius: 12px; margin-bottom: 2rem; text-align: center; border: 1px solid var(--border); border-left: 4px solid var(--accent); }
.status-text strong { color: var(--accent); }
.nav-tabs { display: flex; background: var(--bg2); border-radius: 12px; padding: 6px; margin-bottom: 2rem; gap: 4px; border: 1px solid var(--border); }
.nav-tab { flex: 1; padding: .9rem 1.5rem; background: transparent; border: none; border-radius: 8px; cursor: pointer; font-size: .95rem; color: var(--text-light); font-weight: 500; }
.nav-tab:hover { background: var(--bg3); color: var(--text); }
.nav-tab.active { background: linear-gradient(135deg, var(--accent), var(--accent-hover)); color: #000; font-weight: 700; }
.tab-content { display: none; }
.tab-content.active { display: block; }
.card { background: var(--bg2); border-radius: 12px; padding: 2rem; margin-bottom: 2rem; border: 1px solid var(--border); }
.card h2 { color: var(--accent); margin-bottom: 1.5rem; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 1.5rem; }
.form-group { margin-bottom: 1.5rem; }
.form-group label { display: block; margin-bottom: 0.5rem; color: var(--text-light); font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; }
.form-group input, .form-group textarea { width: 100%; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; font-size: .95rem; background: var(--bg); color: var(--text); font-family: inherit; }
.form-group input:focus { outline: none; border-color: var(--accent); }
.upload-area { border: 2px dashed var(--border); border-radius: 10px; padding: 1.25rem; text-align: center; cursor: pointer; background: var(--bg); }
.upload-area:hover { border-color: var(--accent); background: var(--bg3); }
.upload-area.has-file { border-color: var(--success); border-style: solid; background: rgba(16, 185, 129, 0.05); }
.upload-icon { font-size: 1.6rem; margin-bottom: 0.3rem; color: var(--text-light); }
.upload-text { font-weight: 500; color: var(--text); font-size: .9rem; }
.upload-subtext { font-size: .78rem; color: var(--text-light); margin-top: .25rem; }
.speaker-audio-section, .menu-audio-section { background: var(--bg3); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; margin-bottom: 1rem; }
.section-title { font-size: 1rem; color: var(--accent); font-weight: 700; margin-bottom: 1rem; display: block; }
.btn { padding: .75rem 1.5rem; border: none; border-radius: 8px; cursor: pointer; font-size: .9rem; font-weight: 700; display: inline-flex; align-items: center; gap: .4rem; }
.btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent-hover)); color: #000; }
.btn-primary:hover { transform: translateY(-1px); }
.btn-success { background: var(--success); color: #000; }
.btn-danger { background: rgba(239, 68, 68, .15); color: var(--danger); border: 1px solid rgba(239, 68, 68, .3); }
.btn-full { width: 100%; justify-content: center; }
.record-row { display: flex; gap: .5rem; align-items: center; justify-content: center; margin-top: .75rem; flex-wrap: wrap; }
.record-btn { background: rgba(239, 68, 68, .1); color: var(--danger); border: 1px solid rgba(239, 68, 68, .3); padding: .7rem 1.4rem; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: .9rem; display: inline-flex; align-items: center; gap: .4rem; }
.record-btn:hover { background: rgba(239, 68, 68, .2); }
.record-btn.recording { background: var(--danger); color: #fff; animation: pulse 1.2s infinite; }
@keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,.6); } 50% { box-shadow: 0 0 0 10px rgba(239,68,68,0); } }
.or-divider { text-align: center; margin: .75rem 0; color: var(--text-light); font-size: .8rem; }
.recorded-preview { margin-top: .75rem; padding: .9rem; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 8px; display: none; }
.recorded-preview.active { display: block; }
.recorded-preview-label { color: var(--success); font-size: .78rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; margin-bottom: .5rem; }
.recorded-preview-row { display: flex; align-items: center; gap: .5rem; }
.recorded-preview-row audio { flex: 1; margin: 0; }
.messages-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1.5rem; }
.message-card { background: var(--bg3); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
.message-card:hover { border-color: var(--accent); }
.day-badge { background: linear-gradient(135deg, var(--accent), var(--accent-hover)); color: #000; padding: .35rem .9rem; border-radius: 20px; font-weight: 700; font-size: .8rem; display: inline-block; }
.message-title { font-weight: 600; margin: .5rem 0; }
.speaker-info { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: .5rem .75rem; margin: .5rem 0; }
.speaker-name { color: var(--accent); font-weight: 600; font-size: .9rem; }
.speaker-audio-indicator { font-size: .75rem; color: var(--success); margin-top: .2rem; }
.message-date { color: var(--text-light); font-size: .8rem; }
.message-actions { display: flex; gap: .5rem; margin-top: 1rem; }
.message-actions .btn { padding: .5rem 1rem; font-size: .8rem; }
.alert { padding: .9rem 1.25rem; border-radius: 8px; margin-bottom: 1.25rem; font-weight: 500; }
.alert-success { background: rgba(16, 185, 129, .1); color: var(--success); border: 1px solid rgba(16, 185, 129, .3); }
.alert-error { background: rgba(239, 68, 68, .1); color: var(--danger); border: 1px solid rgba(239, 68, 68, .3); }
audio { width: 100%; margin: .5rem 0; filter: invert(0.88) hue-rotate(180deg); }
.current-audio { margin-top: 1rem; padding: .9rem; background: var(--bg); border-radius: 8px; border: 1px solid var(--border); border-left: 4px solid var(--success); }
.current-audio-row { display: flex; align-items: center; gap: .5rem; margin-top: .5rem; }
.current-audio-row audio { flex: 1; margin: 0; }
.delete-icon-btn { background: rgba(239, 68, 68, .15); color: var(--danger); border: 1px solid rgba(239, 68, 68, .3); border-radius: 6px; width: 36px; height: 36px; cursor: pointer; font-size: 1rem; flex-shrink: 0; }
.delete-icon-btn:hover { background: rgba(239, 68, 68, .3); }
.empty-state { text-align: center; padding: 3rem; color: var(--text-light); }
.empty-state-icon { font-size: 3rem; margin-bottom: 1rem; opacity: .5; }
@media (max-width: 768px) { .form-grid { grid-template-columns: 1fr; } .nav-tabs { flex-direction: column; } .messages-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
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
      document.getElementById('donationDigit').value = currentSettings.donation_digit || '9';
      showCurrentAudio('donate_intro_audio_file', 'current-donateIntro', 'Current Donation Intro');
      showCurrentAudio('donate_card_prompt_file', 'current-donateCard', 'Current Card Prompt');
      showCurrentAudio('donate_expiry_prompt_file', 'current-donateExpiry', 'Current Expiry Prompt');
      showCurrentAudio('donate_cvv_prompt_file', 'current-donateCvv', 'Current CVV Prompt');
      showCurrentAudio('donate_thank_you_file', 'current-donateThank', 'Current Thank You');
      showCurrentAudio('donate_decline_file', 'current-donateDecline', 'Current Decline Message');
      showCurrentAudio('donate_kvittel_prompt_file', 'current-donateKvittel', 'Current Kvittel Prompt');
      showCurrentAudio('donate_kvittel_thank_file', 'current-donateKvittelThank', 'Current Kvittel Thank You');
    }
    loadDonations();
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
    const ready = !!(msg.recorded_audio && msg.speaker_name && msg.title);
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
      (msg.recorded_audio ?
        '<audio controls><source src="/audio/' + msg.recorded_audio + '"></audio>' :
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
        showAlert('add-alert', '✅ Saved and verified in database at ' + savedTime + '. Day ' + dayNum + ' — ' + (saved.title || 'no title'), 'success');
      } else {
        showAlert('add-alert', '⚠️ Save appeared to succeed but could not be verified. Please check All Messages tab.', 'error');
      }
      document.getElementById('messageForm').reset();
      document.getElementById('audioUrlInput').value = '';
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
    const dollars = parseFloat(document.getElementById('donationAmount').value || '40');
    fd.append('donation_amount_cents', String(Math.round(dollars * 100)));
    const digit = (document.getElementById('donationDigit').value || '9').trim();
    if (/^[0-9]$/.test(digit)) fd.append('donation_digit', digit);
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
    ['donateKvittelThank', 'donate_kvittel_thank']
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
    }
    else showAlert('settings-alert', 'Error saving', 'error');
  } catch (err) { showAlert('settings-alert', 'Error: ' + err.message, 'error'); }
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
