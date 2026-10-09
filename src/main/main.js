'use strict';

/**
 * main.js
 * ---------------------------------------------------------------------------
 * عملية Electron الرئيسية (Main Process).
 *
 * مسؤولياتها:
 *   - إنشاء نافذة التطبيق وتحميل الواجهة (Renderer).
 *   - استقبال أوامر المستخدم عبر IPC (بدء/إيقاف التسجيل، الرفع، التفويض...).
 *   - تشغيل وحدة التسجيل (MeetRecorder) وجدولتها.
 *   - رفع التسجيل إلى Google Drive عند الانتهاء.
 *   - بثّ تحديثات الحالة والسجلات إلى الواجهة لتُعلَن لقارئ الشاشة.
 * ---------------------------------------------------------------------------
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const MeetRecorder = require('../automation/meetRecorder');
const Scheduler = require('../automation/scheduler');
const GoogleAuthManager = require('../automation/googleAuth');
const { uploadToDrive } = require('../automation/driveUploader');

// ---------------------------------------------------------------------------
// تحميل متغيّرات البيئة من ملف .env (بدون اعتماديات خارجية).
// ---------------------------------------------------------------------------
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
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    // لا نُفشل الإقلاع بسبب ملف .env.
  }
})();

// ---------------------------------------------------------------------------
// الحالة العامة
// ---------------------------------------------------------------------------
let mainWindow = null;
const scheduler = new Scheduler();

/** @type {MeetRecorder|null} */
let recorder = null;

/** إعدادات الجلسة الحالية. */
let sessionConfig = null;
let autoUpload = false;
let driveFolderId = '';
let endTimerId = null;

/** مدير مصادقة Google. */
const googleAuth = new GoogleAuthManager({
  credentialsPath: path.join(app.getPath('userData'), 'credentials.json'),
  tokenPath: path.join(app.getPath('userData'), 'token.json'),
  openExternal: (url) => shell.openExternal(url),
});

// ---------------------------------------------------------------------------
// مساعدات البثّ إلى الواجهة
// ---------------------------------------------------------------------------

/** إرسال رسالة إلى الواجهة إن كانت النافذة متاحة. */
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** إعلان تغيّر حالة (يُعرض في منطقة aria-live). */
function announce(state, message) {
  send('status:update', { state, message, time: Date.now() });
}

/** إضافة سطر إلى السجل. */
function log(message, level = 'info') {
  send('log:update', { level, message, time: Date.now() });
}

// ---------------------------------------------------------------------------
// إنشاء النافذة
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 820,
    minWidth: 720,
    minHeight: 600,
    title: 'مسجّل صوت Google Meet',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // نُبقي قائمة التطبيق الافتراضية للحفاظ على اختصارات لوحة المفاتيح
  // (نسخ/لصق/تحديد الكل) وهي مهمة لإمكانية الوصول.

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// التحقق من المدخلات
// ---------------------------------------------------------------------------

/** التحقق من صحة رابط Google Meet. */
function isValidMeetUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'meet.google.com' ||
        parsed.hostname.endsWith('.meet.google.com'))
    );
  } catch (err) {
    return false;
  }
}

/** التحقق من الإعدادات القادمة من الواجهة. */
function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('إعدادات غير صالحة.');
  }
  if (!isValidMeetUrl(config.meetUrl)) {
    throw new Error(
      'رابط الاجتماع غير صالح. يجب أن يبدأ بـ https://meet.google.com/'
    );
  }
  if (config.mode === 'schedule') {
    const start = new Date(config.startTime);
    if (Number.isNaN(start.getTime())) {
      throw new Error('وقت البدء غير صالح.');
    }
    if (start.getTime() <= Date.now()) {
      throw new Error('وقت البدء يجب أن يكون في المستقبل.');
    }
    if (config.endTime) {
      const end = new Date(config.endTime);
      if (Number.isNaN(end.getTime())) {
        throw new Error('وقت الانتهاء غير صالح.');
      }
      if (end.getTime() <= start.getTime()) {
        throw new Error('وقت الانتهاء يجب أن يكون بعد وقت البدء.');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// دورة التسجيل
// ---------------------------------------------------------------------------

/** بدء جلسة تسجيل فعلية (تُستدعى مباشرة أو عبر الجدولة). */
async function startSession(config) {
  if (recorder) {
    throw new Error('يوجد تسجيل قيد التشغيل بالفعل.');
  }

  recorder = new MeetRecorder();

  // ربط أحداث الوحدة بواجهة المستخدم.
  recorder.on('status', (s) => announce(s.state, s.message));
  recorder.on('log', (l) => log(l.message, l.level));
  recorder.on('recorded', (info) => {
    announce('recorded', 'تم إنشاء ملف التسجيل.');
    log('تم حفظ التسجيل في: ' + info.outputPath);
    const pathToUpload = info.outputPath;
    recorder = null;

    if (autoUpload) {
      // الرفع يجري في الخلفية دون حجب الواجهة.
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

  return outputPath;
}

/** إعلان خطأ الرفع. */
function announceUploadError(err) {
  const message = 'فشل رفع التسجيل إلى Google Drive: ' + err.message;
  announce('error', message);
  log(message, 'error');
}

/** رفع ملف إلى Google Drive. */
async function uploadRecording(filePath) {
  announce('uploading', 'جاري رفع الملف إلى Google Drive...');
  try {
    const auth = await googleAuth.getClient();
    const data = await uploadToDrive(auth, filePath, { folderId: driveFolderId });
    announce('uploaded', 'تم الرفع بنجاح إلى جوجل درايف.');
    log(`تم رفع الملف: ${data.name} (المعرّف: ${data.id})`);
    if (data.webViewLink) {
      log('رابط الملف على Drive: ' + data.webViewLink);
    }
    return data;
  } catch (err) {
    announceUploadError(err);
    throw err;
  }
}

/** إيقاف أي تسجيل جارٍ وإلغاء المهام المجدولة. */
async function stopSession() {
  scheduler.cancelAll();
  if (endTimerId) {
    scheduler.cancel(endTimerId);
    endTimerId = null;
  }

  if (!recorder) {
    announce('idle', 'لا يوجد تسجيل قيد التشغيل.');
    return null;
  }

  const outputPath = await recorder.stop();
  return outputPath;
}

// ---------------------------------------------------------------------------
// معالجات IPC
// ---------------------------------------------------------------------------

/** بدء/جدولة تسجيل. */
ipcMain.handle('recorder:start', async (event, config) => {
  try {
    validateConfig(config);

    sessionConfig = config;
    autoUpload = !!config.autoUpload;
    driveFolderId = config.folderId || process.env.GDRIVE_FOLDER_ID || '';

    if (config.mode === 'schedule') {
      const startAt = new Date(config.startTime);
      const { delay } = scheduler.scheduleAt(startAt, () => {
        log('حان وقت التسجيل المجدول، جاري البدء...');
        startSession(config).catch((err) => {
          announce('error', 'فشل بدء التسجيل المجدول: ' + err.message);
          log('فشل بدء التسجيل المجدول: ' + err.message, 'error');
        });
      });

      // جدولة الإيقاف عند وقت الانتهاء إن حُدّد.
      if (config.endTime) {
        const endAt = new Date(config.endTime);
        scheduler.scheduleAt(endAt, () => {
          log('حان وقت الإيقاف المجدول، جاري الإيقاف...');
          stopSession().catch((err) => {
            log('فشل الإيقاف المجدول: ' + err.message, 'error');
          });
        });
      }

      const seconds = Math.round(delay / 1000);
      announce(
        'scheduled',
        `تمت جدولة التسجيل في ${startAt.toLocaleString('ar')} (بعد ${seconds} ثانية).`
      );
      log(`تمت جدولة البدء في: ${startAt.toISOString()}`);
      if (config.endTime) {
        log(`تمت جدولة الإيقاف في: ${new Date(config.endTime).toISOString()}`);
      }
      return { ok: true, scheduled: true };
    }

    // الوضع الفوري.
    const outputPath = await startSession(config);

    // إيقاف تلقائي عند وقت الانتهاء إن حُدّد.
    if (config.endTime) {
      const endAt = new Date(config.endTime);
      const job = scheduler.scheduleAt(endAt, () => {
        log('حان وقت الإيقاف، جاري الإيقاف...');
        stopSession().catch(() => {});
      });
      endTimerId = job.id;
      log('سيتم الإيقاف تلقائيًا في: ' + endAt.toISOString());
    }

    return { ok: true, outputPath };
  } catch (err) {
    announce('error', err.message);
    log(err.message, 'error');
    return { ok: false, error: err.message };
  }
});

/** إيقاف التسجيل يدويًا. */
ipcMain.handle('recorder:stop', async () => {
  try {
    const outputPath = await stopSession();
    return { ok: true, outputPath };
  } catch (err) {
    announce('error', 'تعذّر إيقاف التسجيل: ' + err.message);
    log('تعذّر إيقاف التسجيل: ' + err.message, 'error');
    return { ok: false, error: err.message };
  }
});

/** الاتصال بـ Google Drive (تفويض تفاعلي عند الحاجة). */
ipcMain.handle('drive:connect', async () => {
  try {
    announce('auth', 'جاري فتح المتصفح لتفويض الوصول إلى Google Drive...');
    await googleAuth.getClient();
    announce('auth-ok', 'تم الاتصال بـ Google Drive بنجاح.');
    log('تم حفظ تفويض Google Drive بنجاح.');
    return { ok: true };
  } catch (err) {
    announce('error', 'فشل الاتصال بـ Google Drive: ' + err.message);
    log('فشل الاتصال بـ Google Drive: ' + err.message, 'error');
    return { ok: false, error: err.message };
  }
});

/** رفع ملف محدّد يدويًا. */
ipcMain.handle('drive:upload', async (event, { filePath } = {}) => {
  try {
    const data = await uploadRecording(filePath);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** اختيار ملف credentials.json. */
ipcMain.handle('drive:pickCredentials', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'اختر ملف بيانات اعتماد Google (credentials.json)',
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
    announce('auth', 'تم استيراد ملف بيانات الاعتماد بنجاح.');
    log('تم استيراد credentials.json إلى: ' + dest);
    return { ok: true };
  } catch (err) {
    announce('error', 'تعذّر استيراد ملف الاعتماد: ' + err.message);
    return { ok: false, error: err.message };
  }
});

/** اختيار مجلد حفظ التسجيلات. */
ipcMain.handle('files:chooseOutputFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'اختر مجلد حفظ التسجيلات',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }
  return { ok: true, folder: result.filePaths[0] };
});

/** فتح مجلد التسجيلات في مدير الملفات. */
ipcMain.handle('app:openRecordingsFolder', async () => {
  const folder = path.join(app.getPath('userData'), 'recordings');
  fs.mkdirSync(folder, { recursive: true });
  await shell.openPath(folder);
  return { ok: true, folder };
});

/** إرجاع الإعدادات الأولية للواجهة. */
ipcMain.handle('app:getConfig', async () => {
  const defaultOutputDir = path.join(app.getPath('userData'), 'recordings');
  fs.mkdirSync(defaultOutputDir, { recursive: true });
  return {
    ok: true,
    defaultOutputDir,
    credentialsExists:
      fs.existsSync(path.join(app.getPath('userData'), 'credentials.json')) ||
      !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    driveConnected: googleAuth.isConnected(),
    defaultFolderId: process.env.GDRIVE_FOLDER_ID || '',
  };
});

// ---------------------------------------------------------------------------
// دورة حياة التطبيق
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  scheduler.cancelAll();
  if (recorder) {
    try {
      await recorder.stop();
    } catch (err) {
      // تجاهل
    }
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// تنظيف عند الإغلاق.
app.on('before-quit', async () => {
  scheduler.cancelAll();
  if (recorder) {
    try {
      await recorder.stop();
    } catch (err) {
      // تجاهل
    }
  }
});
