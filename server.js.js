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
                closing_message TEXT,
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
        const greeting = settings.rows[0]?.greeting_audio || 'Welcome to the 40 Days of Nishmas program.';
        
        const gather = twiml.gather({
            numDigits: 1,
            action: '/handle-menu',
            method: 'POST',
            timeout: 10
        });
        
        gather.say(greeting);
        
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
                    twiml.say('Here is today\'s message: ' + todaysMessage.title);
                    
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
                // All messages menu
                const allMessages = await pool.query(
                    'SELECT * FROM nishmas_messages WHERE is_active = true ORDER BY day_number ASC'
                );
                
                if (allMessages.rows.length > 0) {
                    let menuText = 'Here are all available messages: ';
                    allMessages.rows.forEach(msg => {
                        menuText += 'Press ' + msg.day_number + ' for day ' + msg.day_number + ': ' + msg.title + '. ';
                    });
                    menuText += 'Press 0 to return to the main menu.';
                    
                    const gather = twiml.gather({
                        numDigits: 2,
                        action: '/handle-message-selection',
                        method: 'POST',
                        timeout: 15
                    });
                    
                    gather.say(menuText);
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
            twiml.say('Day ' + dayNumber + ': ' + msg.title);
            
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

// Add/update message API
app.post('/api/messages', upload.single('audio'), async (req, res) => {
    try {
        const { day_number, title, audio_url } = req.body;
        const recorded_audio = req.file ? req.file.filename : null;
        
        // Check if message for this day already exists
        const existing = await pool.query('SELECT id FROM nishmas_messages WHERE day_number = $1', [day_number]);
        
        if (existing.rows.length > 0) {
            // Update existing
            await pool.query(
                'UPDATE nishmas_messages SET title = $2, audio_url = $3, recorded_audio = $4, date_recorded = NOW() WHERE day_number = $1',
                [day_number, title, audio_url || null, recorded_audio]
            );
        } else {
            // Insert new
            await pool.query(
                'INSERT INTO nishmas_messages (day_number, title, audio_url, recorded_audio, date_recorded) VALUES ($1, $2, $3, $4, NOW())',
                [day_number, title, audio_url || null, recorded_audio]
            );
        }
        
        res.json({ success: true, message: 'Message saved successfully' });
    } catch (error) {
        console.error('Error saving message:', error);
        res.status(500).json({ error: 'Failed to save message' });
    }
});

// Simple admin panel
app.get('/admin', (req, res) => {
    res.send(`
        <h1>40 Days of Nishmas - Admin Panel</h1>
        <p>System is running! Use the API endpoints to manage messages.</p>
        <h2>API Endpoints:</h2>
        <ul>
            <li>GET /api/messages - List all messages</li>
            <li>POST /api/messages - Add/update message</li>
        </ul>
        <h2>IVR Webhook:</h2>
        <p>Point your Twilio phone number to: <strong>${req.protocol}://${req.get('host')}/webhook</strong></p>
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
