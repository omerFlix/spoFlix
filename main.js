/* ============================================
   SPOFLIX - Electron Ana Süreci
   Yerel sunucuyu başlatır ve uygulamayı bir
   masaüstü penceresinde gösterir.
   ============================================ */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('./server');

// Ses motoru ve iframe Web Audio API erişimi için Chromium bayrakları
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('disable-features', 'OutOfProcessIframe');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-web-security');

const PORT = 45678;

let mainWindow = null;
let currentBoostMultiplier = 1.0;
let currentAudioMode = 'normal';

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'SpoFlix - Müzik Dinle',
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0a',
    show: false,
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      allowRunningInsecureContent: true
    }
  });

  mainWindow.loadURL(url);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Yeni frame yüklendiğinde mevcut boost seviyesini otomatik uygula
  mainWindow.webContents.on('did-frame-finish-load', () => {
    applyBoostToAllFrames(currentBoostMultiplier, currentAudioMode);
  });
}

function applyBoostToAllFrames(multiplier, mode) {
  if (!mainWindow || !mainWindow.webContents) return;
  currentBoostMultiplier = multiplier;
  currentAudioMode = mode;
  try {
    const frames = mainWindow.webContents.mainFrame.frames;
    for (const frame of frames) {
      frame.executeJavaScript(`
        (() => {
          try {
            const video = document.querySelector('video');
            if (!video) return;
            if (!window._spoflixCtx) {
              const AudioCtx = window.AudioContext || window.webkitAudioContext;
              window._spoflixCtx = new AudioCtx();
              window._spoflixSource = window._spoflixCtx.createMediaElementSource(video);
              window._spoflixGain = window._spoflixCtx.createGain();
              window._spoflixBass = window._spoflixCtx.createBiquadFilter();
              window._spoflixBass.type = 'lowshelf';
              window._spoflixBass.frequency.value = 140;

              window._spoflixCompressor = window._spoflixCtx.createDynamicsCompressor();
              window._spoflixCompressor.threshold.value = -1.5;
              window._spoflixCompressor.knee.value = 15;
              window._spoflixCompressor.ratio.value = 8;
              window._spoflixCompressor.attack.value = 0.003;
              window._spoflixCompressor.release.value = 0.15;

              window._spoflixSource.connect(window._spoflixBass);
              window._spoflixBass.connect(window._spoflixGain);
              window._spoflixGain.connect(window._spoflixCompressor);
              window._spoflixCompressor.connect(window._spoflixCtx.destination);
            }
            if (window._spoflixCtx.state === 'suspended') {
              window._spoflixCtx.resume();
            }
            window._spoflixGain.gain.value = ${multiplier};
            if ('${mode}' === 'bass') {
              window._spoflixBass.gain.value = 15;
            } else {
              window._spoflixBass.gain.value = 0;
            }
          } catch (e) {}
        })();
      `).catch(() => {});
    }
  } catch (e) {}
}

ipcMain.on('set-volume-boost', (event, data) => {
  const mult = data?.multiplier || 1.0;
  const mode = data?.mode || 'normal';
  applyBoostToAllFrames(mult, mode);
});

function getIconPath() {
  const ico = path.join(__dirname, 'icon.ico');
  const png = path.join(__dirname, 'icon.png');
  if (fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return undefined;
}

app.whenReady().then(async () => {
  try {
    const { url } = await startServer(PORT);
    createWindow(url);
  } catch (e) {
    console.error('SpoFlix sunucusu başlatılamadı:', e);
    if (!mainWindow) {
      app.quit();
    }
  }
});

// Tüm pencereler kapanınca uygulamayı kapat (macOS hariç)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});