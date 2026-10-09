# سجل التغييرات (Changelog)

جميع التغييرات المهمة في هذا المشروع تُوثَّق في هذا الملف.

الصيغة مبنية على [Keep a Changelog](https://keepachangelog.com/ar/1.1.0/)
والمشروع يتبع [الإصدار الدلالي (Semantic Versioning)](https://semver.org/lang/ar/).

## [Unreleased]
### مخطط له
- تحويل الملف الصوتي الناتج تلقائيًا إلى صيغة MP3.
- حفظ جلسة تسجيل الدخول لاجتماعات Google التي تمنع الدخول كضيف.
- مؤشر تقدّم لرفع الملف إلى Google Drive.

## [1.0.0] - 2026-10-09

### أُضيف
- واجهة سطح مكتب مبنية بـ **Electron** لإدخال رابط Google Meet والتحكم بالتسجيل.
- الانضمام التلقائي إلى اجتماعات Google Meet عبر **Puppeteer**.
- تسجيل **الصوت فقط** بصيغة `WebM/Opus` باستخدام **puppeteer-stream**.
- خيار **بدء التسجيل فورًا** أو **جدولة** وقت البدء و/أو وقت الانتهاء تلقائيًا.
- **رفع تلقائي** لملف التسجيل إلى **Google Drive** مع دعم تحديد مجلد هدف.
- مصادقة **OAuth 2.0** عبر خادم محلي (loopback) وحفظ التوكن لإعادة استخدامه.
- واجهة مستخدم متوافقة مع **معايير إمكانية الوصول**:
  - سمات `role` و`aria-label` و`aria-describedby` على كل العناصر.
  - مناطق مباشرة (`aria-live`) للإعلان عن الحالات والأخطاء.
  - تنقّل كامل بلوحة المفاتيح ومؤشّر تركيز واضح.
  - دعم تفضيلي `prefers-reduced-motion` و`prefers-contrast`.
- وركفلو **GitHub Actions** لبناء وإصدار التطبيق على Windows وmacOS وLinux.

[Unreleased]: https://github.com/fady-shehata0/meet-audio-recorder/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/fady-shehata0/meet-audio-recorder/releases/tag/v1.0.0
