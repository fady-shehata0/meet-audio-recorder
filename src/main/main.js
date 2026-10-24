'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const MeetRecorder = require('../automation/meetRecorder');
const Scheduler = require('../automation/scheduler');
const GoogleAuthManager = require('../automation/googleAuth');
const { uploadToDrive } = require('../automation/driveUploader');

(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    // Ignore .env issues during startup
  }
})();

const APP_ID = 'com.fady.meetrecorder.pro';
let mainWindow = null;
let tray = null;
let appQuitting = false;
const scheduler = new Scheduler();
let recorder = null;
let sessionConfig = null;
let autoUpload = false;
let driveFolderId = '';
let endTimerId = null;
let latestRecordingPath = null;

app.setAppUserModelId(APP_ID);

const googleAuth = new GoogleAuthManager({
  credentialsPath: path.join(app.getPath('userData'), 'credentials.json'),
  tokenPath: path.join(app.getPath('userData'), 'token.json'),
  openExternal: (url) => shell.openExternal(url),
});

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function announce(state, message) {
  send('status:update', { state, message, time: Date.now() });
}

function log(message, level = 'info') {
  send('log:update', { level, message, time: Date.now() });
}

function getIconPath() {
  return path.join(__dirname, '..', '..', 'build', 'icon.png');
}

function createTray() {
  if (tray) return;

  const icon = getIconPath();
  if (!fs.existsSync(icon)) return;

  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open app', click: () => showWindow() },
    { label: 'Open recordings folder', click: () => openRecordingsFolder() },
    { type: 'separator' },
    { label: 'Quit', click: () => { appQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('Meet Recorder Pro');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => showWindow());
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 900,
    minHeight: 720,
    backgroundColor: '#0b1020',
    title: 'Meet Recorder Pro',
    icon: getIconPath(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('minimize', (event) => {
    if (!appQuitting) {
      event.preventDefault();
      hideWindow();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getLatestRecording() {
  const folder = path.join(app.getPath('userData'), 'recordings');
  if (!fs.existsSync(folder)) return null;

  const files = fs
    .readdirSync(folder)
    .filter((name) => /\.(webm|mp3|wav|m4a)$/i.test(name))
    .map((name) => ({
      name,
      path: path.join(folder, name),
      mtimeMs: fs.statSync(path.join(folder, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files[0] ? files[0].path : null;
}

function isValidMeetUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'meet.google.com' || parsed.hostname.endsWith('.meet.google.com'))
    );
  } catch (err) {
    return false;
  }
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid configuration.');
  }
  if (!isValidMeetUrl(config.meetUrl)) {
    throw new Error('Google Meet link is invalid. It must start with https://meet.google.com/');
  }

  if (config.mode === 'schedule') {
    const start = new Date(config.startTime);
    if (Number.isNaN(start.getTime())) {
      throw new Error('Invalid start time.');
    }
    if (start.getTime() <= Date.now()) {
      throw new Error('Start time must be in the future.');
    }

    if (config.endTime) {
      const end = new Date(config.endTime);
      if (Number.isNaN(end.getTime())) {
        throw new Error('Invalid end time.');
      }
      if (end.getTime() <= start.getTime()) {
        throw new Error('The end time must be after the start time.');
      }
    }
  }
}

async function startSession(config) {
  if (recorder) {
    throw new Error('A recording is already running.');
  }

  recorder = new MeetRecorder();
  recorder.on('status', (s) => announce(s.state, s.message));
  recorder.on('log', (l) => log(l.message, l.level));
  recorder.on('recorded', (info) => {
    latestRecordingPath = info.outputPath;
    announce('recorded', 'Recording generated successfully.');
    log('Saved recording to: ' + info.outputPath);
    const pathToUpload = info.outputPath;
    recorder = null;

    if (autoUpload) {
      uploadRecording(pathToUpload).catch((err) => {
        announceUploadError(err);
      });
    }
  });

  const defaultOutputDir = path.join(app.getPath('userData'), 'recordings');
  const { outputPath } = await recorder.start({
    meetUrl: config.meetUrl,
    displayName: config.displayName,
    headless: !!config.headless,
    outputDir: config.outputDir || defaultOutputDir,
    muteMic: true,
    cameraOff: true,
  });

  latestRecordingPath = outputPath;
  return outputPath;
}

function announceUploadError(err) {
  const message = 'Failed to upload recording to Google Drive: ' + err.message;
  announce('error', message);
  log(message, 'error');
}

async function uploadRecording(filePath) {
  announce('uploading', 'Uploading file to Google Drive...');
  try {
    const auth = await googleAuth.getClient();
    const data = await uploadToDrive(auth, filePath, { folderId: driveFolderId });
    announce('uploaded', 'File uploaded successfully to Google Drive.');
    log(`Uploaded file: ${data.name} (ID: ${data.id})`);
    if (data.webViewLink) {
      log('Drive file link: ' + data.webViewLink);
    }
    return data;
  } catch (err) {
    announceUploadError(err);
    throw err;
  }
}

async function stopSession() {
  scheduler.cancelAll();
  if (endTimerId) {
    scheduler.cancel(endTimerId);
    endTimerId = null;
  }

  if (!recorder) {
    announce('idle', 'No recording is currently active.');
    return null;
  }

  const outputPath = await recorder.stop();
  latestRecordingPath = outputPath || latestRecordingPath;
  return outputPath;
}

ipcMain.handle('recorder:start', async (event, config) => {
  try {
    validateConfig(config);
    sessionConfig = config;
    autoUpload = !!config.autoUpload;
    driveFolderId = config.folderId || process.env.GDRIVE_FOLDER_ID || '';

    if (config.mode === 'schedule') {
      const startAt = new Date(config.startTime);
      const scheduleJob = scheduler.scheduleAt(startAt, () => {
        log('Scheduled recording time reached, starting now...');
        startSession(config).catch((err) => {
          announce('error', 'Scheduled recording failed: ' + err.message);
          log('Scheduled recording failed: ' + err.message, 'error');
        });
      });

      if (config.endTime) {
        const endAt = new Date(config.endTime);
        scheduler.scheduleAt(endAt, () => {
          log('Scheduled stop time reached, stopping recording...');
          stopSession().catch((err) => {
            log('Scheduled stop failed: ' + err.message, 'error');
          });
        });
      }

      const seconds = Math.round(scheduleJob.delay / 1000);
      announce('scheduled', `Recording scheduled for ${startAt.toLocaleString('en')} (${seconds} seconds from now).`);
      log(`Scheduled start at: ${startAt.toISOString()}`);
      if (config.endTime) {
        log(`Scheduled stop at: ${new Date(config.endTime).toISOString()}`);
      }
      return { ok: true, scheduled: true };
    }

    const outputPath = await startSession(config);

    if (config.endTime) {
      const endAt = new Date(config.endTime);
      const job = scheduler.scheduleAt(endAt, () => {
        log('Auto-stop time reached, stopping recording...');
        stopSession().catch(() => {});
      });
      endTimerId = job.id;
      log('Will stop automatically at: ' + endAt.toISOString());
    }

    return { ok: true, outputPath };
  } catch (err) {
    announce('error', err.message);
    log(err.message, 'error');
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('recorder:stop', async () => {
  try {
    const outputPath = await stopSession();
    return { ok: true, outputPath };
  } catch (err) {
    announce('error', 'Failed to stop recording: ' + err.message);
    log('Failed to stop recording: ' + err.message, 'error');
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('drive:connect', async () => {
  try {
    announce('auth', 'Opening browser to authorize Google Drive access...');
    await googleAuth.getClient();
    announce('auth-ok', 'Google Drive connection successful.');
    log('Google Drive authorization saved successfully.');
    return { ok: true };
  } catch (err) {
    announce('error', 'Failed to connect to Google Drive: ' + err.message);
    log('Failed to connect to Google Drive: ' + err.message, 'error');
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('drive:upload', async (event, { filePath } = {}) => {
  try {
    const data = await uploadRecording(filePath);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('drive:pickCredentials', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Google credentials file (credentials.json)',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }

  try {
    const source = result.filePaths[0];
    const dest = path.join(app.getPath('userData'), 'credentials.json');
    fs.copyFileSync(source, dest);
    announce('auth', 'Credentials file imported successfully.');
    log('credentials.json imported to: ' + dest);
    return { ok: true };
  } catch (err) {
    announce('error', 'Failed to import credentials: ' + err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('files:chooseOutputFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose recordings folder',
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }

  return { ok: true, folder: result.filePaths[0] };
});

async function openRecordingsFolder() {
  const folder = path.join(app.getPath('userData'), 'recordings');
  fs.mkdirSync(folder, { recursive: true });
  await shell.openPath(folder);
  return folder;
}

ipcMain.handle('app:openRecordingsFolder', async () => {
  const folder = await openRecordingsFolder();
  return { ok: true, folder };
});

ipcMain.handle('app:openLatestRecording', async () => {
  const filePath = latestRecordingPath || getLatestRecording();
  if (!filePath) return { ok: false, error: 'No recording available yet.' };

  try {
    await shell.openPath(filePath);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:getConfig', async () => {
  const defaultOutputDir = path.join(app.getPath('userData'), 'recordings');
  fs.mkdirSync(defaultOutputDir, { recursive: true });

  const latest = latestRecordingPath || getLatestRecording();

  return {
    ok: true,
    defaultOutputDir,
    latestRecordingPath: latest,
    latestRecordingName: latest ? path.basename(latest) : '',
    credentialsExists:
      fs.existsSync(path.join(app.getPath('userData'), 'credentials.json')) ||
      !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    driveConnected: googleAuth.isConnected(),
    defaultFolderId: process.env.GDRIVE_FOLDER_ID || '',
    version: app.getVersion(),
  };
});

ipcMain.handle('app:getVersion', async () => ({ ok: true, version: app.getVersion() }));
ipcMain.handle('app:toggleWindow', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return { ok: true, visible: true };
  }

  if (mainWindow.isVisible()) {
    hideWindow();
    return { ok: true, visible: false };
  }

  showWindow();
  return { ok: true, visible: true };
});

app.whenReady().then(() => {
  createTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      showWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  scheduler.cancelAll();
  if (recorder) {
    try {
      await recorder.stop();
    } catch (err) {
      // Ignore
    }
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  appQuitting = true;
  scheduler.cancelAll();
  if (recorder) {
    try {
      await recorder.stop();
    } catch (err) {
      // Ignore
    }
  }
});
