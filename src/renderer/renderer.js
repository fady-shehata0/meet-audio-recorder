'use strict';

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
  openLatestBtn: document.getElementById('open-latest-btn'),
  statusRegion: document.getElementById('status-region'),
  errorRegion: document.getElementById('error-region'),
  logRegion: document.getElementById('log-region'),
  recentRecordings: document.getElementById('recent-recordings'),
  version: document.getElementById('app-version'),
};

function setStatus(message) {
  els.statusRegion.textContent = message;
}

function setError(message) {
  if (message) {
    els.errorRegion.textContent = message;
    els.errorRegion.hidden = false;
  } else {
    els.errorRegion.textContent = '';
    els.errorRegion.hidden = true;
  }
}

function addLog(message, level = 'info') {
  const li = document.createElement('li');
  li.className = level;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('en');

  const text = document.createElement('span');
  text.textContent = ' ' + message;

  li.appendChild(time);
  li.appendChild(text);
  els.logRegion.appendChild(li);

  while (els.logRegion.children.length > 300) {
    els.logRegion.removeChild(els.logRegion.firstChild);
  }
  els.logRegion.scrollTop = els.logRegion.scrollHeight;
}

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

function setBusy(isBusy) {
  els.form.setAttribute('aria-busy', isBusy ? 'true' : 'false');
}

function setButtonsForState(state) {
  const isRunning = state === 'recording' || state === 'scheduled';
  els.stopBtn.disabled = !isRunning;
  els.startBtn.disabled = isRunning;
}

function isValidMeetUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'meet.google.com' || url.hostname.endsWith('.meet.google.com'));
  } catch (err) {
    return false;
  }
}

function validateForm() {
  setUrlError('');

  if (!els.meetUrl.value.trim()) {
    setUrlError('Please enter the Google Meet link.');
    els.meetUrl.focus();
    return false;
  }

  if (!isValidMeetUrl(els.meetUrl.value.trim())) {
    setUrlError('Invalid link. It must be a Google Meet URL starting with https://meet.google.com/');
    els.meetUrl.focus();
    return false;
  }

  if (els.modeSchedule.checked) {
    if (!els.startTime.value) {
      setStatus('Please select a start time for the scheduled recording.');
      setError('Start time is required when scheduling.');
      els.startTime.focus();
      return false;
    }

    const start = new Date(els.startTime.value);
    if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) {
      setError('Start time must be in the future.');
      els.startTime.focus();
      return false;
    }

    if (els.endTime.value) {
      const end = new Date(els.endTime.value);
      if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
        setError('End time must be later than the start time.');
        els.endTime.focus();
        return false;
      }
    }
  } else if (els.endTime.value) {
    const end = new Date(els.endTime.value);
    if (Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) {
      setError('The end time for an immediate recording must be in the future.');
      els.endTime.focus();
      return false;
    }
  }

  setError('');
  return true;
}

function updateScheduleVisibility() {
  const isSchedule = els.modeSchedule.checked;
  els.scheduleFields.hidden = !isSchedule;
  els.startTime.disabled = !isSchedule;
  els.endTime.disabled = !isSchedule;
}

function saveSettings() {
  const settings = {
    meetUrl: els.meetUrl.value.trim(),
    displayName: els.displayName.value.trim(),
    mode: els.modeSchedule.checked ? 'schedule' : 'now',
    startTime: els.startTime.value,
    endTime: els.endTime.value,
    headless: els.headless.checked,
    autoUpload: els.autoUpload.checked,
    driveFolder: els.driveFolder.value.trim(),
    outputFolder: els.outputFolder.value.trim(),
  };
  localStorage.setItem('meet-recorder-settings', JSON.stringify(settings));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('meet-recorder-settings');
    if (!raw) return;
    const data = JSON.parse(raw);

    if (data.meetUrl) els.meetUrl.value = data.meetUrl;
    if (data.displayName) els.displayName.value = data.displayName;
    if (data.mode === 'schedule') els.modeSchedule.checked = true;
    else els.modeNow.checked = true;
    if (data.startTime) els.startTime.value = data.startTime;
    if (data.endTime) els.endTime.value = data.endTime;
    els.headless.checked = !!data.headless;
    els.autoUpload.checked = data.autoUpload !== false;
    if (data.driveFolder) els.driveFolder.value = data.driveFolder;
    if (data.outputFolder) els.outputFolder.value = data.outputFolder;
  } catch (err) {
    addLog('Could not load saved settings.', 'warn');
  }

  updateScheduleVisibility();
}

function renderRecentRecordings(entries) {
  els.recentRecordings.innerHTML = '';

  if (!entries || entries.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No recordings yet.';
    li.className = 'empty';
    els.recentRecordings.appendChild(li);
    return;
  }

  for (const entry of entries.slice(0, 5)) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-link';
    button.textContent = entry.name || 'Recording';
    button.addEventListener('click', async () => {
      try {
        const result = await window.api.openLatestRecording();
        if (!result || !result.ok) {
          setError(result && result.error ? result.error : 'Unable to open recording.');
        } else {
          setStatus('Opened recording.');
        }
      } catch (err) {
        setError('Unable to open recording: ' + err.message);
      }
    });
    li.appendChild(button);
    els.recentRecordings.appendChild(li);
  }
}

els.modeNow.addEventListener('change', updateScheduleVisibility);
els.modeSchedule.addEventListener('change', updateScheduleVisibility);

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!validateForm()) return;

  const config = {
    meetUrl: els.meetUrl.value.trim(),
    displayName: els.displayName.value.trim() || 'Meet Recorder Pro',
    mode: els.modeSchedule.checked ? 'schedule' : 'now',
    startTime: els.startTime.value || null,
    endTime: els.endTime.value || null,
    headless: els.headless.checked,
    autoUpload: els.autoUpload.checked,
    folderId: els.driveFolder.value.trim() || null,
    outputDir: els.outputFolder.value.trim() || null,
  };

  saveSettings();
  setError('');
  setBusy(true);
  setStatus('Preparing recording...');

  try {
    const result = await window.api.startRecording(config);
    if (!result || !result.ok) {
      setError((result && result.error) || 'Unable to start recording.');
      setStatus('Recording failed.');
      setButtonsForState('idle');
    } else if (result.scheduled) {
      setStatus('Recording scheduled successfully.');
      setButtonsForState('scheduled');
    } else {
      setStatus('Recording started.');
      setButtonsForState('recording');
    }
  } catch (err) {
    setError('Unexpected error: ' + err.message);
    setStatus('Recording failed.');
    setButtonsForState('idle');
  } finally {
    setBusy(false);
  }
});

els.stopBtn.addEventListener('click', async () => {
  setStatus('Stopping recording...');
  els.stopBtn.disabled = true;

  try {
    const result = await window.api.stopRecording();
    if (!result || !result.ok) {
      setError((result && result.error) || 'Unable to stop recording.');
    } else {
      setStatus('Recording stopped.');
    }
  } catch (err) {
    setError('Unable to stop recording: ' + err.message);
  } finally {
    setButtonsForState('idle');
  }
});

els.connectDriveBtn.addEventListener('click', async () => {
  setStatus('Connecting to Google Drive...');
  els.connectDriveBtn.disabled = true;

  try {
    const result = await window.api.connectDrive();
    if (!result || !result.ok) {
      setError((result && result.error) || 'Unable to connect to Google Drive.');
    } else {
      setStatus('Connected to Google Drive successfully.');
    }
  } catch (err) {
    setError('Connection failed: ' + err.message);
  } finally {
    els.connectDriveBtn.disabled = false;
  }
});

els.importCredentialsBtn.addEventListener('click', async () => {
  try {
    const result = await window.api.pickCredentials();
    if (result && result.canceled) {
      setStatus('Credential import canceled.');
    } else if (result && result.ok) {
      setStatus('Credentials imported successfully.');
    } else {
      setError((result && result.error) || 'Unable to import credentials.');
    }
  } catch (err) {
    setError('Unable to import credentials: ' + err.message);
  }
});

els.chooseFolderBtn.addEventListener('click', async () => {
  try {
    const result = await window.api.chooseOutputFolder();
    if (result && result.ok && result.folder) {
      els.outputFolder.value = result.folder;
      setStatus('Recording folder selected: ' + result.folder);
      saveSettings();
    } else if (result && result.canceled) {
      setStatus('Folder selection canceled.');
    }
  } catch (err) {
    setError('Unable to select the folder: ' + err.message);
  }
});

els.openRecordingsBtn.addEventListener('click', async () => {
  try {
    await window.api.openRecordingsFolder();
  } catch (err) {
    setError('Unable to open the folder: ' + err.message);
  }
});

els.openLatestBtn.addEventListener('click', async () => {
  try {
    const result = await window.api.openLatestRecording();
    if (!result || !result.ok) {
      setError(result && result.error ? result.error : 'No recording available yet.');
    } else {
      setStatus('Latest recording opened.');
    }
  } catch (err) {
    setError('Unable to open latest recording: ' + err.message);
  }
});

window.api.onStatus((payload) => {
  if (!payload) return;
  setStatus(payload.message || '');

  if (payload.state === 'error') {
    setError(payload.message || 'An unexpected error has occurred.');
  } else if (payload.state === 'recorded' || payload.state === 'uploaded') {
    setError('');
  }

  if (payload.state === 'recording') {
    setButtonsForState('recording');
  } else if (payload.state === 'scheduled' || payload.state === 'waiting' || payload.state === 'joining') {
    setButtonsForState('scheduled');
  } else if (payload.state === 'stopped' || payload.state === 'recorded' || payload.state === 'idle' || payload.state === 'error') {
    setButtonsForState('idle');
  }
});

window.api.onLog((payload) => {
  if (!payload) return;
  addLog(payload.message, payload.level || 'info');
});

async function initialize() {
  loadSettings();
  setButtonsForState('idle');

  try {
    const config = await window.api.getConfig();
    if (config && config.ok) {
      els.outputFolder.value = config.defaultOutputDir || '';
      if (config.defaultFolderId) {
        els.driveFolder.value = config.defaultFolderId;
      }
      if (config.version) {
        els.version.textContent = `v${config.version}`;
      }
      if (config.latestRecordingPath) {
        renderRecentRecordings([{ name: config.latestRecordingName || 'Latest recording' }]);
      }
      if (config.driveConnected) {
        addLog('Google Drive already connected.');
      }
      if (!config.credentialsExists) {
        addLog('Warning: Google credentials were not detected. Use the credentials import button or the .env file.', 'warn');
      }
    }
  } catch (err) {
    addLog('Failed to load app settings: ' + err.message, 'error');
  }

  setStatus('Ready.');
}

initialize();
