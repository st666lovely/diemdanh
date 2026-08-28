'use strict';
/* Sinh icon PNG cho PWA mà không cần thư viện đồ hoạ.
   Vẽ thẳng từng điểm ảnh rồi đóng gói thành PNG bằng zlib có sẵn của Node. */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const BG = [15, 110, 82];        // #0F6E52 — xanh lục chủ đạo
const FG = [255, 255, 255];
const ACCENT = [233, 196, 106];  // kim phút màu hổ phách

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;   // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* Mặt đồng hồ: nền bo góc + vòng tròn + hai kim. Hợp với công cụ chấm công,
   và nhìn rõ ở cỡ 48px trên màn hình điện thoại. */
function draw(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  // maskable cần chừa 10% mỗi bên để Android bo tròn không cắt vào hình
  const scale = maskable ? 0.66 : 0.80;
  const rOuter = (size / 2) * scale;
  const ring = Math.max(2, size * 0.055);
  const radius = size * (maskable ? 0.5 : 0.22);   // bo góc nền

  const put = (x, y, c, a = 1) => {
    const i = (y * size + x) * 4;
    const old = [buf[i], buf[i + 1], buf[i + 2]];
    const oa = buf[i + 3] / 255;
    const na = a + oa * (1 - a);
    for (let k = 0; k < 3; k++) buf[i + k] = Math.round((c[k] * a + old[k] * oa * (1 - a)) / (na || 1));
    buf[i + 3] = Math.round(na * 255);
  };

  // Nền bo góc
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x, x - (size - radius), 0);
      const dy = Math.max(radius - y, y - (size - radius), 0);
      const d = Math.hypot(dx, dy);
      const a = d <= radius ? 1 : Math.max(0, 1 - (d - radius));
      if (a > 0) put(x, y, BG, a);
    }
  }

  // Vòng tròn mặt đồng hồ
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx + 0.5, y - cy + 0.5);
      const edge = Math.min(rOuter - d, d - (rOuter - ring));
      if (edge > 0) put(x, y, FG, Math.min(1, edge));
    }
  }

  // Kim: giờ chỉ 10h, phút chỉ 2h (bố cục cân, dễ nhận ra là đồng hồ)
  const hand = (angleDeg, len, width, color) => {
    const a = (angleDeg - 90) * Math.PI / 180;
    const ex = cx + Math.cos(a) * rOuter * len;
    const ey = cy + Math.sin(a) * rOuter * len;
    const steps = Math.ceil(Math.hypot(ex - cx, ey - cy) * 2);
    for (let s = 0; s <= steps; s++) {
      const px = cx + (ex - cx) * (s / steps);
      const py = cy + (ey - cy) * (s / steps);
      for (let dy = -width; dy <= width; dy++) {
        for (let dx = -width; dx <= width; dx++) {
          const x = Math.round(px + dx), y = Math.round(py + dy);
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const a2 = Math.max(0, 1 - Math.hypot(dx, dy) / width);
          if (a2 > 0) put(x, y, color, Math.min(1, a2 * 1.6));
        }
      }
    }
  };
  hand(300, 0.44, size * 0.032, FG);       // kim giờ
  hand(60, 0.62, size * 0.026, ACCENT);    // kim phút

  return png(size, size, buf);
}

const out = path.join(__dirname, 'public');
fs.mkdirSync(out, { recursive: true });

const files = [
  ['icon-192.png', draw(192)],
  ['icon-512.png', draw(512)],
  ['icon-180.png', draw(180)],                       // apple-touch-icon
  ['icon-maskable-512.png', draw(512, { maskable: true })],
];
files.forEach(([name, buf]) => {
  fs.writeFileSync(path.join(out, name), buf);
  console.log(`${name.padEnd(24)} ${(buf.length / 1024).toFixed(1)} KB`);
});
