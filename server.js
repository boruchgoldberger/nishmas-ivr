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
        
        // Use audio file if available, otherwise use text greeting
        if (settingsData?.greeting_audio_file) {
            const audioUrl = req.protocol + '://' + req.get('host') + '/audio/' + settingsData.greeting_audio_file;
            const gather = twiml.gather({
                numDigits: 1,
                action: '/handle-menu',
                method: 'POST',
                timeout: 10
            });
            gather.play(audioUrl);
        } else {
            const greeting = settingsData?.greeting_audio || 'Welcome to the 40 Days of Nishmas program.';
            const gather = twiml.gather({
                numDigits: 1,
                action: '/handle-menu',
                method: 'POST',
                timeout: 10
            });
            gather.say(greeting);
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

// ULTRA-SIMPLE ADMIN PANEL FOR NON-TECH STAFF
app.get('/admin', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Nishmas Admin - SUPER SIMPLE</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { box-sizing: border-box; }
        body { 
            font-family: Arial, sans-serif; margin: 0; padding: 20px; 
            background: #f0f0f0; color: #333; font-size: 18px;
        }
        .container { max-width: 800px; margin: 0 auto; }
        
        /* HUGE, OBVIOUS BUTTONS */
        .big-button {
            display: block; width: 100%; padding: 20px; margin: 15px 0;
            font-size: 24px; font-weight: bold; text-align: center;
            border: 3px solid #007aff; border-radius: 15px; cursor: pointer;
            background: white; color: #007aff; text-decoration: none;
            transition: all 0.3s;
        }
        .big-button:hover { background: #007aff; color: white; transform: scale(1.02); }
        .big-button.active { background: #007aff; color: white; }
        
        /* SIMPLE CARD DESIGN */
        .card { 
            background: white; padding: 30px; margin: 20px 0; border-radius: 15px;
            box-shadow: 0 4px 10px rgba(0,0,0,0.1); border: 2px solid #ddd;
        }
        .card h1 { margin-top: 0; color: #333; font-size: 28px; text-align: center; }
        .card h2 { color: #007aff; font-size: 24px; margin-bottom: 20px; }
        
        /* FOOLPROOF FORMS */
        .form-group { margin: 25px 0; }
        .form-group label { 
            display: block; margin-bottom: 10px; font-weight: bold; 
            font-size: 20px; color: #333;
        }
        .form-group input, .form-group textarea, .form-group select {
            width: 100%; padding: 15px; font-size: 18px; 
            border: 3px solid #ddd; border-radius: 10px;
        }
        .form-group input:focus, .form-group textarea:focus {
            border-color: #007aff; outline: none;
        }
        
        /* UPLOAD AREAS THAT SCREAM "CLICK ME!" */
        .upload-box {
            border: 5px dashed #007aff; border-radius: 15px; 
            padding: 40px; text-align: center; cursor: pointer;
            background: #f8f9ff; margin: 20px 0;
        }
        .upload-box:hover { background: #e6f3ff; }
        .upload-box .icon { font-size: 48px; margin-bottom: 15px; }
        .upload-box .text { font-size: 20px; font-weight: bold; color: #007aff; }
        
        /* SUPER OBVIOUS SAVE BUTTON */
        .save-btn {
            background: #28a745; color: white; border: none; padding: 20px 40px;
            font-size: 22px; font-weight: bold; border-radius: 15px; cursor: pointer;
            width: 100%; margin: 20px 0;
        }
        .save-btn:hover { background: #218838; transform: scale(1.02); }
        
        /* CURRENT DAY DISPLAY - SUPER PROMINENT */
        .current-day { 
            background: linear-gradient(45deg, #ff6b6b, #4ecdc4);
            color: white; padding: 30px; text-align: center; border-radius: 15px;
            font-size: 32px; font-weight: bold; margin: 20px 0;
            box-shadow: 0 8px 20px rgba(0,0,0,0.2);
        }
        
        /* SIMPLE MESSAGE CARDS */
        .message-card {
            border: 3px solid #28a745; border-radius: 15px; padding: 20px; margin: 15px 0;
            background: #f8fff8;
        }
        .message-card h3 { color: #28a745; font-size: 22px; margin: 0 0 10px; }
        .message-card .day-badge { 
            background: #28a745; color: white; padding: 8px 15px; 
            border-radius: 20px; font-weight: bold; display: inline-block; margin-bottom: 10px;
        }
        
        /* HIDE COMPLEX STUFF */
        .section { display: none; }
        .section.active { display: block; }
        
        /* AUDIO PLAYERS */
        audio { width: 100%; margin: 15px 0; }
        
        /* SUCCESS/ERROR MESSAGES */
        .alert { padding: 20px; margin: 20px 0; border-radius: 10px; font-size: 18px; font-weight: bold; }
        .alert.success { background: #d4edda; color: #155724; border: 2px solid #28a745; }
        .alert.error { background: #f8d7da; color: #721c24; border: 2px solid #dc3545; }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <h1>🕊️ Nishmas Admin Panel</h1>
            <p style="text-align: center; font-size: 20px; color: #666;">
                Super simple controls for your 40 Days program
            </p>
        </div>
        
        <div class="current-day" id="currentDay">
            📅 Loading program status...
        </div>
        
        <!-- MAIN NAVIGATION -->
        <button class="big-button active" onclick="showSection('add-message')" id="btn-add">
            ➕ ADD TODAY'S MESSAGE
        </button>
        <button class="big-button" onclick="showSection('all-messages')" id="btn-all">
            📝 VIEW ALL MESSAGES
        </button>
        <button class="big-button" onclick="showSection('settings')" id="btn-settings">
            ⚙️ PROGRAM SETTINGS
        </button>
        
        <!-- ADD MESSAGE SECTION -->
        <div class="section active" id="add-message">
            <div class="card">
                <h2>Add Daily Message</h2>
                <div id="add-alert"></div>
                
                <form id="messageForm" enctype="multipart/form-data">
                    <div class="form-group">
                        <label>🗓️ DAY NUMBER (1 to 40)</label>
                        <input type="number" id="dayNumber" min="1" max="40" value="1" required 
                               style="font-size: 24px; text-align: center; font-weight: bold;">
                    </div>
                    
                    <div class="form-group">
                        <label>📝 MESSAGE TITLE</label>
                        <input type="text" id="messageTitle" 
                               placeholder="Example: Day 1 - Introduction to Nishmas" required>
                    </div>
                    
                    <div class="form-group">
                        <label>🎵 UPLOAD AUDIO FILE</label>
                        <div class="upload-box" onclick="document.getElementById('audioFile').click()">
                            <div class="icon">🎤</div>
                            <div class="text" id="upload-text">CLICK HERE TO UPLOAD MP3 FILE</div>
                            <input type="file" id="audioFile" accept="audio/*" style="display:none">
                        </div>
                    </div>
                    
                    <button type="submit" class="save-btn">💾 SAVE MESSAGE</button>
                </form>
            </div>
        </div>
        
        <!-- ALL MESSAGES SECTION -->
        <div class="section" id="all-messages">
            <div class="card">
                <h2>All Your Messages</h2>
                <div id="messagesContainer">Loading messages...</div>
            </div>
        </div>
        
        <!-- SETTINGS SECTION -->
        <div class="section" id="settings">
            <div class="card">
                <h2>Program Settings</h2>
                <div id="settings-alert"></div>
                
                <form id="settingsForm" enctype="multipart/form-data">
                    <div class="form-group">
                        <label>📅 PROGRAM START DATE</label>
                        <input type="date" id="startDate" required style="font-size: 20px;">
                    </div>
                    
                    <div class="form-group">
                        <label>🎙️ WELCOME MESSAGE (what callers hear first)</label>
                        <div class="upload-box" onclick="document.getElementById('greetingAudio').click()">
                            <div class="icon">📞</div>
                            <div class="text">UPLOAD WELCOME AUDIO</div>
                            <input type="file" id="greetingAudio" name="greeting_audio" accept="audio/*" style="display:none">
                        </div>
                        <div id="current-greeting"></div>
                    </div>
                    
                    <button type="submit" class="save-btn">💾 SAVE SETTINGS</button>
                </form>
            </div>
        </div>
    </div>
    
    <script>
        let currentMessages = [];
        let currentSettings = {};
        
        // Load data when page starts
        document.addEventListener('DOMContentLoaded', function() {
            loadMessages();
            loadSettings();
            setTodayAsDefault();
        });
        
        // Set today's program day as default
        function setTodayAsDefault() {
            // This will be updated when settings load
        }
        
        // Show different sections
        function showSection(sectionName) {
            // Hide all sections
            document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
            document.querySelectorAll('.big-button').forEach(b => b.classList.remove('active'));
            
            // Show selected section
            document.getElementById(sectionName).classList.add('active');
            document.getElementById('btn-' + sectionName.split('-')[0]).classList.add('active');
        }
        
        // Load messages
        async function loadMessages() {
            try {
                const response = await fetch('/api/messages');
                currentMessages = await response.json();
                displayMessages();
            } catch (error) {
                console.error('Error loading messages:', error);
            }
        }
        
        // Load settings
        async function loadSettings() {
            try {
                const response = await fetch('/api/settings');
                const data = await response.json();
                currentSettings = data.settings;
                
                // Update current day display
                document.getElementById('currentDay').innerHTML = 
                    '📅 Today is <strong>Day ' + data.current_program_day + '</strong> of 40';
                
                // Set default day number to current day
                document.getElementById('dayNumber').value = data.current_program_day;
                
                // Populate settings form
                if (currentSettings.program_start_date) {
                    document.getElementById('startDate').value = currentSettings.program_start_date.split('T')[0];
                }
                
                // Show current greeting if exists
                if (currentSettings.greeting_audio_file) {
                    document.getElementById('current-greeting').innerHTML = 
                        '<div style="margin-top: 15px; padding: 15px; background: #e8f5e8; border-radius: 10px;">' +
                        '<strong>✅ Current Welcome Message:</strong><br>' +
                        '<audio controls style="width: 100%; margin-top: 10px;">' +
                        '<source src="/audio/' + currentSettings.greeting_audio_file + '" type="audio/mpeg">' +
                        '</audio></div>';
                }
                
            } catch (error) {
                console.error('Error loading settings:', error);
            }
        }
        
        // Display messages in simple format
        function displayMessages() {
            const container = document.getElementById('messagesContainer');
            
            if (currentMessages.length === 0) {
                container.innerHTML = '<p style="text-align: center; font-size: 20px; color: #666;">No messages yet! Add your first message above.</p>';
                return;
            }
            
            container.innerHTML = currentMessages.map(msg => 
                '<div class="message-card">' +
                    '<div class="day-badge">Day ' + msg.day_number + '</div>' +
                    '<h3>' + msg.title + '</h3>' +
                    '<p><strong>Added:</strong> ' + new Date(msg.date_recorded).toLocaleDateString() + '</p>' +
                    (msg.recorded_audio ? 
                        '<audio controls><source src="/audio/' + msg.recorded_audio + '" type="audio/mpeg"></audio>' :
                        '<p style="color: #orange;">⚠️ No audio file</p>') +
                '</div>'
            ).join('');
        }
        
        // Handle message form
        document.getElementById('messageForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const alertDiv = document.getElementById('add-alert');
            const dayNumber = document.getElementById('dayNumber').value;
            const title = document.getElementById('messageTitle').value;
            const audioFile = document.getElementById('audioFile').files[0];
            
            if (!audioFile) {
                alertDiv.innerHTML = '<div class="alert error">❌ Please upload an audio file!</div>';
                return;
            }
            
            const formData = new FormData();
            formData.append('day_number', dayNumber);
            formData.append('title', title);
            formData.append('audio', audioFile);
            
            try {
                const response = await fetch('/api/messages', {
                    method: 'POST',
                    body: formData
                });
                
                if (response.ok) {
                    alertDiv.innerHTML = '<div class="alert success">✅ Message saved successfully!</div>';
                    document.getElementById('messageForm').reset();
                    document.getElementById('upload-text').innerHTML = 'CLICK HERE TO UPLOAD MP3 FILE';
                    loadMessages();
                    
                    // Auto-increment day number for next message
                    document.getElementById('dayNumber').value = parseInt(dayNumber) + 1;
                } else {
                    alertDiv.innerHTML = '<div class="alert error">❌ Error saving message. Try again.</div>';
                }
            } catch (error) {
                alertDiv.innerHTML = '<div class="alert error">❌ Error saving message. Try again.</div>';
            }
        });
        
        // Handle settings form
        document.getElementById('settingsForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const alertDiv = document.getElementById('settings-alert');
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
                    alertDiv.innerHTML = '<div class="alert success">✅ Settings saved successfully!</div>';
                    loadSettings(); // Reload to show updated info
                } else {
                    alertDiv.innerHTML = '<div class="alert error">❌ Error saving settings. Try again.</div>';
                }
            } catch (error) {
                alertDiv.innerHTML = '<div class="alert error">❌ Error saving settings. Try again.</div>';
            }
        });
        
        // File upload visual feedback
        document.getElementById('audioFile').addEventListener('change', function(e) {
            const file = e.target.files[0];
            const uploadText = document.getElementById('upload-text');
            if (file) {
                uploadText.innerHTML = '✅ SELECTED: ' + file.name;
                uploadText.style.color = '#28a745';
            }
        });
        
        document.getElementById('greetingAudio').addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                const box = e.target.parentElement.querySelector('.text');
                box.innerHTML = '✅ SELECTED: ' + file.name;
                box.style.color = '#28a745';
            }
        });
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
