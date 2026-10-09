'use strict';

/**
 * renderer.js
 * ---------------------------------------------------------------------------
 * منطق الواجهة (Renderer Process).
 *
 * يتواصل مع عملية Main عبر واجهة window.api الآمنة (انظر preload.js)،
 * ويحدّث مناطق aria-live لإعلان التغيّرات لمستخدمي قارئات الشاشة.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// المراجع إلى عناصر الواجهة
// ---------------------------------------------------------------------------
const els = {
  form: document.getElementById('record-form'),
  meetUrl: document.getElementById('meet-url'),
  meetUrlError: document.getElementById('meet-url-error'),
  displayName: document.getElementById('display-name'),
  modeNow: document.getElementById('mode-now'),
  modeSchedule: document.getElementById('mode-schedule'),
  scheduleFields: document.getElementById('schedule-fields'),
  startTime: document.getElementById('start-time'),
  endTime: document.getElementById('end-time'),
  headless: document.getElementById('headless'),
  autoUpload: document.getElementById('auto-upload'),
  driveFolder: document.getElementById('drive-folder'),
  outputFolder: document.getElementById('output-folder'),
  chooseFolderBtn: document.getElementById('choose-folder-btn'),
  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  connectDriveBtn: document.getElementById('connect-drive-btn'),
  importCredentialsBtn: document.getElementById('import-credentials-btn'),
  openRecordingsBtn: document.getElementById('open-recordings-btn'),
  statusRegion: document.getElementById('status-region'),
  errorRegion: document.getElementById('error-region'),
  logRegion: document.getElementById('log-region'),
};

// ---------------------------------------------------------------------------
// أدوات مساعدة
// ---------------------------------------------------------------------------

/** تحديث منطقة الحالة (تُعلَن بلطف من قارئ الشاشة). */
function setStatus(message) {
  els.statusRegion.textContent = message;
}

/** إظهار/إخفاء منطقة الخطأ (تُعلَن فورًا). */
function setError(message) {
  if (message) {
    els.errorRegion.textContent = message;
    els.errorRegion.hidden = false;
  } else {
    els.errorRegion.textContent = '';
    els.errorRegion.hidden = true;
  }
}

/** إضافة سطر إلى السجل. */
function addLog(message, level = 'info') {
  const li = document.createElement('li');
  li.className = level;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('ar');

  const text = document.createElement('span');
  text.textContent = ' ' + message;

  li.appendChild(time);
  li.appendChild(text);
  els.logRegion.appendChild(li);

  // الحفاظ على حجم السجل معقولًا.
  while (els.logRegion.children.length > 300) {
    els.logRegion.removeChild(els.logRegion.firstChild);
  }
  els.logRegion.scrollTop = els.logRegion.scrollHeight;
}

/** إظهار رسالة خطأ في حقل رابط الاجتماع وإدارته لقارئ الشاشة. */
function setUrlError(message) {
  if (message) {
    els.meetUrlError.textContent = message;
    els.meetUrlError.hidden = false;
    els.meetUrl.setAttribute('aria-invalid', 'true');
  } else {
    els.meetUrlError.textContent = '';
    els.meetUrlError.hidden = true;
    els.meetUrl.removeAttribute('aria-invalid');
  }
}

/** تغيير حالة الأزرار أثناء التشغيل. */
function setBusy(isBusy) {
  els.form.setAttribute('aria-busy', isBusy ? 'true' : 'false');
}

/** ضبط أزرار البدء/الإيقاف حسب الحالة. */
function setButtonsForState(state) {
  const isRunning = state === 'recording' || state === 'scheduled';
  els.stopBtn.disabled = !isRunning;
  els.startBtn.disabled = isRunning;
}

// ---------------------------------------------------------------------------
// التحقق من المدخلات
// ---------------------------------------------------------------------------

/** هل الرابط يخص Google Meet؟ */
function isValidMeetUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'meet.google.com' || url.hostname.endsWith('.meet.google.com'))
    );
  } catch (err) {
    return false;
  }
}

/** التحقق من النموذج كاملًا. @returns {boolean} */
function validateForm() {
  setUrlError('');

  if (!els.meetUrl.value.trim()) {
    setUrlError('الرجاء إدخال رابط اجتماع Google Meet.');
    els.meetUrl.focus();
    return false;
  }
  if (!isValidMeetUrl(els.meetUrl.value.trim())) {
    setUrlError(
      'الرابط غير صالح. يجب أن يكون رابط Google Meet يبدأ بـ https://meet.google.com/'
    );
    els.meetUrl.focus();
    return false;
  }

  if (els.modeSchedule.checked) {
    if (!els.startTime.value) {
      setStatus('الرجاء تحديد وقت البدء للتسجيل المجدول.');
      setError('وقت البدء مطلوب في وضع الجدولة.');
      els.startTime.focus();
      return false;
    }
    const start = new Date(els.startTime.value);
    if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) {
      setError('وقت البدء يجب أن يكون في المستقبل.');
      els.startTime.focus();
      return false;
    }
    if (els.endTime.value) {
      const end = new Date(els.endTime.value);
      if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
        setError('وقت الانتهاء يجب أن يكون بعد وقت البدء.');
        els.endTime.focus();
        return false;
      }
    }
  } else if (els.endTime.value) {
    const end = new Date(els.endTime.value);
    if (Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) {
      setError('وقت الانتهاء (للتسجيل الفوري) يجب أن يكون في المستقبل.');
      els.endTime.focus();
      return false;
    }
  }

  setError('');
  return true;
}

// ---------------------------------------------------------------------------
// ربط الأحداث
// ---------------------------------------------------------------------------

/** إظهار/إخفاء حقول الجدولة حسب الاختيار. */
function updateScheduleVisibility() {
  const isSchedule = els.modeSchedule.checked;
  els.scheduleFields.hidden = !isSchedule;
  // تعطيل الحقول المخفية لمنع الوصول إليها بلوحة المفاتيح.
  els.startTime.disabled = !isSchedule;
  els.endTime.disabled = !isSchedule;
}

els.modeNow.addEventListener('change', updateScheduleVisibility);
els.modeSchedule.addEventListener('change', updateScheduleVisibility);

// إرسال النموذج: بدء أو جدولة التسجيل.
els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!validateForm()) {
    return;
  }

  const config = {
    meetUrl: els.meetUrl.value.trim(),
    displayName: els.displayName.value.trim() || 'مسجّل الاجتماع',
    mode: els.modeSchedule.checked ? 'schedule' : 'now',
    startTime: els.startTime.value || null,
    endTime: els.endTime.value || null,
    headless: els.headless.checked,
    autoUpload: els.autoUpload.checked,
    folderId: els.driveFolder.value.trim() || null,
    outputDir: els.outputFolder.value.trim() || null,
  };

  setError('');
  setBusy(true);
  setStatus('جاري تجهيز التسجيل...');

  try {
    const result = await window.api.startRecording(config);
    if (!result || !result.ok) {
      setError((result && result.error) || 'تعذّر بدء التسجيل.');
      setStatus('فشل بدء التسجيل.');
      setButtonsForState('idle');
    } else if (result.scheduled) {
      setStatus('تمت جدولة التسجيل بنجاح.');
      setButtonsForState('scheduled');
    } else {
      setStatus('بدأ التسجيل الآن.');
      setButtonsForState('recording');
    }
  } catch (err) {
    setError('حدث خطأ غير متوقع: ' + err.message);
    setStatus('فشل بدء التسجيل.');
    setButtonsForState('idle');
  } finally {
    setBusy(false);
  }
});

// إيقاف التسجيل.
els.stopBtn.addEventListener('click', async () => {
  setStatus('جاري إيقاف التسجيل...');
  els.stopBtn.disabled = true;
  try {
    const result = await window.api.stopRecording();
    if (!result || !result.ok) {
      setError((result && result.error) || 'تعذّر إيقاف التسجيل.');
    } else {
      setStatus('تم إيقاف التسجيل.');
    }
  } catch (err) {
    setError('تعذّر إيقاف التسجيل: ' + err.message);
  } finally {
    setButtonsForState('idle');
  }
});

// الاتصال بـ Google Drive.
els.connectDriveBtn.addEventListener('click', async () => {
  setStatus('جاري الاتصال بـ Google Drive...');
  els.connectDriveBtn.disabled = true;
  try {
    const result = await window.api.connectDrive();
    if (!result || !result.ok) {
      setError((result && result.error) || 'فشل الاتصال بـ Google Drive.');
    } else {
      setStatus('تم الاتصال بـ Google Drive بنجاح.');
    }
  } catch (err) {
    setError('فشل الاتصال: ' + err.message);
  } finally {
    els.connectDriveBtn.disabled = false;
  }
});

// استيراد ملف credentials.json.
els.importCredentialsBtn.addEventListener('click', async () => {
  try {
    const result = await window.api.pickCredentials();
    if (result && result.canceled) {
      setStatus('تم إلغاء استيراد ملف الاعتماد.');
    } else if (result && result.ok) {
      setStatus('تم استيراد ملف بيانات الاعتماد بنجاح.');
    } else {
      setError((result && result.error) || 'تعذّر استيراد الملف.');
    }
  } catch (err) {
    setError('تعذّر استيراد الملف: ' + err.message);
  }
});

// اختيار مجلد الحفظ.
els.chooseFolderBtn.addEventListener('click', async () => {
  try {
    const result = await window.api.chooseOutputFolder();
    if (result && result.ok && result.folder) {
      els.outputFolder.value = result.folder;
      setStatus('تم اختيار مجلد الحفظ: ' + result.folder);
    } else if (result && result.canceled) {
      setStatus('تم إلغاء اختيار المجلد.');
    }
  } catch (err) {
    setError('تعذّر اختيار المجلد: ' + err.message);
  }
});

// فتح مجلد التسجيلات.
els.openRecordingsBtn.addEventListener('click', async () => {
  try {
    await window.api.openRecordingsFolder();
  } catch (err) {
    setError('تعذّر فتح المجلد: ' + err.message);
  }
});

// ---------------------------------------------------------------------------
// الاستماع لأحداث عملية Main
// ---------------------------------------------------------------------------

window.api.onStatus((payload) => {
  if (!payload) return;

  // إعلان الرسالة القادمة من الخلفية.
  setStatus(payload.message || '');

  // إظهار رسائل الخطأ في منطقة التنبيه الفوري.
  if (payload.state === 'error') {
    setError(payload.message || 'حدث خطأ.');
  } else if (payload.state === 'recorded' || payload.state === 'uploaded') {
    setError('');
  }

  // ضبط حالة الأزرار بناءً على الحالة.
  if (payload.state === 'recording') {
    setButtonsForState('recording');
  } else if (payload.state === 'scheduled' || payload.state === 'waiting' || payload.state === 'joining') {
    setButtonsForState('scheduled');
  } else if (
    payload.state === 'stopped' ||
    payload.state === 'recorded' ||
    payload.state === 'idle' ||
    payload.state === 'error'
  ) {
    setButtonsForState('idle');
  }
});

window.api.onLog((payload) => {
  if (!payload) return;
  addLog(payload.message, payload.level || 'info');
});

// ---------------------------------------------------------------------------
// التهيئة الأولية
// ---------------------------------------------------------------------------
async function initialize() {
  updateScheduleVisibility();
  setButtonsForState('idle');

  try {
    const config = await window.api.getConfig();
    if (config && config.ok) {
      els.outputFolder.value = config.defaultOutputDir || '';
      if (config.defaultFolderId) {
        els.driveFolder.value = config.defaultFolderId;
      }
      if (config.driveConnected) {
        addLog('حساب Google Drive متصل مسبقًا.');
      }
      if (!config.credentialsExists) {
        addLog(
          'تنبيه: لم يتم العثور على بيانات اعتماد Google. استخدم زر "استيراد ملف بيانات الاعتماد" أو ملف .env.',
          'warn'
        );
      }
    }
  } catch (err) {
    addLog('تعذّر تحميل الإعدادات الأولية: ' + err.message, 'error');
  }

  setStatus('جاهز للبدء.');
}

initialize();
