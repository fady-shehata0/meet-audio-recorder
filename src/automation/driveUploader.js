'use strict';

/**
 * driveUploader.js
 * ---------------------------------------------------------------------------
 * رفع ملف التسجيل الصوتي إلى Google Drive باستخدام googleapis.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

/**
 * رفع ملف إلى Google Drive.
 *
 * @param {import('googleapis').Auth.OAuth2Client} auth عميل OAuth2 مُصرَّح.
 * @param {string} filePath مسار الملف المحلي.
 * @param {object} [options]
 * @param {string} [options.fileName] اسم الملف في Drive (الافتراضي: اسم الملف المحلي).
 * @param {string} [options.folderId] معرّف المجلد الهدف (اختياري).
 * @param {string} [options.mimeType] نوع الملف (الافتراضي audio/webm).
 * @returns {Promise<{id:string,name:string,size?:string,webViewLink?:string}>}
 */
async function uploadToDrive(auth, filePath, options = {}) {
  if (!auth) {
    throw new Error('العميل غير مُصرَّح للوصول إلى Google Drive.');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error('ملف التسجيل غير موجود: ' + filePath);
  }

  const drive = google.drive({ version: 'v3', auth });
  const fileName = options.fileName || path.basename(filePath);
  const mimeType = options.mimeType || 'audio/webm';

  const requestBody = { name: fileName };
  if (options.folderId) {
    requestBody.parents = [options.folderId];
  }

  const response = await drive.files.create({
    requestBody,
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: 'id, name, size, webViewLink',
  });

  return response.data;
}

module.exports = { uploadToDrive };
