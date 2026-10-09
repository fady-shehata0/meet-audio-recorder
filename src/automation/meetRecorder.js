'use strict';

/**
 * meetRecorder.js
 * ---------------------------------------------------------------------------
 * وحدة مسؤولة عن:
 *   1) تشغيل متصفح Chromium عبر Puppeteer (باستخدام مكتبة puppeteer-stream).
 *   2) فتح رابط اجتماع Google Meet والانضمام إليه.
 *   3) تسجيل الصوت الصادر من صفحة الاجتماع فقط (بدون فيديو).
 *   4) إيقاف التسجيل وحفظ الملف بصيغة WebM/Opus.
 *
 * تعتمد الوحدة على puppeteer-stream لالتقاط الصوت لأن مكتبة Puppeteer وحدها
 * لا تتيح الوصول إلى تدفّق الصوت الداخلي للصفحة.
 * ---------------------------------------------------------------------------
 */

const EventEmitter = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// نحاول استيراد puppeteer-stream بشكل آمن حتى نعطي رسالة واضحة إذا لم تُثبَّت.
let puppeteerStream = null;
try {
  // eslint-disable-next-line global-require
  puppeteerStream = require('puppeteer-stream');
} catch (err) {
  puppeteerStream = null;
}

/** مهلة تحميل الصفحة (ms). */
const NAV_TIMEOUT = 60 * 1000;
/** أقصى مدة ننتظر فيها قبول المضيف للانضمام (ms). */
const ADMIT_TIMEOUT = 5 * 60 * 1000;

class MeetRecorder extends EventEmitter {
  constructor() {
    super();

    /** @type {import('puppeteer').Browser|null} */
    this.browser = null;
    /** @type {import('puppeteer').Page|null} */
    this.page = null;
    /** تدفّق القراءة القادم من puppeteer-stream. */
    this.stream = null;
    /** تدفّق الكتابة إلى ملف التسجيل. */
    this.fileStream = null;
    /** مسار ملف التسجيل الناتج. */
    this.outputPath = null;
    /** هل نحن في وضع التسجيل الآن؟ */
    this.isRecording = false;
    /** منع إصدار حدث "recorded" أكثر من مرة. */
    this._finalized = false;
  }

  // -------------------------------------------------------------------------
  // دوال مساعدة صغيرة
  // -------------------------------------------------------------------------

  /** إرسال حدث تغيّر حالة (يُترجَم إلى رسالة لقارئ الشاشة في الواجهة). */
  _status(state, message) {
    this.emit('status', { state, message });
  }

  /** إرسال سطر إلى السجل. */
  _log(message, level = 'info') {
    this.emit('log', { level, message });
  }

  /** انتظار بسيط. */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * تحديد مسار متصفح Chrome/Chromium.
   * الأولوية لمتغير البيئة ثم Chromium المُرفق مع puppeteer، مع التحقّق
   * من وجود الملف فعليًا (مهم في النسخ المُحزَّمة حيث قد لا يتوفّر).
   * عند عدم توفّر أي مسار نُعيد undefined ليختار puppeteer-stream الافتراضي.
   */
  _resolveExecutablePath() {
    const candidates = [];

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      candidates.push(process.env.PUPPETEER_EXECUTABLE_PATH);
    }
    try {
      // eslint-disable-next-line global-require
      candidates.push(require('puppeteer').executablePath());
    } catch (err) {
      // نتجاهل: قد لا تكون puppeteer متاحة للاستيراد.
    }

    for (const candidate of candidates) {
      try {
        if (candidate && fs.existsSync(candidate)) {
          return candidate;
        }
      } catch (err) {
        // نتجاهل هذا المرشّح.
      }
    }
    return undefined; // ترك puppeteer-stream يكتشف المتصفح الافتراضي.
  }

  // -------------------------------------------------------------------------
  // دورة حياة التسجيل
  // -------------------------------------------------------------------------

  /**
   * بدء التسجيل.
   * @param {object} options
   * @param {string} options.meetUrl      رابط اجتماع Google Meet.
   * @param {string} [options.displayName] الاسم الظاهر داخل الاجتماع.
   * @param {boolean} [options.headless]   تشغيل المتصفح بدون واجهة.
   * @param {string} options.outputDir     مجلد حفظ التسجيل.
   * @param {boolean} [options.muteMic]    كتم الميكروفون عند الدخول.
   * @param {boolean} [options.cameraOff]  إيقاف الكاميرا عند الدخول.
   * @returns {Promise<{outputPath: string}>}
   */
  async start({
    meetUrl,
    displayName = 'مسجّل الاجتماع',
    headless = false,
    outputDir,
    muteMic = true,
    cameraOff = true,
  }) {
    if (this.browser) {
      throw new Error('يوجد تسجيل قيد التشغيل بالفعل.');
    }
    if (!puppeteerStream) {
      throw new Error(
        'مكتبة puppeteer-stream غير مثبّتة. الرجاء تنفيذ الأمر: npm install'
      );
    }
    if (!outputDir) {
      throw new Error('لم يتم تحديد مجلد حفظ التسجيل.');
    }

    // إنشاء مجلد المخرجات إن لم يكن موجودًا.
    await fsp.mkdir(outputDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.outputPath = path.join(outputDir, `meet-audio-${stamp}.webm`);
    this._finalized = false;

    // 1) تشغيل المتصفح -----------------------------------------------------
    this._status('launching', 'جاري تشغيل المتصفح...');
    await this._launchBrowser({ headless });

    // 2) فتح رابط الاجتماع -------------------------------------------------
    this._status('joining', 'جاري فتح رابط الاجتماع والانضمام...');
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 720 });

    try {
      await this.page.goto(meetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT,
      });
    } catch (err) {
      await this.stop();
      throw new Error('تعذّر فتح رابط الاجتماع: ' + err.message);
    }

    // 3) محاولة الانضمام ---------------------------------------------------
    await this._joinMeeting({ displayName, muteMic, cameraOff });

    // 4) الانتظار حتى يقبل المضيف (أو انتهاء المهلة) ----------------------
    this._status('waiting', 'بانتظار قبول المضيف للانضمام إلى الاجتماع...');
    const admitted = await this._waitForAdmitted();
    if (!admitted) {
      this._log(
        'لم نتأكّد من الانضمام خلال المدة المحدّدة. سيبدأ التسجيل على أي حال؛ ' +
          'تأكّد من أن المضيف قد سمح بالدخول.',
        'warn'
      );
    }

    // 5) بدء التقاط الصوت --------------------------------------------------
    this._status('recording', 'بدأ التسجيل الآن.');
    await this._startAudioStream();
    this.isRecording = true;

    return { outputPath: this.outputPath };
  }

  /** إيقاف التسجيل وحفظ الملف. */
  async stop() {
    if (this._finalized) {
      return this.outputPath;
    }
    this._status('stopping', 'جاري إيقاف التسجيل وحفظ الملف...');
    await this._finalize();
    this._status('stopped', 'تم إيقاف التسجيل بنجاح.');
    return this.outputPath;
  }

  // -------------------------------------------------------------------------
  // تفاصيل داخلية
  // -------------------------------------------------------------------------

  /** تشغيل المتصفح عبر puppeteer-stream (ضروري لالتقاط الصوت). */
  async _launchBrowser({ headless }) {
    const executablePath = this._resolveExecutablePath();

    const launchOptions = {
      // "new" هي طريقة headless الحديثة في Chromium.
      headless: headless ? 'new' : false,
      defaultViewport: { width: 1280, height: 720 },
      // ملاحظة: قد تكون undefined فيُستخدم الافتراضي.
      executablePath,
      // مهلة بروتوكول أطول لتجنّب أخطاء الاتصال في العمليات الطويلة.
      protocolTimeout: 240000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        // السماح بتشغيل الصوت تلقائيًا دون تفاعل المستخدم.
        '--autoplay-policy=no-user-gesture-required',
        // قبول أذونات الكاميرا/الميكروفون تلقائيًا.
        '--use-fake-ui-for-media-stream',
        '--window-size=1280,720',
        '--lang=ar',
      ],
      // مهم جدًا: يجب عدم كتم صوت المتصفح وإلا لن يُسجَّل شيء.
      ignoreDefaultArgs: ['--mute-audio'],
    };

    // بعض إصدارات puppeteer-stream تأخذ نسخة puppeteer كوسيط أول.
    // نجرّب الصيغة الحديثة أولًا ثم نعود للصيغة القديمة عند الحاجة.
    try {
      this.browser = await puppeteerStream.launch(launchOptions);
    } catch (err) {
      try {
        this.browser = await puppeteerStream.launch(
          // eslint-disable-next-line global-require
          require('puppeteer'),
          launchOptions
        );
      } catch (err2) {
        throw new Error(
          'تعذّر تشغيل المتصفح: ' + (err2.message || err.message)
        );
      }
    }

    // منح الأذونات على نطاق Google Meet.
    try {
      const context = this.browser.defaultBrowserContext();
      await context.overridePermissions('https://meet.google.com', [
        'microphone',
        'camera',
        'notifications',
      ]);
    } catch (err) {
      // ليست خطوة حرجة؛ نتجاهل الخطأ.
      this._log('تعذّر ضبط أذونات المتصفح تلقائيًا: ' + err.message, 'warn');
    }

    // إذا أُغلق المتصفح يدويًا (أو انتهى الاجتماع) نُنهي الملف تلقائيًا.
    this.browser.on('disconnected', () => {
      if (!this._finalized) {
        this._log('تم إغلاق المتصفح. جاري إنهاء ملف التسجيل...', 'warn');
        this._finalize().catch(() => {});
      }
    });
  }

  /** إدخال الاسم وإيقاف الكاميرا/الميكروفون والضغط على زر الانضمام. */
  async _joinMeeting({ displayName, muteMic, cameraOff }) {
    const page = this.page;
    // ننتظر قليلًا لتُصبح عناصر الواجهة جاهزة.
    await this._sleep(2500);

    // (أ) إدخال اسم المشارك إن كان الاجتماع يسمح بالدخول كضيف.
    const nameSelectors = [
      'input[aria-label="Your name"]',
      'input[aria-label="اسمك"]',
      'input[placeholder="Your name"]',
      'input[placeholder="اسمك"]',
      'input[type="text"][jsname]',
    ];
    for (const selector of nameSelectors) {
      const el = await page.$(selector);
      if (el) {
        await el.click({ clickCount: 3 }).catch(() => {});
        await el.type(displayName || 'مسجّل الاجتماع', { delay: 25 }).catch(() => {});
        this._log('تم إدخال اسم المشارك.');
        break;
      }
    }

    // (ب) إيقاف الكاميرا ثم الميكروفون (حفاظًا على الخصوصية ومنع الضوضاء).
    if (cameraOff) {
      await this._clickFirstExisting([
        'button[aria-label="Turn off camera"]',
        'button[aria-label="إيقاف الكاميرا"]',
      ]);
    }
    if (muteMic) {
      await this._clickFirstExisting([
        'button[aria-label="Turn off microphone"]',
        'button[aria-label="إيقاف الميكروفون"]',
      ]);
    }

    // (ج) الضغط على زر الانضمام (بأي من الصيغ المعروفة).
    const joinTexts = [
      'Ask to join',
      'Join now',
      'Join',
      'طلب الانضمام',
      'الانضمام الآن',
      'انضمام',
    ];
    const clicked = await this._clickButtonByText(joinTexts);
    if (!clicked) {
      throw new Error(
        'تعذّر العثور على زر الانضمام. تأكّد من صحة رابط الاجتماع وأن ' +
          'الاجتماع لم ينتهِ بعد.'
      );
    }
    this._log(`تم النقر على زر الانضمام: "${clicked}"`);
  }

  /** النقر على أول عنصر موجود من قائمة محدّدات. */
  async _clickFirstExisting(selectors) {
    for (const selector of selectors) {
      const el = await this.page.$(selector);
      if (el) {
        await el.click().catch(() => {});
        return true;
      }
    }
    return false;
  }

  /** إيجاد زر يحوي أحد النصوص المحدّدة ثم النقر عليه. */
  async _clickButtonByText(texts) {
    return this.page.evaluate((labels) => {
      const nodes = Array.from(
        document.querySelectorAll('button, [role="button"], a[role="button"]')
      );
      for (const node of nodes) {
        const text = (
          node.getAttribute('aria-label') ||
          node.textContent ||
          ''
        )
          .trim()
          .toLowerCase();
        const match = labels.find((label) => text.includes(label.toLowerCase()));
        if (match) {
          node.click();
          return (node.textContent || node.getAttribute('aria-label') || '').trim();
        }
      }
      return null;
    }, texts);
  }

  /**
   * الانتظار حتى نُصبح داخل الاجتماع (ظهور أدوات التحكّم في المكالمة).
   * @returns {Promise<boolean>}
   */
  async _waitForAdmitted(timeout = ADMIT_TIMEOUT) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const inCall = await this.page
        .evaluate(() => {
          const selectors = [
            '[aria-label*="Leave call"]',
            '[aria-label*="مغادرة المكالمة"]',
            '[aria-label*="Call controls"]',
            '[aria-label*="أدوات التحكم بالمكالمة"]',
            '[data-tooltip*="Leave"]',
          ];
          return selectors.some((sel) => !!document.querySelector(sel));
        })
        .catch(() => false);

      if (inCall) return true;
      await this._sleep(3000);
    }
    return false;
  }

  /** بدء التقاط الصوت وكتابته إلى الملف. */
  async _startAudioStream() {
    const streamOptions = {
      audio: true, // تسجيل الصوت فقط
      video: false, // بلا فيديو
      mimeType: 'audio/webm',
      audioBitsPerSecond: 128000,
    };

    this.stream = await puppeteerStream.getStream(this.page, streamOptions);
    this.fileStream = fs.createWriteStream(this.outputPath, { flags: 'w' });

    await new Promise((resolve, reject) => {
      this.fileStream.once('open', resolve);
      this.fileStream.once('error', reject);
      this.stream.once('error', reject);
    });

    this.stream.pipe(this.fileStream);
  }

  /** إنهاء البث، إغلاق الملفات، وإغلاق المتصفح. */
  async _finalize() {
    if (this._finalized) return;
    this._finalized = true;

    // 1) إيقاف تدفّق الصوت.
    if (this.stream) {
      try {
        await this.stream.destroy();
      } catch (err) {
        this._log('خطأ أثناء إيقاف تدفّق الصوت: ' + err.message, 'warn');
      }
      this.stream = null;
    }

    // 2) إغلاق ملف المخرجات وانتظار انتهاء الكتابة (flush).
    if (this.fileStream) {
      await new Promise((resolve) => {
        this.fileStream.end(() => resolve());
      });
      this.fileStream = null;
    }

    // 3) إغلاق المتصفح.
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (err) {
        this._log('خطأ أثناء إغلاق المتصفح: ' + err.message, 'warn');
      }
      this.browser = null;
      this.page = null;
    }

    this.isRecording = false;

    if (this.outputPath) {
      this.emit('recorded', { outputPath: this.outputPath });
    }
  }
}

module.exports = MeetRecorder;
