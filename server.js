const express = require('express');
const twilio = require('twilio');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Serve static files (audio uploads)
app.use('/audio', express.static('uploads'));

// Database setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// File upload setup
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + file.originalname;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage });

// Create uploads directory
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Initialize database tables
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
                closing_message TEXT,
                closing_audio_file TEXT,
                is_program_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        
        // Insert default settings if none exist
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        if (settings.rows.length === 0) {
            await pool.query(`
                INSERT INTO nishmas_settings (program_start_date, greeting_audio, closing_message)
                VALUES ($1, $2, $3)
            `, [
                new Date(), // Start today by default
                'Welcome to the 40 Days of Nishmas program. Press 1 for today\'s message, press 2 for all previous messages, or press 3 to say Nishmas.',
                'Thank you for participating in our 40 Days of Nishmas program. Have a blessed day.'
            ]);
        }
        
        console.log('Database initialized');
    } catch (error) {
        console.error('Database initialization error:', error);
    }
}

// Helper function to get current program day
async function getCurrentProgramDay() {
    try {
        const settings = await pool.query('SELECT program_start_date FROM nishmas_settings LIMIT 1');
        if (settings.rows.length === 0) return 1;
        
        const startDate = new Date(settings.rows[0].program_start_date);
        const today = new Date();
        const diffTime = today - startDate;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        return Math.max(1, diffDays + 1); // Day 1 is the start date
    } catch (error) {
        console.error('Error getting program day:', error);
        return 1;
    }
}

// Helper function to get the most recent message available
async function getMostRecentMessage() {
    try {
        const currentDay = await getCurrentProgramDay();
        
        // Try to find the current day's message, or the most recent one before it
        for (let day = currentDay; day >= 1; day--) {
            const message = await pool.query(
                'SELECT * FROM nishmas_messages WHERE day_number = $1 AND is_active = true',
                [day]
            );
            if (message.rows.length > 0) {
                return message.rows[0];
            }
        }
        return null;
    } catch (error) {
        console.error('Error getting recent message:', error);
        return null;
    }
}

// Main IVR webhook
app.post('/webhook', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    
    try {
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const settingsData = settings.rows[0];
        
        // Get today's message info for personalized greeting
        const todaysMessage = await getMostRecentMessage();
        
        if (settingsData?.greeting_audio_file) {
            // Use uploaded audio file
            const audioUrl = req.protocol + '://' + req.get('host') + '/audio/' + settingsData.greeting_audio_file;
            const gather = twiml.gather({
                numDigits: 1,
                action: '/handle-menu',
                method: 'POST',
                timeout: 10
            });
            gather.play(audioUrl);
        } else {
            // Generate personalized greeting with speaker name audio
            const gather = twiml.gather({
                numDigits: 1,
                action: '/handle-menu',
                method: 'POST',
                timeout: 10
            });
            
            gather.say('Welcome to the 40 Days of Nishmas program. Press 1 for today\'s message from');
            
            if (todaysMessage && todaysMessage.speaker_name_audio) {
                // Play recorded speaker name
                const speakerAudioUrl = req.protocol + '://' + req.get('host') + '/audio/' + todaysMessage.speaker_name_audio;
                gather.play(speakerAudioUrl);
            } else if (todaysMessage && todaysMessage.speaker_name) {
                // Fallback to text-to-speech
                gather.say(todaysMessage.speaker_name);
            }
            
            gather.say(', press 2 for all previous messages, or press 3 to say Nishmas.');
        }
        
        // If no input, repeat the menu
        twiml.say('We didn\'t receive your selection. Please try again.');
        twiml.redirect('/webhook');
        
    } catch (error) {
        console.error('Webhook error:', error);
        twiml.say('We\'re experiencing technical difficulties. Please try again later.');
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Handle menu selections
app.post('/handle-menu', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const digit = req.body.Digits;
    
    try {
        switch (digit) {
            case '1':
                // Today's message
                const todaysMessage = await getMostRecentMessage();
                if (todaysMessage) {
                    twiml.say('Here is today\'s message from');
                    
                    if (todaysMessage.speaker_name_audio) {
                        const speakerAudioUrl = req.protocol + '://' + req.get('host') + '/audio/' + todaysMessage.speaker_name_audio;
                        twiml.play(speakerAudioUrl);
                    } else {
                        twiml.say(todaysMessage.speaker_name);
                    }
                    
                    twiml.say(': ' + todaysMessage.title);
                    
                    if (todaysMessage.audio_url) {
                        twiml.play(todaysMessage.audio_url);
                    } else if (todaysMessage.recorded_audio) {
                        const audioUrl = req.protocol + '://' + req.get('host') + '/audio/' + todaysMessage.recorded_audio;
                        twiml.play(audioUrl);
                    } else {
                        twiml.say('The audio for today\'s message is not yet available. Please check back later.');
                    }
                } else {
                    twiml.say('Today\'s message is not yet available. Please check back later.');
                }
                
                twiml.say('Press any key to return to the main menu.');
                twiml.gather({
                    numDigits: 1,
                    action: '/webhook',
                    method: 'POST'
                });
                break;
                
            case '2':
                // All messages menu with recorded speaker names
                const allMessages = await pool.query(
                    'SELECT * FROM nishmas_messages WHERE is_active = true ORDER BY day_number ASC'
                );
                
                if (allMessages.rows.length > 0) {
                    twiml.say('Here are all available messages:');
                    
                    // Build dynamic menu with recorded names
                    allMessages.rows.forEach(msg => {
                        twiml.say('For');
                        
                        if (msg.speaker_name_audio) {
                            const speakerAudioUrl = req.protocol + '://' + req.get('host') + '/audio/' + msg.speaker_name_audio;
                            twiml.play(speakerAudioUrl);
                        } else {
                            twiml.say(msg.speaker_name);
                        }
                        
                        twiml.say('\'s message from Day ' + msg.day_number + ', press ' + msg.day_number + '.');
                    });
                    
                    twiml.say('Press 0 to return to the main menu.');
                    
                    const gather = twiml.gather({
                        numDigits: 2,
                        action: '/handle-message-selection',
                        method: 'POST',
                        timeout: 20
                    });
                    
                } else {
                    twiml.say('No messages are available yet. Please check back later.');
                    twiml.redirect('/webhook');
                }
                break;
                
            case '3':
                // Say Nishmas
                twiml.say('Thank you for choosing to say Nishmas. Here is a moment for your personal prayer.');
                twiml.pause({ length: 30 }); // 30 seconds of silence
                twiml.say('Thank you for saying Nishmas. May your prayers be answered.');
                twiml.redirect('/webhook');
                break;
                
            default:
                twiml.say('Invalid selection. Please try again.');
                twiml.redirect('/webhook');
        }
    } catch (error) {
        console.error('Menu handling error:', error);
        twiml.say('We\'re experiencing technical difficulties. Please try again later.');
        twiml.redirect('/webhook');
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Handle specific message selection
app.post('/handle-message-selection', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const digits = req.body.Digits;
    
    try {
        if (digits === '0') {
            twiml.redirect('/webhook');
            res.type('text/xml');
            res.send(twiml.toString());
            return;
        }
        
        const dayNumber = parseInt(digits);
        const message = await pool.query(
            'SELECT * FROM nishmas_messages WHERE day_number = $1 AND is_active = true',
            [dayNumber]
        );
        
        if (message.rows.length > 0) {
            const msg = message.rows[0];
            twiml.say('Day ' + dayNumber + ' message from');
            
            if (msg.speaker_name_audio) {
                const speakerAudioUrl = req.protocol + '://' + req.get('host') + '/audio/' + msg.speaker_name_audio;
                twiml.play(speakerAudioUrl);
            } else {
                twiml.say(msg.speaker_name);
            }
            
            twiml.say(': ' + msg.title);
            
            if (msg.audio_url) {
                twiml.play(msg.audio_url);
            } else if (msg.recorded_audio) {
                const audioUrl = req.protocol + '://' + req.get('host') + '/audio/' + msg.recorded_audio;
                twiml.play(audioUrl);
            } else {
                twiml.say('The audio for this message is not yet available.');
            }
            
            twiml.say('Press any key to return to the main menu.');
            twiml.gather({
                numDigits: 1,
                action: '/webhook',
                method: 'POST'
            });
        } else {
            twiml.say('Message not found. Returning to main menu.');
            twiml.redirect('/webhook');
        }
    } catch (error) {
        console.error('Message selection error:', error);
        twiml.say('Error playing message. Returning to main menu.');
        twiml.redirect('/webhook');
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Get all messages API
app.get('/api/messages', async (req, res) => {
    try {
        const messages = await pool.query('SELECT * FROM nishmas_messages ORDER BY day_number ASC');
        res.json(messages.rows);
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Add/update message API with speaker name audio
app.post('/api/messages', upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'speaker_audio', maxCount: 1 }
]), async (req, res) => {
    try {
        const { day_number, title, speaker_name, audio_url } = req.body;
        
        let recorded_audio = null;
        let speaker_name_audio = null;
        
        if (req.files && req.files.audio) {
            recorded_audio = req.files.audio[0].filename;
        }
        
        if (req.files && req.files.speaker_audio) {
            speaker_name_audio = req.files.speaker_audio[0].filename;
        }
        
        // Check if message for this day already exists
        const existing = await pool.query('SELECT id FROM nishmas_messages WHERE day_number = $1', [day_number]);
        
        if (existing.rows.length > 0) {
            // Update existing
            await pool.query(
                'UPDATE nishmas_messages SET title = $2, speaker_name = $3, speaker_name_audio = $4, audio_url = $5, recorded_audio = $6, date_recorded = NOW() WHERE day_number = $1',
                [day_number, title, speaker_name, speaker_name_audio, audio_url || null, recorded_audio]
            );
        } else {
            // Insert new
            await pool.query(
                'INSERT INTO nishmas_messages (day_number, title, speaker_name, speaker_name_audio, audio_url, recorded_audio, date_recorded) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
                [day_number, title, speaker_name, speaker_name_audio, audio_url || null, recorded_audio]
            );
        }
        
        res.json({ success: true, message: 'Message saved successfully' });
    } catch (error) {
        console.error('Error saving message:', error);
        res.status(500).json({ error: 'Failed to save message' });
    }
});

// Delete message API
app.delete('/api/messages/:day', async (req, res) => {
    try {
        await pool.query('UPDATE nishmas_messages SET is_active = false WHERE day_number = $1', [req.params.day]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting message:', error);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// Get settings API
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await pool.query('SELECT * FROM nishmas_settings LIMIT 1');
        const currentDay = await getCurrentProgramDay();
        res.json({ 
            settings: settings.rows[0] || {}, 
            current_program_day: currentDay 
        });
    } catch (error) {
        console.error('Error fetching settings:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Update settings API
app.post('/api/settings', upload.fields([
    { name: 'greeting_audio', maxCount: 1 },
    { name: 'closing_audio', maxCount: 1 }
]), async (req, res) => {
    try {
        const { program_start_date, greeting_text, closing_text, is_program_active } = req.body;
        
        let greeting_audio_file = null;
        let closing_audio_file = null;
        
        if (req.files && req.files.greeting_audio) {
            greeting_audio_file = req.files.greeting_audio[0].filename;
        }
        
        if (req.files && req.files.closing_audio) {
            closing_audio_file = req.files.closing_audio[0].filename;
        }
        
        // Build update query dynamically based on what's being updated
        let updateQuery = 'UPDATE nishmas_settings SET ';
        let updateParams = [];
        let paramCount = 0;
        
        if (program_start_date) {
            paramCount++;
            updateQuery += 'program_start_date = $' + paramCount + ', ';
            updateParams.push(program_start_date);
        }
        
        if (greeting_text !== undefined) {
            paramCount++;
            updateQuery += 'greeting_audio = $' + paramCount + ', ';
            updateParams.push(greeting_text);
        }
        
        if (greeting_audio_file) {
            paramCount++;
            updateQuery += 'greeting_audio_file = $' + paramCount + ', ';
            updateParams.push(greeting_audio_file);
        }
        
        if (closing_text !== undefined) {
            paramCount++;
            updateQuery += 'closing_message = $' + paramCount + ', ';
            updateParams.push(closing_text);
        }
        
        if (closing_audio_file) {
            paramCount++;
            updateQuery += 'closing_audio_file = $' + paramCount + ', ';
            updateParams.push(closing_audio_file);
        }
        
        if (is_program_active !== undefined) {
            paramCount++;
            updateQuery += 'is_program_active = $' + paramCount + ', ';
            updateParams.push(is_program_active === 'on' || is_program_active === true);
        }
        
        // Remove trailing comma and add WHERE clause
        updateQuery = updateQuery.slice(0, -2) + ' WHERE id = (SELECT id FROM nishmas_settings LIMIT 1)';
        
        if (paramCount > 0) {
            await pool.query(updateQuery, updateParams);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating settings:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// PROFESSIONAL ADMIN PANEL WITH SPEAKER NAME AUDIO
app.get('/admin', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>40 Days of Nishmas - Admin Panel</title>
    <style>
        :root {
            --primary: #2c3e50;
            --primary-light: #34495e;
            --accent: #3498db;
            --accent-hover: #2980b9;
            --success: #27ae60;
            --success-light: #2ecc71;
            --warning: #f39c12;
            --danger: #e74c3c;
            --light: #ecf0f1;
            --dark: #2c3e50;
            --border: #bdc3c7;
            --text: #2c3e50;
            --text-light: #7f8c8d;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            min-height: 100vh;
            color: var(--text);
            line-height: 1.6;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }

        .header {
            background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%);
            color: white;
            padding: 2rem;
            border-radius: 12px;
            margin-bottom: 2rem;
            text-align: center;
            box-shadow: 0 8px 32px rgba(44, 62, 80, 0.3);
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 0.5rem;
            font-weight: 300;
        }

        .header p {
            opacity: 0.9;
            font-size: 1.1rem;
        }

        .status-bar {
            background: white;
            padding: 1.5rem;
            border-radius: 12px;
            margin-bottom: 2rem;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            border-left: 4px solid var(--accent);
        }

        .status-text {
            font-size: 1.3rem;
            font-weight: 500;
            color: var(--primary);
        }

        .nav-tabs {
            display: flex;
            background: white;
            border-radius: 12px;
            padding: 8px;
            margin-bottom: 2rem;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            gap: 4px;
        }

        .nav-tab {
            flex: 1;
            padding: 1rem 2rem;
            background: transparent;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 1rem;
            font-weight: 500;
            color: var(--text-light);
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
        }

        .nav-tab:hover {
            background: var(--light);
            color: var(--text);
        }

        .nav-tab.active {
            background: var(--accent);
            color: white;
            box-shadow: 0 2px 8px rgba(52, 152, 219, 0.3);
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }

        .card {
            background: white;
            border-radius: 12px;
            padding: 2rem;
            margin-bottom: 2rem;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            border: 1px solid var(--border);
        }

        .card h2 {
            color: var(--primary);
            margin-bottom: 1.5rem;
            font-size: 1.8rem;
            font-weight: 400;
        }

        .form-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1.5rem;
            margin-bottom: 1.5rem;
        }

        .form-group {
            margin-bottom: 1.5rem;
        }

        .form-group.full-width {
            grid-column: 1 / -1;
        }

        .form-group label {
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 500;
            color: var(--primary);
            font-size: 0.95rem;
        }

        .form-group input,
        .form-group textarea,
        .form-group select {
            width: 100%;
            padding: 0.875rem;
            border: 2px solid var(--border);
            border-radius: 8px;
            font-size: 1rem;
            transition: border-color 0.3s ease;
            background: white;
        }

        .form-group input:focus,
        .form-group textarea:focus,
        .form-group select:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 3px rgba(52, 152, 219, 0.1);
        }

        .upload-area {
            border: 2px dashed var(--border);
            border-radius: 12px;
            padding: 1.5rem;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s ease;
            background: #fafafa;
        }

        .upload-area:hover {
            border-color: var(--accent);
            background: rgba(52, 152, 219, 0.05);
        }

        .upload-area.has-file {
            border-color: var(--success);
            background: rgba(39, 174, 96, 0.05);
        }

        .upload-icon {
            font-size: 2rem;
            margin-bottom: 0.5rem;
            color: var(--text-light);
        }

        .upload-text {
            font-weight: 500;
            color: var(--text);
            margin-bottom: 0.25rem;
        }

        .upload-subtext {
            font-size: 0.8rem;
            color: var(--text-light);
        }

        .speaker-audio-section {
            background: #f8f9ff;
            border: 1px solid #e1e7ff;
            border-radius: 8px;
            padding: 1rem;
            margin-bottom: 1rem;
        }

        .speaker-audio-label {
            font-size: 0.9rem;
            color: var(--accent);
            font-weight: 600;
            margin-bottom: 0.5rem;
            display: block;
        }

        .btn {
            padding: 0.875rem 1.5rem;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 1rem;
            font-weight: 500;
            transition: all 0.3s ease;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            text-decoration: none;
        }

        .btn-primary {
            background: var(--accent);
            color: white;
        }

        .btn-primary:hover {
            background: var(--accent-hover);
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(52, 152, 219, 0.3);
        }

        .btn-success {
            background: var(--success);
            color: white;
        }

        .btn-success:hover {
            background: var(--success-light);
        }

        .btn-danger {
            background: var(--danger);
            color: white;
        }

        .btn-danger:hover {
            background: #c0392b;
        }

        .btn-full {
            width: 100%;
            justify-content: center;
        }

        .messages-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
            gap: 1.5rem;
            margin-top: 2rem;
        }

        .message-card {
            background: white;
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.5rem;
            transition: all 0.3s ease;
        }

        .message-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 8px 32px rgba(0,0,0,0.15);
        }

        .message-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 1rem;
        }

        .day-badge {
            background: var(--accent);
            color: white;
            padding: 0.5rem 1rem;
            border-radius: 20px;
            font-weight: 500;
            font-size: 0.875rem;
        }

        .message-title {
            font-size: 1.1rem;
            font-weight: 500;
            color: var(--primary);
            margin: 0.5rem 0;
        }

        .speaker-info {
            background: #f0f7ff;
            border-radius: 6px;
            padding: 0.5rem;
            margin: 0.5rem 0;
        }

        .speaker-name {
            color: var(--accent);
            font-weight: 500;
            font-size: 0.95rem;
        }

        .speaker-audio-indicator {
            font-size: 0.8rem;
            color: var(--success);
            margin-top: 0.25rem;
        }

        .message-date {
            color: var(--text-light);
            font-size: 0.875rem;
        }

        .message-actions {
            display: flex;
            gap: 0.5rem;
            margin-top: 1rem;
        }

        .alert {
            padding: 1rem 1.5rem;
            border-radius: 8px;
            margin-bottom: 1.5rem;
            font-weight: 500;
        }

        .alert-success {
            background: rgba(39, 174, 96, 0.1);
            color: var(--success);
            border: 1px solid rgba(39, 174, 96, 0.3);
        }

        .alert-error {
            background: rgba(231, 76, 60, 0.1);
            color: var(--danger);
            border: 1px solid rgba(231, 76, 60, 0.3);
        }

        audio {
            width: 100%;
            margin: 0.5rem 0;
        }

        @media (max-width: 768px) {
            .form-grid {
                grid-template-columns: 1fr;
            }

            .nav-tabs {
                flex-direction: column;
            }

            .messages-grid {
                grid-template-columns: 1fr;
            }

            .header h1 {
                font-size: 2rem;
            }

            .message-actions {
                flex-direction: column;
            }
        }

        .empty-state {
            text-align: center;
            padding: 3rem;
            color: var(--text-light);
        }

        .empty-state-icon {
            font-size: 4rem;
            margin-bottom: 1rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>40 Days of Nishmas</h1>
            <p>Professional Admin Panel with Speaker Name Audio</p>
        </div>

        <div class="status-bar">
            <div class="status-text" id="statusText">Loading program status...</div>
        </div>

        <div class="nav-tabs">
            <button class="nav-tab active" onclick="showTab('add-message')" id="tab-add">
                📝 Add Message
            </button>
            <button class="nav-tab" onclick="showTab('messages')" id="tab-messages">
                📚 All Messages
            </button>
            <button class="nav-tab" onclick="showTab('settings')" id="tab-settings">
                ⚙️ Settings
            </button>
        </div>

        <!-- Add Message Tab -->
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
                            <label for="speakerName">Speaker Name (text)</label>
                            <input type="text" id="speakerName" placeholder="e.g., Rabbi Goldstein" required>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label for="messageTitle">Message Title</label>
                        <input type="text" id="messageTitle" placeholder="e.g., Introduction to Nishmas" required>
                    </div>
                    
                    <div class="speaker-audio-section">
                        <label class="speaker-audio-label">🎙️ Speaker Name Audio (2-3 seconds)</label>
                        <div class="upload-area" onclick="document.getElementById('speakerAudio').click()">
                            <div class="upload-icon">🗣️</div>
                            <div class="upload-text">Record & upload speaker name</div>
                            <div class="upload-subtext">Short clip saying "Rabbi Goldstein" for natural pronunciation</div>
                            <input type="file" id="speakerAudio" name="speaker_audio" accept="audio/*" style="display:none">
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>Message Audio File</label>
                        <div class="upload-area" onclick="document.getElementById('audioFile').click()">
                            <div class="upload-icon">🎵</div>
                            <div class="upload-text">Upload full message audio</div>
                            <div class="upload-subtext">Complete daily message MP3/WAV file</div>
                            <input type="file" id="audioFile" accept="audio/*" style="display:none">
                        </div>
                    </div>
                    
                    <button type="submit" class="btn btn-primary btn-full">Save Message</button>
                </form>
            </div>
        </div>

        <!-- Messages Tab -->
        <div class="tab-content" id="messages">
            <div class="card">
                <h2>All Messages</h2>
                <div class="messages-grid" id="messagesContainer">
                    <div class="empty-state">
                        <div class="empty-state-icon">⏳</div>
                        <p>Loading messages...</p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Settings Tab -->
        <div class="tab-content" id="settings">
            <div class="card">
                <h2>Program Settings</h2>
                <div id="settings-alert"></div>
                
                <form id="settingsForm" enctype="multipart/form-data">
                    <div class="form-group">
                        <label for="startDate">Program Start Date</label>
                        <input type="date" id="startDate" required>
                    </div>
                    
                    <div class="form-group">
                        <label>Custom Welcome Message (Audio)</label>
                        <div class="upload-area" onclick="document.getElementById('greetingAudio').click()">
                            <div class="upload-icon">📞</div>
                            <div class="upload-text">Upload welcome greeting</div>
                            <div class="upload-subtext">This will replace the automated greeting</div>
                            <input type="file" id="greetingAudio" name="greeting_audio" accept="audio/*" style="display:none">
                        </div>
                        <div id="current-greeting"></div>
                    </div>
                    
                    <button type="submit" class="btn btn-success btn-full">Save Settings</button>
                </form>
            </div>
        </div>
    </div>

    <script>
        let currentMessages = [];
        let currentSettings = {};
        
        document.addEventListener('DOMContentLoaded', function() {
            loadMessages();
            loadSettings();
        });
        
        function showTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            
            document.getElementById(tabName).classList.add('active');
            document.getElementById('tab-' + tabName.split('-')[0]).classList.add('active');
        }
        
        async function loadMessages() {
            try {
                const response = await fetch('/api/messages');
                currentMessages = await response.json();
                displayMessages();
            } catch (error) {
                console.error('Error loading messages:', error);
            }
        }
        
        async function loadSettings() {
            try {
                const response = await fetch('/api/settings');
                const data = await response.json();
                currentSettings = data.settings;
                
                document.getElementById('statusText').innerHTML = 
                    'Today is <strong>Day ' + data.current_program_day + '</strong> of the 40 Days of Nishmas program';
                
                document.getElementById('dayNumber').value = data.current_program_day;
                
                if (currentSettings.program_start_date) {
                    document.getElementById('startDate').value = currentSettings.program_start_date.split('T')[0];
                }
                
                if (currentSettings.greeting_audio_file) {
                    document.getElementById('current-greeting').innerHTML = 
                        '<div style="margin-top: 1rem; padding: 1rem; background: #f8f9fa; border-radius: 8px; border-left: 4px solid var(--success);">' +
                        '<strong>Current Welcome Message:</strong><br>' +
                        '<audio controls style="width: 100%; margin-top: 0.5rem;">' +
                        '<source src="/audio/' + currentSettings.greeting_audio_file + '" type="audio/mpeg">' +
                        '</audio></div>';
                }
                
            } catch (error) {
                console.error('Error loading settings:', error);
            }
        }
        
        function displayMessages() {
            const container = document.getElementById('messagesContainer');
            
            if (currentMessages.length === 0) {
                container.innerHTML = 
                    '<div class="empty-state">' +
                        '<div class="empty-state-icon">📝</div>' +
                        '<p>No messages yet. Add your first message to get started.</p>' +
                    '</div>';
                return;
            }
            
            container.innerHTML = currentMessages.map(msg => 
                '<div class="message-card">' +
                    '<div class="message-header">' +
                        '<div class="day-badge">Day ' + msg.day_number + '</div>' +
                    '</div>' +
                    '<div class="speaker-info">' +
                        '<div class="speaker-name">Speaker: ' + (msg.speaker_name || 'Not specified') + '</div>' +
                        (msg.speaker_name_audio ? 
                            '<div class="speaker-audio-indicator">✅ Name audio recorded</div>' +
                            '<audio controls style="width: 100%; margin-top: 0.5rem;"><source src="/audio/' + msg.speaker_name_audio + '" type="audio/mpeg"></audio>' :
                            '<div style="color: var(--warning); font-size: 0.8rem;">⚠️ No name audio</div>') +
                    '</div>' +
                    '<div class="message-title">' + msg.title + '</div>' +
                    '<div class="message-date">Added: ' + new Date(msg.date_recorded).toLocaleDateString() + '</div>' +
                    (msg.recorded_audio ? 
                        '<audio controls><source src="/audio/' + msg.recorded_audio + '" type="audio/mpeg"></audio>' :
                        '<p style="color: var(--warning); margin-top: 0.5rem;">⚠️ No message audio</p>') +
                    '<div class="message-actions">' +
                        '<button class="btn btn-primary" onclick="editMessage(' + msg.day_number + ')">Edit</button>' +
                        '<button class="btn btn-danger" onclick="deleteMessage(' + msg.day_number + ')">Delete</button>' +
                    '</div>' +
                '</div>'
            ).join('');
        }
        
        function editMessage(dayNumber) {
            const message = currentMessages.find(m => m.day_number == dayNumber);
            if (!message) return;
            
            document.getElementById('dayNumber').value = message.day_number;
            document.getElementById('speakerName').value = message.speaker_name || '';
            document.getElementById('messageTitle').value = message.title;
            
            showTab('add-message');
        }
        
        async function deleteMessage(dayNumber) {
            if (!confirm('Are you sure you want to delete this message?')) return;
            
            try {
                const response = await fetch('/api/messages/' + dayNumber, { method: 'DELETE' });
                if (response.ok) {
                    showAlert('settings-alert', 'Message deleted successfully', 'success');
                    loadMessages();
                } else {
                    showAlert('settings-alert', 'Error deleting message', 'error');
                }
            } catch (error) {
                showAlert('settings-alert', 'Error deleting message', 'error');
            }
        }
        
        function showAlert(containerId, message, type) {
            const container = document.getElementById(containerId);
            container.innerHTML = '<div class="alert alert-' + type + '">' + message + '</div>';
            setTimeout(() => {
                container.innerHTML = '';
            }, 5000);
        }
        
        document.getElementById('messageForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const dayNumber = document.getElementById('dayNumber').value;
            const speakerName = document.getElementById('speakerName').value;
            const title = document.getElementById('messageTitle').value;
            const audioFile = document.getElementById('audioFile').files[0];
            const speakerAudioFile = document.getElementById('speakerAudio').files[0];
            
            if (!audioFile) {
                showAlert('add-alert', 'Please upload the message audio file', 'error');
                return;
            }
            
            const formData = new FormData();
            formData.append('day_number', dayNumber);
            formData.append('speaker_name', speakerName);
            formData.append('title', title);
            formData.append('audio', audioFile);
            
            if (speakerAudioFile) {
                formData.append('speaker_audio', speakerAudioFile);
            }
            
            try {
                const response = await fetch('/api/messages', {
                    method: 'POST',
                    body: formData
                });
                
                if (response.ok) {
                    showAlert('add-alert', 'Message saved successfully', 'success');
                    document.getElementById('messageForm').reset();
                    updateUploadAreas();
                    loadMessages();
                    document.getElementById('dayNumber').value = parseInt(dayNumber) + 1;
                } else {
                    showAlert('add-alert', 'Error saving message', 'error');
                }
            } catch (error) {
                showAlert('add-alert', 'Error saving message', 'error');
            }
        });
        
        document.getElementById('settingsForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const formData = new FormData();
            formData.append('program_start_date', document.getElementById('startDate').value);
            
            const greetingFile = document.getElementById('greetingAudio').files[0];
            if (greetingFile) {
                formData.append('greeting_audio', greetingFile);
            }
            
            try {
                const response = await fetch('/api/settings', {
                    method: 'POST',
                    body: formData
                });
                
                if (response.ok) {
                    showAlert('settings-alert', 'Settings saved successfully', 'success');
                    loadSettings();
                } else {
                    showAlert('settings-alert', 'Error saving settings', 'error');
                }
            } catch (error) {
                showAlert('settings-alert', 'Error saving settings', 'error');
            }
        });
        
        function updateUploadAreas() {
            document.querySelectorAll('.upload-area').forEach(area => {
                area.classList.remove('has-file');
                const text = area.querySelector('.upload-text');
                if (text.textContent.includes('speaker name')) {
                    text.textContent = 'Record & upload speaker name';
                } else if (text.textContent.includes('message audio')) {
                    text.textContent = 'Upload full message audio';
                } else if (text.textContent.includes('welcome')) {
                    text.textContent = 'Upload welcome greeting';
                }
            });
        }
        
        // File upload visual feedback
        document.getElementById('audioFile').addEventListener('change', function(e) {
            handleFileUpload(e, 'Upload full message audio');
        });
        
        document.getElementById('speakerAudio').addEventListener('change', function(e) {
            handleFileUpload(e, 'Record & upload speaker name');
        });
        
        document.getElementById('greetingAudio').addEventListener('change', function(e) {
            handleFileUpload(e, 'Upload welcome greeting');
        });
        
        function handleFileUpload(e, originalText) {
            const file = e.target.files[0];
            const area = e.target.closest('.upload-area') || e.target.parentElement;
            const text = area.querySelector('.upload-text');
            if (file) {
                area.classList.add('has-file');
                text.textContent = '✓ ' + file.name;
            } else {
                area.classList.remove('has-file');
                text.textContent = originalText;
            }
        }
    </script>
</body>
</html>
    `);
});

// Initialize database and start server
initDB().then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log('Nishmas IVR server running on port ' + PORT);
        console.log('Webhook URL: /webhook');
        console.log('Admin Panel: /admin');
    });
});
