'use strict';

/**
 * generate-icon.js
 * ---------------------------------------------------------------------------
 * يولّد أيقونة التطبيق (build/icon.png) بمقاس 1024×1024 بصيغة PNG شفافة،
 * دون أي اعتماديات خارجية (تُبنى الصورة يدويًا ثم تُرمَّز بـ zlib).
 *
 * التصميم: مربّع أزرق بحواف دائرية + رمز ميكروفون أبيض.
 *
 * التشغيل:
 *   node scripts/generate-icon.js
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// أدوات PNG
// ---------------------------------------------------------------------------

/** جدول CRC32 لصيغة PNG. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** بناء قطعة (chunk) في ملف PNG. */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/** ترميز مصفوفة RGBA إلى PNG. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // عمق البت
  ihdr[9] = 6; // نوع اللون: RGBA
  ihdr[10] = 0; // ضغط
  ihdr[11] = 0; // تصفية
  ihdr[12] = 0; // تشابك

  // إضافة بايت التصفية (0) بداية كل سطر.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// أدوات الرسم
// ---------------------------------------------------------------------------

const SS = 2; // معامل التكبير الفائق (supersampling) لتنعيم الحواف
const FINAL = 1024; // مقاس الأيقونة النهائي
const S = FINAL * SS; // مقاس الرسم

/** هل النقطة داخل مستطيل بحواف دائرية؟ */
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** هل النقطة داخل دائرة؟ */
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** هل النقطة داخل حلقة (قوس) بنصف قطر r وسماكة t؟ */
function inRing(x, y, cx, cy, r, t) {
  const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
  return d >= r - t / 2 && d <= r + t / 2;
}

// ألوان (R,G,B)
const BG_TOP = [26, 115, 255];
const BG_BOTTOM = [9, 57, 168];
const WHITE = [255, 255, 255];

/** لون بكسل حسب الشكل المرسوم. */
function samplePixel(px, py) {
  // الخلفية: مربّع بحواف دائرية مع تدرّج عمودي.
  const radius = 200 * SS;
  if (!inRoundedRect(px, py, 0, 0, S - 1, S - 1, radius)) {
    return [0, 0, 0, 0]; // خارج الشكل = شفاف
  }

  const t = py / (S - 1);
  let r = Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t);
  let g = Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t);
  let b = Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t);
  let a = 255;

  const cx = 512 * SS;
  const bodyTop = 250 * SS;
  const bodyBottom = 610 * SS;
  const bodyHalf = 108 * SS;

  // جسم الميكروفون (كبسولة).
  const isBody = inRoundedRect(
    px,
    py,
    cx - bodyHalf,
    bodyTop,
    cx + bodyHalf,
    bodyBottom,
    bodyHalf
  );

  // القوس الحاضن (النصف السفلي فقط).
  const cradle = inRing(px, py, cx, 560 * SS, 208 * SS, 34 * SS) && py >= 560 * SS;

  // الساق.
  const stand = inRoundedRect(px, py, cx - 18 * SS, 760 * SS, cx + 18 * SS, 856 * SS, 18 * SS);

  // القاعدة الأفقية.
  const base = inRoundedRect(px, py, 372 * SS, 838 * SS, 652 * SS, 874 * SS, 18 * SS);

  if (isBody || cradle || stand || base) {
    r = WHITE[0];
    g = WHITE[1];
    b = WHITE[2];
    a = 255;
  }

  return [r, g, b, a];
}

// ---------------------------------------------------------------------------
// التصغير (downsampling) من S إلى FINAL بمتوسط الكتل
// ---------------------------------------------------------------------------

function render() {
  const out = Buffer.alloc(FINAL * FINAL * 4);

  for (let y = 0; y < FINAL; y++) {
    for (let x = 0; x < FINAL; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = samplePixel(x * SS + sx, y * SS + sy);
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
        }
      }
      const idx = (y * FINAL + x) * 4;
      if (a === 0) {
        out[idx] = 0;
        out[idx + 1] = 0;
        out[idx + 2] = 0;
        out[idx + 3] = 0;
      } else {
        out[idx] = Math.round(r / a);
        out[idx + 1] = Math.round(g / a);
        out[idx + 2] = Math.round(b / a);
        out[idx + 3] = Math.round(a / (SS * SS));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// التنفيذ
// ---------------------------------------------------------------------------

const rgba = render();
const png = encodePng(FINAL, FINAL, rgba);

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
const outPath = path.join(buildDir, 'icon.png');
fs.writeFileSync(outPath, png);

// eslint-disable-next-line no-console
console.log(`تم إنشاء الأيقونة: ${outPath} (${FINAL}×${FINAL}, ${png.length} بايت)`);
