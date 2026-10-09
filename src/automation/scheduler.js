'use strict';

/**
 * scheduler.js
 * ---------------------------------------------------------------------------
 * جدولة مهام مؤقّتة (بدء التسجيل / إيقافه) مع إمكانية الإلغاء.
 * نستخدم setTimeout لأن التطبيق يعمل طالما أنه مفتوح (حالة سطح مكتب).
 * ---------------------------------------------------------------------------
 */

class Scheduler {
  constructor() {
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timers = new Map();
    this.counter = 0;
  }

  /**
   * تنفيذ دالة عند وقت محدّد.
   * @param {Date} when الوقت المطلوب.
   * @param {() => void} fn الدالة.
   * @returns {{id: string, delay: number}}
   */
  scheduleAt(when, fn) {
    const delay = when.getTime() - Date.now();
    const id = `job-${++this.counter}`;

    const timer = setTimeout(() => {
      this.timers.delete(id);
      try {
        fn();
      } catch (err) {
        // نمنع انهيار العملية بسبب خطأ في المهمة المجدولة.
        // eslint-disable-next-line no-console
        console.error('[Scheduler] خطأ في المهمة المجدولة:', err);
      }
    }, Math.max(0, delay));

    this.timers.set(id, timer);
    return { id, delay: Math.max(0, delay) };
  }

  /** إلغاء مهمة بواسطة المعرّف. */
  cancel(id) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
      return true;
    }
    return false;
  }

  /** إلغاء جميع المهام. */
  cancelAll() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /** عدد المهام المجدولة حاليًا. */
  get size() {
    return this.timers.size;
  }
}

module.exports = Scheduler;
