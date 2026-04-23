const express = require('express');
const twilio = require('twilio');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

// Point fluent-ffmpeg at the bundled ffmpeg binary (no system install needed)
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
console.log('ffmpeg path set to:', ffmpegInstaller.path);

// Convert any audio file (especially .webm browser recordings) to .mp3 for reliable Twilio playback.
// Returns the new filename (the .mp3 version). The original .webm is deleted.
function convertToMp3(inputFilename) {
    return new Promise((resolve, reject) => {
        const inputPath = path.join('uploads', inputFilename);
        const ext = path.extname(inputFilename).toLowerCase();
        // If already mp3 or wav, keep as-is - Twilio plays those fine
        if (ext === '.mp3' || ext === '.wav') return resolve(inputFilename);
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
const upload = multer({ storage });

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS nishmas_messages (
                id SERIAL PRIMARY KEY,
                day_number INTEGER UNIQUE NOT NULL,
                date_recorded DATE NOT NULL,
                title TEXT NOT NULL,
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
        
        // Auto-heal: add any missing columns to nishmas_messages (in case table was created earlier with a different schema)
        const msgCols = [
            ['title', 'TEXT'],
            ['speaker_name', 'TEXT'],
            ['speaker_name_audio', 'TEXT'],
            ['audio_url', 'TEXT'],
            ['recorded_audio', 'TEXT'],
            ['date_recorded', 'DATE'],
            ['is_active', 'BOOLEAN DEFAULT true'],
            ['created_at', 'TIMESTAMP DEFAULT NOW()']
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
            ['is_program_active', 'BOOLEAN DEFAULT true'],
            ['created_at', 'TIMESTAMP DEFAULT NOW()']
        ];
        for (const [col, type] of setCols) {
            await pool.query(`ALTER TABLE nishmas_settings ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
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

app.post('/webhook', async (req, res) => {
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
            // Press 2 — yesterday's message
            gather.say('.');
            if (yesterdaysMessage) {
                gather.say("Press 2 for yesterday's message from");
                if (yesterdaysMessage.speaker_name_audio) gather.play(audioBase + yesterdaysMessage.speaker_name_audio);
                else gather.say(yesterdaysMessage.speaker_name);
                gather.say('.');
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

        // Helper: play a message and then return to menu
        const playMessage = (m, introText) => {
            twiml.say(introText + ' from');
            if (m.speaker_name_audio) twiml.play(audioBase + m.speaker_name_audio);
            else twiml.say(m.speaker_name);
            if (m.title) twiml.say('titled ' + m.title);
            if (m.audio_url) twiml.play(m.audio_url);
            else if (m.recorded_audio) twiml.play(audioBase + m.recorded_audio);
            else twiml.say('Audio not yet available.');
            twiml.say('Press any key to return to the main menu.');
            twiml.gather({ numDigits: 1, action: '/webhook', method: 'POST' });
        };

        // Helper: list all messages (old press-2 behavior, now mapped differently)
        const listAllMessages = async () => {
            const all = await pool.query('SELECT * FROM nishmas_messages WHERE is_active = true ORDER BY day_number ASC');
            if (!all.rows.length) {
                twiml.say('No messages available.');
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
        // Regular day: 1=today, 2=yesterday, 3=all, 4=nishmas
        // Skip day:    1=yesterday, 2=all, 3=nishmas
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

app.post('/handle-message-selection', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const digits = req.body.Digits;
    try {
        if (digits === '0') { twiml.redirect('/webhook'); return res.type('text/xml').send(twiml.toString()); }
        const all = await pool.query('SELECT * FROM nishmas_messages WHERE is_active = true ORDER BY day_number ASC');
        const i = parseInt(digits) - 1;
        if (i >= 0 && i < all.rows.length) {
            const msg = all.rows[i];
            twiml.say('Day ' + msg.day_number + ' message from');
            if (msg.speaker_name_audio) twiml.play(req.protocol + '://' + req.get('host') + '/audio/' + msg.speaker_name_audio);
            else twiml.say(msg.speaker_name);
            if (msg.title) twiml.say(msg.title);
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

app.get('/api/messages', async (req, res) => {
    const messages = await pool.query('SELECT * FROM nishmas_messages ORDER BY day_number ASC');
    res.json(messages.rows);
});

app.post('/api/messages', upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'speaker_audio', maxCount: 1 }
]), async (req, res) => {
    try {
        const { day_number, title, speaker_name, audio_url } = req.body;
        let recorded_audio = null, speaker_name_audio = null;
        if (req.files?.audio) recorded_audio = await convertToMp3(req.files.audio[0].filename);
        if (req.files?.speaker_audio) speaker_name_audio = await convertToMp3(req.files.speaker_audio[0].filename);
        
        const existing = await pool.query('SELECT id FROM nishmas_messages WHERE day_number = $1', [day_number]);
        if (existing.rows.length) {
            let query = 'UPDATE nishmas_messages SET title = $2, speaker_name = $3, date_recorded = NOW()';
            const params = [day_number, title, speaker_name];
            let p = 4;
            if (speaker_name_audio) { query += ', speaker_name_audio = $' + p; params.push(speaker_name_audio); p++; }
            if (audio_url !== undefined) { query += ', audio_url = $' + p; params.push(audio_url || null); p++; }
            if (recorded_audio) { query += ', recorded_audio = $' + p; params.push(recorded_audio); p++; }
            query += ' WHERE day_number = $1';
            await pool.query(query, params);
        } else {
            await pool.query(
                'INSERT INTO nishmas_messages (day_number, title, speaker_name, speaker_name_audio, audio_url, recorded_audio, date_recorded) VALUES ($1,$2,$3,$4,$5,$6,NOW())',
                [day_number, title, speaker_name, speaker_name_audio, audio_url || null, recorded_audio]
            );
        }
        res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/messages/:day/speaker-audio', async (req, res) => {
    try { await pool.query('UPDATE nishmas_messages SET speaker_name_audio = NULL WHERE day_number = $1', [req.params.day]); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/messages/:day', async (req, res) => {
    try { await pool.query('UPDATE nishmas_messages SET is_active = false WHERE day_number = $1', [req.params.day]); res.json({ success: true }); }
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
    { name: 'closing_audio', maxCount: 1 }
]), async (req, res) => {
    try {
        const { program_start_date } = req.body;
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
        }
        const fields = {};
        if (program_start_date) fields.program_start_date = program_start_date;
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
                     'all_messages_intro_file','return_menu_audio_file','closing_audio_file'];
    const field = req.params.field;
    if (!allowed.includes(field)) return res.status(400).json({ error: 'Invalid field' });
    try { await pool.query('UPDATE nishmas_settings SET ' + field + ' = NULL WHERE id = (SELECT id FROM nishmas_settings LIMIT 1)'); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
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
          <div class="upload-area" id="audioFileArea">
            <div class="upload-icon">🎵</div>
            <div class="upload-text">Upload full daily message</div>
            <div class="upload-subtext">MP3/WAV file</div>
            <input type="file" id="audioFile" accept="audio/*" style="display:none">
          </div>
          <div class="or-divider">— or —</div>
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
      <h2>All Messages</h2>
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

        <button type="submit" class="btn btn-success btn-full">💾 Save All Audio Settings</button>
      </form>
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

['audioFile', 'speakerAudio', 'greetingAudio', 'press1Audio', 'press2Audio', 'press3Audio', 'nishmasAshkenaz', 'nishmasMizrach', 'nishmasNusachPrompt', 'allMessagesIntro', 'returnMenuAudio'].forEach(inputId => {
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
  } catch (e) { console.error(e); }
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

function displayMessages() {
  const container = document.getElementById('messagesContainer');
  if (!currentMessages.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><p>No messages yet.</p></div>';
    return;
  }
  container.innerHTML = currentMessages.map(msg =>
    '<div class="message-card">' +
      '<div class="day-badge">Day ' + msg.day_number + '</div>' +
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
      '<div class="message-title">' + msg.title + '</div>' +
      '<div class="message-date">Added: ' + new Date(msg.date_recorded).toLocaleDateString() + '</div>' +
      (msg.recorded_audio ?
        '<audio controls><source src="/audio/' + msg.recorded_audio + '"></audio>' :
        '<p style="color:var(--warning);margin-top:.5rem;font-size:.8rem;">⚠️ No message audio</p>') +
      '<div class="message-actions">' +
        '<button class="btn btn-primary" data-day="' + msg.day_number + '" data-action="edit">Edit</button>' +
        '<button class="btn btn-danger" data-day="' + msg.day_number + '" data-action="delete">Delete</button>' +
      '</div>' +
    '</div>'
  ).join('');
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
    document.querySelector('.nav-tab[data-tab="add-message"]').click();
  } else if (action === 'delete') {
    const day = target.getAttribute('data-day');
    if (!confirm('Delete this message?')) return;
    const r = await fetch('/api/messages/' + day, { method: 'DELETE' });
    if (r.ok) { showAlert('settings-alert', 'Deleted', 'success'); loadMessages(); }
    else showAlert('settings-alert', 'Error deleting', 'error');
  } else if (action === 'delete-speaker-audio') {
    const day = target.getAttribute('data-day');
    if (!confirm('Delete speaker audio for Day ' + day + '?')) return;
    const r = await fetch('/api/messages/' + day + '/speaker-audio', { method: 'DELETE' });
    if (r.ok) { showAlert('add-alert', 'Speaker audio deleted', 'success'); loadMessages(); }
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

document.getElementById('messageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('day_number', document.getElementById('dayNumber').value);
  fd.append('speaker_name', document.getElementById('speakerName').value);
  fd.append('title', document.getElementById('messageTitle').value);
  const af = document.getElementById('audioFile').files[0];
  const sf = document.getElementById('speakerAudio').files[0];
  if (af) fd.append('audio', af);
  if (sf) fd.append('speaker_audio', sf);

  try {
    const r = await fetch('/api/messages', { method: 'POST', body: fd });
    if (r.ok) {
      showAlert('add-alert', 'Message saved', 'success');
      document.getElementById('messageForm').reset();
      document.querySelectorAll('.upload-area').forEach(a => a.classList.remove('has-file'));
      document.querySelectorAll('.recorded-preview').forEach(p => p.classList.remove('active'));
      loadMessages();
    } else {
      showAlert('add-alert', 'Error saving', 'error');
    }
  } catch (err) { showAlert('add-alert', 'Error: ' + err.message, 'error'); }
});

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('program_start_date', document.getElementById('startDate').value);
  [
    ['greetingAudio', 'greeting_audio'],
    ['press1Audio', 'press1_audio'],
    ['press2Audio', 'press2_audio'],
    ['press3Audio', 'press3_audio'],
    ['nishmasAshkenaz', 'nishmas_ashkenaz'],
    ['nishmasMizrach', 'nishmas_mizrach'],
    ['nishmasNusachPrompt', 'nishmas_nusach_prompt'],
    ['allMessagesIntro', 'all_messages_intro'],
    ['returnMenuAudio', 'return_menu_audio']
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
