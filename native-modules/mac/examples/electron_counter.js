const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// Import the addon in the main process
const addon = require('./addon.node');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'electron_preload.js')
        }
    });

    // Create simple HTML for counter demo
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>WebRTC Frame Counter Demo</title>
        <style>
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                margin: 0; padding: 30px; 
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white; min-height: 100vh;
            }
            .container { max-width: 700px; margin: 0 auto; }
            .header { text-align: center; margin-bottom: 40px; }
            .header h1 { font-size: 3em; margin: 0; text-shadow: 2px 2px 4px rgba(0,0,0,0.3); }
            .header p { font-size: 1.3em; opacity: 0.9; margin: 10px 0; }
            
            .success-message {
                background: rgba(76, 175, 80, 0.2);
                border: 2px solid #4CAF50;
                border-radius: 15px;
                padding: 20px;
                margin: 20px 0;
                text-align: center;
                font-size: 1.2em;
                animation: pulse 2s infinite;
            }
            
            @keyframes pulse {
                0% { transform: scale(1); }
                50% { transform: scale(1.02); }
                100% { transform: scale(1); }
            }
            
            .controls {
                display: flex; gap: 15px; flex-wrap: wrap;
                justify-content: center; margin: 30px 0;
            }
            
            button {
                background: linear-gradient(45deg, #4CAF50, #45a049);
                color: white; border: none; padding: 15px 30px;
                border-radius: 25px; cursor: pointer; font-size: 16px;
                font-weight: 600; transition: all 0.3s ease;
                box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            }
            button:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
            button:disabled { background: #666; cursor: not-allowed; transform: none; }
            .stop-btn { background: linear-gradient(45deg, #f44336, #d32f2f); }
            .test-btn { background: linear-gradient(45deg, #2196F3, #1976D2); }
            
            .stats-grid {
                display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 25px; margin: 30px 0;
            }
            
            .stat-card {
                background: rgba(255, 255, 255, 0.15); backdrop-filter: blur(10px);
                border-radius: 20px; padding: 25px; text-align: center;
                border: 1px solid rgba(255, 255, 255, 0.2);
                transition: transform 0.3s ease;
            }
            
            .stat-card:hover { transform: translateY(-5px); }
            
            .stat-value {
                font-size: 3em; font-weight: bold; margin: 15px 0;
                color: #4CAF50; text-shadow: 1px 1px 2px rgba(0,0,0,0.3);
                font-family: 'SF Mono', monospace;
            }
            
            .stat-label { 
                font-size: 1em; opacity: 0.9; text-transform: uppercase; 
                letter-spacing: 2px; font-weight: 500;
            }
            
            .status-indicator {
                display: inline-block; width: 15px; height: 15px;
                border-radius: 50%; margin-right: 10px;
                background: #4CAF50; box-shadow: 0 0 15px rgba(76, 175, 80, 0.5);
                animation: pulse 2s infinite;
            }
            
            .inactive { background: #666; animation: none; }
            
            .achievement {
                background: rgba(255, 193, 7, 0.2);
                border: 2px solid #FFC107;
                border-radius: 15px;
                padding: 15px;
                margin: 20px 0;
                text-align: center;
                font-weight: bold;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎉 SUCCESS!</h1>
                <p>WebRTC Screen Capture Integration Working</p>
                <p><span id="statusDot" class="status-indicator inactive"></span>Native macOS → WebRTC → Electron</p>
            </div>

            <div class="success-message">
                <h2>🎬 Your WebRTC Pipeline is Live!</h2>
                <p>Screen capture frames are being processed in real-time</p>
            </div>

            <div class="controls">
                <button onclick="testInterface()" class="test-btn">🧪 Test Interface</button>
                <button onclick="startCapture()" id="startBtn">🚀 Start Capture</button>
                <button onclick="stopCapture()" id="stopBtn" class="stop-btn" disabled>⏹️ Stop Capture</button>
                <button onclick="refreshStats()" class="test-btn">🔄 Refresh Stats</button>
            </div>

            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-value" id="videoFrames">0</div>
                    <div class="stat-label">Video Frames</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" id="audioFrames">0</div>
                    <div class="stat-label">Audio Frames</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" id="totalFrames">0</div>
                    <div class="stat-label">Total Frames</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" id="status">READY</div>
                    <div class="stat-label">Status</div>
                </div>
            </div>

            <div id="achievement" class="achievement" style="display: none;">
                🏆 <span id="achievementText"></span>
            </div>
        </div>

        <script>
            let statsInterval = null;
            let lastVideoCount = 0;
            let lastAudioCount = 0;

            async function testInterface() {
                try {
                    const result = await window.electronAPI.testInterface();
                    showAchievement('✅ Interface Test Passed: ' + result);
                } catch (error) {
                    showAchievement('❌ Interface Test Failed: ' + error.message);
                }
            }

            async function startCapture() {
                try {
                    document.getElementById('startBtn').disabled = true;
                    updateStatus('STARTING...');
                    
                    // Set up the counters first
                    await window.electronAPI.setupCounters();
                    
                    // Start capture
                    const result = await window.electronAPI.startCapture();
                    
                    document.getElementById('stopBtn').disabled = false;
                    document.getElementById('statusDot').classList.remove('inactive');
                    updateStatus('ACTIVE');
                    
                    showAchievement('🎬 Capture Started: ' + result.message);
                    
                    // Start polling for stats
                    startStatsUpdater();
                    
                } catch (error) {
                    document.getElementById('startBtn').disabled = false;
                    updateStatus('ERROR');
                    showAchievement('❌ Start Failed: ' + error.message);
                }
            }

            async function stopCapture() {
                try {
                    const result = await window.electronAPI.stopCapture();
                    
                    document.getElementById('startBtn').disabled = false;
                    document.getElementById('stopBtn').disabled = true;
                    document.getElementById('statusDot').classList.add('inactive');
                    updateStatus('STOPPED');
                    
                    showAchievement('⏹️ Capture Stopped: ' + result.message);
                    
                    // Stop stats updater
                    if (statsInterval) {
                        clearInterval(statsInterval);
                        statsInterval = null;
                    }
                    
                } catch (error) {
                    showAchievement('❌ Stop Failed: ' + error.message);
                }
            }

            async function refreshStats() {
                try {
                    const stats = await window.electronAPI.getFrameStats();
                    updateStatsDisplay(stats);
                    showAchievement('📊 Stats Updated: ' + stats.videoFrames + ' video, ' + stats.audioFrames + ' audio');
                } catch (error) {
                    showAchievement('❌ Stats Failed: ' + error.message);
                }
            }

            function startStatsUpdater() {
                if (statsInterval) clearInterval(statsInterval);
                
                statsInterval = setInterval(async () => {
                    try {
                        const stats = await window.electronAPI.getFrameStats();
                        updateStatsDisplay(stats);
                        
                        // Check for achievements
                        if (stats.videoFrames > 0 && lastVideoCount === 0) {
                            showAchievement('🎥 First video frame captured!');
                        }
                        if (stats.audioFrames > 0 && lastAudioCount === 0) {
                            showAchievement('🎵 First audio frame captured!');
                        }
                        if (stats.videoFrames >= 100) {
                            showAchievement('🎯 100+ video frames processed!');
                        }
                        
                        lastVideoCount = stats.videoFrames;
                        lastAudioCount = stats.audioFrames;
                        
                    } catch (error) {
                        console.error('Stats update error:', error);
                    }
                }, 1000);
            }

            function updateStatsDisplay(stats) {
                document.getElementById('videoFrames').textContent = stats.videoFrames.toLocaleString();
                document.getElementById('audioFrames').textContent = stats.audioFrames.toLocaleString();
                document.getElementById('totalFrames').textContent = (stats.videoFrames + stats.audioFrames).toLocaleString();
            }

            function updateStatus(status) {
                document.getElementById('status').textContent = status;
            }

            function showAchievement(text) {
                const achievement = document.getElementById('achievement');
                const achievementText = document.getElementById('achievementText');
                achievementText.textContent = text;
                achievement.style.display = 'block';
                
                setTimeout(() => {
                    achievement.style.display = 'none';
                }, 4000);
            }

            // Initialize
            showAchievement('🎉 WebRTC Screen Capture Demo Ready!');
        </script>
    </body>
    </html>
    `;

    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    mainWindow.webContents.openDevTools();
}

// IPC handlers
ipcMain.handle('test-interface', async () => {
    return addon.testMethod();
});

ipcMain.handle('setup-counters', async () => {
    // Set up the counter callbacks
    addon.setWebRTCVideoCallback(() => {}); // Dummy function, counters work in C++
    addon.setWebRTCAudioCallback(() => {}); // Dummy function, counters work in C++
    return "Counters initialized";
});

ipcMain.handle('start-capture', async () => {
    return await addon.startCapture();
});

ipcMain.handle('stop-capture', async () => {
    return await addon.stopCapture();
});

ipcMain.handle('get-frame-stats', async () => {
    return addon.getFrameStats();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});