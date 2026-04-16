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
app.post('/api/settings', async (req, res) => {
    try {
        const { program_start_date, greeting_audio, closing_message, is_program_active } = req.body;
        
        await pool.query(`
            UPDATE nishmas_settings 
            SET program_start_date = $1, greeting_audio = $2, closing_message = $3, is_program_active = $4
            WHERE id = (SELECT id FROM nishmas_settings LIMIT 1)
        `, [program_start_date, greeting_audio, closing_message, is_program_active]);
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating settings:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// FULL VISUAL ADMIN PANEL
app.get('/admin', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>40 Days of Nishmas - Admin Panel</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0; padding: 20px; background: #f5f5f7; color: #1d1d1f;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; padding: 2rem; border-radius: 16px; margin-bottom: 2rem;
            text-align: center;
        }
        .header h1 { margin: 0; font-size: 2.5rem; font-weight: 700; }
        .header p { margin: 0.5rem 0 0; opacity: 0.9; font-size: 1.1rem; }
        
        .tabs { 
            display: flex; background: white; border-radius: 12px; padding: 8px; margin-bottom: 2rem;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
        }
        .tab { 
            flex: 1; padding: 12px 24px; text-align: center; border: none; background: none;
            cursor: pointer; border-radius: 8px; font-weight: 600; transition: all 0.3s;
        }
        .tab.active { background: #007aff; color: white; }
        .tab:hover:not(.active) { background: #f0f0f0; }
        
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        
        .card { 
            background: white; border-radius: 16px; padding: 2rem; margin-bottom: 2rem;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
        }
        .card h2 { margin-top: 0; color: #1d1d1f; font-size: 1.5rem; }
        
        .form-group { margin-bottom: 1.5rem; }
        .form-group label { 
            display: block; margin-bottom: 0.5rem; font-weight: 600; color: #333;
        }
        .form-group input, .form-group textarea, .form-group select {
            width: 100%; padding: 12px 16px; border: 2px solid #e5e5e7; border-radius: 8px;
            font-size: 1rem; transition: border-color 0.3s;
        }
        .form-group input:focus, .form-group textarea:focus, .form-group select:focus {
            outline: none; border-color: #007aff;
        }
        
        .btn {
            background: #007aff; color: white; border: none; padding: 12px 24px;
            border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.3s;
            font-size: 1rem;
        }
        .btn:hover { background: #0056b3; transform: translateY(-2px); }
        .btn.danger { background: #ff3b30; }
        .btn.danger:hover { background: #d70015; }
        
        .message-grid {
            display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 1.5rem; margin-top: 2rem;
        }
        .message-card {
            border: 2px solid #e5e5e7; border-radius: 12px; padding: 1.5rem;
            background: white; transition: all 0.3s;
        }
        .message-card:hover { transform: translateY(-4px); box-shadow: 0 8px 25px rgba(0,0,0,0.15); }
        
        .day-badge {
            background: #007aff; color: white; padding: 4px 12px; border-radius: 20px;
            font-size: 0.875rem; font-weight: 600; margin-bottom: 1rem; display: inline-block;
        }
        
        .stats { display: flex; gap: 2rem; margin-bottom: 2rem; }
        .stat {
            flex: 1; text-align: center; padding: 1.5rem; background: white;
            border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);
        }
        .stat-number { font-size: 2.5rem; font-weight: 700; color: #007aff; }
        .stat-label { color: #666; font-weight: 500; }
        
        .current-day { 
            background: linear-gradient(135deg, #ff9a56 0%, #ff6b95 100%);
            color: white; padding: 1rem; border-radius: 8px; margin-bottom: 2rem;
            text-align: center; font-weight: 600;
        }
        
        .upload-area {
            border: 2px dashed #ccc; border-radius: 8px; padding: 2rem; text-align: center;
            margin: 1rem 0; transition: all 0.3s; cursor: pointer;
        }
        .upload-area:hover { border-color: #007aff; background: #f8f9ff; }
        
        @media (max-width: 768px) {
            .stats { flex-direction: column; gap: 1rem; }
            .tabs { flex-direction: column; }
            .message-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🕊️ 40 Days of Nishmas</h1>
            <p>Admin Panel - Manage Daily Messages & Settings</p>
        </div>
        
        <div class="current-day" id="currentDay">
            Loading current program day...
        </div>
        
        <div class="stats" id="stats">
            <div class="stat">
                <div class="stat-number" id="totalMessages">0</div>
                <div class="stat-label">Messages</div>
            </div>
            <div class="stat">
                <div class="stat-number" id="currentProgramDay">0</div>
                <div class="stat-label">Current Day</div>
            </div>
            <div class="stat">
                <div class="stat-number" id="remainingDays">0</div>
                <div class="stat-label">Days Left</div>
            </div>
        </div>
        
        <div class="tabs">
            <button class="tab active" onclick="showTab('messages')">📝 Messages</button>
            <button class="tab" onclick="showTab('add-message')">➕ Add Message</button>
            <button class="tab" onclick="showTab('settings')">⚙️ Settings</button>
        </div>
        
        <!-- Messages Tab -->
        <div id="messages" class="tab-content active">
            <div class="card">
                <h2>All Messages</h2>
                <div class="message-grid" id="messagesGrid">
                    Loading messages...
                </div>
            </div>
        </div>
        
        <!-- Add Message Tab -->
        <div id="add-message" class="tab-content">
            <div class="card">
                <h2>Add/Edit Daily Message</h2>
                <form id="messageForm" enctype="multipart/form-data">
                    <div class="form-group">
                        <label>Day Number (1-40)</label>
                        <input type="number" id="dayNumber" min="1" max="40" required>
                    </div>
                    
                    <div class="form-group">
                        <label>Message Title</label>
                        <input type="text" id="messageTitle" placeholder="e.g., Day 1: Introduction to Nishmas" required>
                    </div>
                    
                    <div class="form-group">
                        <label>Audio Source</label>
                        <select id="audioSource" onchange="toggleAudioInput()">
                            <option value="upload">Upload Audio File</option>
                            <option value="url">Audio URL</option>
                        </select>
                    </div>
                    
                    <div class="form-group" id="uploadSection">
                        <label>Upload Audio File</label>
                        <div class="upload-area" onclick="document.getElementById('audioFile').click()">
                            <p>🎵 Click to upload audio file (MP3, WAV)</p>
                            <input type="file" id="audioFile" accept="audio/*" style="display:none">
                        </div>
                    </div>
                    
                    <div class="form-group" id="urlSection" style="display:none">
                        <label>Audio URL</label>
                        <input type="url" id="audioUrl" placeholder="https://example.com/audio.mp3">
                    </div>
                    
                    <button type="submit" class="btn">💾 Save Message</button>
                </form>
            </div>
        </div>
        
        <!-- Settings Tab -->
        <div id="settings" class="tab-content">
            <div class="card">
                <h2>Program Settings</h2>
                <form id="settingsForm">
                    <div class="form-group">
                        <label>Program Start Date</label>
                        <input type="date" id="startDate" required>
                    </div>
                    
                    <div class="form-group">
                        <label>Welcome Greeting</label>
                        <textarea id="greeting" rows="4" placeholder="Welcome message that callers hear first..."></textarea>
                    </div>
                    
                    <div class="form-group">
                        <label>Closing Message</label>
                        <textarea id="closing" rows="3" placeholder="Thank you message..."></textarea>
                    </div>
                    
                    <div class="form-group">
                        <label>
                            <input type="checkbox" id="programActive"> Program is Active
                        </label>
                    </div>
                    
                    <button type="submit" class="btn">💾 Save Settings</button>
                </form>
            </div>
        </div>
    </div>
    
    <script>
        let currentMessages = [];
        let currentSettings = {};
        
        // Load initial data
        document.addEventListener('DOMContentLoaded', function() {
            loadMessages();
            loadSettings();
        });
        
        // Tab switching
        function showTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            
            event.target.classList.add('active');
            document.getElementById(tabName).classList.add('active');
        }
        
        // Toggle audio input method
        function toggleAudioInput() {
            const source = document.getElementById('audioSource').value;
            const uploadSection = document.getElementById('uploadSection');
            const urlSection = document.getElementById('urlSection');
            
            if (source === 'upload') {
                uploadSection.style.display = 'block';
                urlSection.style.display = 'none';
            } else {
                uploadSection.style.display = 'none';
                urlSection.style.display = 'block';
            }
        }
        
        // Load messages
        async function loadMessages() {
            try {
                const response = await fetch('/api/messages');
                currentMessages = await response.json();
                renderMessages();
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
                
                // Update stats
                document.getElementById('totalMessages').textContent = currentMessages.length;
                document.getElementById('currentProgramDay').textContent = data.current_program_day;
                document.getElementById('remainingDays').textContent = Math.max(0, 40 - data.current_program_day + 1);
                
                // Update current day display
                document.getElementById('currentDay').innerHTML = 
                    '📅 Today is <strong>Day ' + data.current_program_day + '</strong> of the 40 Days of Nishmas program';
                
                // Populate settings form
                if (currentSettings.program_start_date) {
                    document.getElementById('startDate').value = currentSettings.program_start_date.split('T')[0];
                }
                document.getElementById('greeting').value = currentSettings.greeting_audio || '';
                document.getElementById('closing').value = currentSettings.closing_message || '';
                document.getElementById('programActive').checked = currentSettings.is_program_active;
                
            } catch (error) {
                console.error('Error loading settings:', error);
            }
        }
        
        // Render messages
        function renderMessages() {
            const grid = document.getElementById('messagesGrid');
            
            if (currentMessages.length === 0) {
                grid.innerHTML = '<p style="text-align:center; color:#666; grid-column: 1/-1;">No messages yet. Add your first message!</p>';
                return;
            }
            
            grid.innerHTML = currentMessages.map(msg => 
                '<div class="message-card">' +
                    '<div class="day-badge">Day ' + msg.day_number + '</div>' +
                    '<h3 style="margin: 0 0 1rem; color: #1d1d1f;">' + msg.title + '</h3>' +
                    '<p style="color: #666; margin: 0 0 1rem;">📅 ' + new Date(msg.date_recorded).toLocaleDateString() + '</p>' +
                    (msg.audio_url || msg.recorded_audio ? 
                        '<div style="margin: 1rem 0;"><audio controls style="width: 100%;"><source src="' + (msg.audio_url || '/audio/' + msg.recorded_audio) + '" type="audio/mpeg"></audio></div>' :
                        '<p style="color: #ff9500; font-weight: 500;">⚠️ No audio uploaded</p>') +
                    '<div style="display: flex; gap: 1rem; margin-top: 1rem;">' +
                        '<button class="btn" onclick="editMessage(' + msg.day_number + ')" style="background: #34c759; font-size: 0.875rem; padding: 8px 16px;">✏️ Edit</button>' +
                        '<button class="btn danger" onclick="deleteMessage(' + msg.day_number + ')" style="font-size: 0.875rem; padding: 8px 16px;">🗑️ Delete</button>' +
                    '</div>' +
                '</div>'
            ).join('');
        }
        
        // Edit message
        function editMessage(dayNumber) {
            const message = currentMessages.find(m => m.day_number == dayNumber);
            if (!message) return;
            
            document.getElementById('dayNumber').value = message.day_number;
            document.getElementById('messageTitle').value = message.title;
            
            if (message.audio_url) {
                document.getElementById('audioSource').value = 'url';
                document.getElementById('audioUrl').value = message.audio_url;
                toggleAudioInput();
            }
            
            showTab('add-message');
            document.querySelector('[onclick="showTab(\\'add-message\\')"]').click();
        }
        
        // Delete message
        async function deleteMessage(dayNumber) {
            if (!confirm('Are you sure you want to delete the message for Day ' + dayNumber + '?')) return;
            
            try {
                const response = await fetch('/api/messages/' + dayNumber, { method: 'DELETE' });
                if (response.ok) {
                    alert('Message deleted successfully!');
                    loadMessages();
                } else {
                    alert('Error deleting message');
                }
            } catch (error) {
                alert('Error deleting message');
                console.error(error);
            }
        }
        
        // Handle message form submission
        document.getElementById('messageForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const formData = new FormData();
            formData.append('day_number', document.getElementById('dayNumber').value);
            formData.append('title', document.getElementById('messageTitle').value);
            
            const audioSource = document.getElementById('audioSource').value;
            if (audioSource === 'upload') {
                const audioFile = document.getElementById('audioFile').files[0];
                if (audioFile) {
                    formData.append('audio', audioFile);
                }
            } else {
                formData.append('audio_url', document.getElementById('audioUrl').value);
            }
            
            try {
                const response = await fetch('/api/messages', {
                    method: 'POST',
                    body: formData
                });
                
                if (response.ok) {
                    alert('Message saved successfully!');
                    document.getElementById('messageForm').reset();
                    loadMessages();
                    showTab('messages');
                } else {
                    alert('Error saving message');
                }
            } catch (error) {
                alert('Error saving message');
                console.error(error);
            }
        });
        
        // Handle settings form submission
        document.getElementById('settingsForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const data = {
                program_start_date: document.getElementById('startDate').value,
                greeting_audio: document.getElementById('greeting').value,
                closing_message: document.getElementById('closing').value,
                is_program_active: document.getElementById('programActive').checked
            };
            
            try {
                const response = await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                
                if (response.ok) {
                    alert('Settings saved successfully!');
                    loadSettings();
                } else {
                    alert('Error saving settings');
                }
            } catch (error) {
                alert('Error saving settings');
                console.error(error);
            }
        });
        
        // File upload visual feedback
        document.getElementById('audioFile').addEventListener('change', function(e) {
            const file = e.target.files[0];
            const uploadArea = document.querySelector('.upload-area p');
            if (file) {
                uploadArea.innerHTML = '🎵 Selected: ' + file.name;
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
