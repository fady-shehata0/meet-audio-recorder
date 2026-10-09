'use strict';

/**
 * googleAuth.js
 * ---------------------------------------------------------------------------
 * إدارة مصادقة OAuth 2.0 مع Google Drive.
 *
 * الوظائف:
 *   - قراءة بيانات الاعتماد من متغيّرات البيئة أو من ملف credentials.json.
 *   - استخدام توكن محفوظ مسبقًا إن وُجد (token.json) وتجديده تلقائيًا.
 *   - تشغيل خادم محلي مؤقّت لاستقبال رمز التفويض (loopback OAuth flow).
 *   - فتح صفحة الموافقة في المتصفح الافتراضي للمستخدم.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');

/** النطاقات المطلوبة: الوصول إلى الملفات التي ينشئها التطبيق فقط. */
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

/** المنفذ المحلي لاستقبال رمز التفويض. */
const REDIRECT_PORT = 42813;
const REDIRECT_PATH = '/oauth2callback';
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}${REDIRECT_PATH}`;

class GoogleAuthManager {
  /**
   * @param {object} options
   * @param {string} options.credentialsPath مسار ملف credentials.json.
   * @param {string} options.tokenPath       مسار حفظ/قراءة token.json.
   * @param {(url: string) => Promise<any>} options.openExternal دالة لفتح الرابط خارجيًا.
   */
  constructor({ credentialsPath, tokenPath, openExternal }) {
    this.credentialsPath = credentialsPath;
    this.tokenPath = tokenPath;
    this.openExternal = openExternal;
    /** @type {import('googleapis').Auth.OAuth2Client|null} */
    this.client = null;
  }

  // -------------------------------------------------------------------------
  // تحميل بيانات الاعتماد
  // -------------------------------------------------------------------------

  /** إرجاع بيانات اعتماد OAuth من البيئة أو من الملف. */
  _loadCredentials() {
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      return {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      };
    }

    if (fs.existsSync(this.credentialsPath)) {
      const raw = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
      // قد يكون الملف بصيغة "installed" أو "web" أو بدون غلاف.
      const data = raw.installed || raw.web || raw;
      if (!data.client_id || !data.client_secret) {
        throw new Error('ملف credentials.json لا يحتوي على client_id/client_secret.');
      }
      return {
        clientId: data.client_id,
        clientSecret: data.client_secret,
        redirectUri: REDIRECT_URI,
      };
    }

    throw new Error(
      'لم يتم العثور على بيانات اعتماد Google. الرجاء توفير ملف credentials.json ' +
        'أو ضبط المتغيّرين GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET.'
    );
  }

  // -------------------------------------------------------------------------
  // الوصول إلى عميل مُصرَّح
  // -------------------------------------------------------------------------

  /**
   * إرجاع عميل OAuth2 جاهز للاستخدام، مع تشغيل التفويض التفاعلي عند الحاجة.
   * @returns {Promise<import('googleapis').Auth.OAuth2Client>}
   */
  async getClient() {
    if (this.client && this.isConnected()) {
      return this.client;
    }

    const creds = this._loadCredentials();
    const client = new google.auth.OAuth2(
      creds.clientId,
      creds.clientSecret,
      creds.redirectUri
    );

    // تحميل التوكن المحفوظ إن وُجد.
    if (fs.existsSync(this.tokenPath)) {
      try {
        const token = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
        client.setCredentials(token);
      } catch (err) {
        // ملف توكن تالف: نتجاهله ونطلب التفويض من جديد.
      }
    }

    // حفظ أي توكن جديد/مُجدَّد تلقائيًا.
    client.on('tokens', (tokens) => {
      const merged = { ...(client.credentials || {}), ...tokens };
      this._saveToken(merged);
    });

    // هل لدينا توكن قابل للاستخدام؟
    const hasToken = !!(
      client.credentials &&
      (client.credentials.refresh_token || client.credentials.access_token)
    );

    if (hasToken) {
      // نتأكّد من صلاحية التوكن عبر محاولة جلب access token.
      try {
        await client.getAccessToken();
      } catch (err) {
        await this._interactiveAuthorize(client);
      }
    } else {
      await this._interactiveAuthorize(client);
    }

    this.client = client;
    return client;
  }

  /** حفظ التوكن على القرص. */
  _saveToken(token) {
    try {
      fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
      fs.writeFileSync(this.tokenPath, JSON.stringify(token, null, 2), 'utf8');
    } catch (err) {
      // لا نُفشل العملية بسبب تعذّر الحفظ.
    }
  }

  /** تنفيذ التفويض التفاعلي عبر المتصفح. */
  async _interactiveAuthorize(client) {
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
    });

    const code = await this._waitForAuthorizationCode(authUrl);
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    this._saveToken(tokens);
    return client;
  }

  /**
   * تشغيل خادم محلي وانتظار رمز التفويض.
   * @param {string} authUrl
   * @returns {Promise<string>} رمز التفويض.
   */
  _waitForAuthorizationCode(authUrl) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutMs = 5 * 60 * 1000; // 5 دقائق

      const server = http.createServer((req, res) => {
        try {
          const parsed = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
          if (parsed.pathname !== REDIRECT_PATH) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
          }

          const code = parsed.searchParams.get('code');
          const error = parsed.searchParams.get('error');

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
              '<title>نجاح التفويض</title></head><body>' +
              '<h1>تم التفويض بنجاح</h1>' +
              '<p>يمكنك إغلاق هذه النافذة والعودة إلى التطبيق.</p>' +
              '</body></html>'
          );

          if (settled) return;
          settled = true;
          server.close();

          if (error) {
            reject(new Error('رفض المستخدم منح الصلاحية: ' + error));
          } else if (!code) {
            reject(new Error('لم يتم استلام رمز التفويض من Google.'));
          } else {
            resolve(code);
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            server.close();
            reject(err);
          }
        }
      });

      server.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `تعذّر تشغيل الخادم المحلي على المنفذ ${REDIRECT_PORT}: ${err.message}`
            )
          );
        }
      });

      server.listen(REDIRECT_PORT, '127.0.0.1', async () => {
        // فتح صفحة الموافقة في المتصفح الافتراضي.
        try {
          await this.openExternal(authUrl);
        } catch (err) {
          if (!settled) {
            settled = true;
            server.close();
            reject(new Error('تعذّر فتح المتصفح للتفويض: ' + err.message));
          }
        }
      });

      // مؤقّت انتهاء المهلة.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            server.close();
          } catch (err) {
            /* تجاهل */
          }
          reject(new Error('انتهت مهلة التفويض (٥ دقائق) دون إتمام العملية.'));
        }
      }, timeoutMs);
    });
  }

  /** هل يوجد توكن محفوظ/صالح؟ */
  isConnected() {
    return !!(
      this.client &&
      this.client.credentials &&
      (this.client.credentials.refresh_token || this.client.credentials.access_token)
    );
  }
}

module.exports = GoogleAuthManager;
