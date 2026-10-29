// 生成 T 字看板图标（多帧 ICO）：青绿渐变 T + 深底圆角 + 用量小柱
// 兼容性策略：32/64/128 用 BMP(DIB) 内嵌帧（资源管理器小图标最稳），256 用 PNG 帧
// 无外部依赖：手写 PNG 编码（zlib）+ DIB + ICO 容器；SDF 圆角做抗锯齿
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

// ── PNG 编码 ─────────────────────────────────────────────
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_T[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', (() => { const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = 8; b[9] = 6; return b; })()),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// BMP(DIB) 帧：BITMAPINFOHEADER(高度双倍) + BGRA 自底向上 + AND 掩码（全 0，透明交给 alpha）
function dib(sz, rgba) {
  const rowBytes = Math.ceil(sz / 32) * 4;
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0); hdr.writeInt32LE(sz, 4); hdr.writeInt32LE(sz * 2, 8);
  hdr.writeUInt16LE(1, 12); hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(sz * sz * 4 + rowBytes * sz, 20);   // biSizeImage = XOR + AND 掩码（部分解析器较真）
  const xor = Buffer.alloc(sz * sz * 4);
  for (let y = 0; y < sz; y++) {
    const src = y * sz * 4, dst = (sz - 1 - y) * sz * 4;
    for (let x = 0; x < sz; x++) {
      const r = rgba[src + x * 4], g = rgba[src + x * 4 + 1], b = rgba[src + x * 4 + 2], a = rgba[src + x * 4 + 3];
      xor[dst + x * 4] = b; xor[dst + x * 4 + 1] = g; xor[dst + x * 4 + 2] = r; xor[dst + x * 4 + 3] = a;
    }
  }
  return Buffer.concat([hdr, xor, Buffer.alloc(rowBytes * sz)]);
}

// ── 绘制 ─────────────────────────────────────────────────
const lerp = (a, b, t) => a + (b - a) * t;
function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }
// 圆角矩形 SDF（外部为正距离，内部为负）
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const smooth = (e) => Math.min(Math.max(e + 0.5, 0), 1);   // 1px 抗锯齿

function paint(sz) {
  const px = Buffer.alloc(sz * sz * 4);
  const BG1 = [22, 32, 58], BG2 = [13, 17, 23];
  const T1 = [126, 224, 163], T2 = [76, 141, 255];
  for (let y = 0; y < sz; y++) for (let x = 0; x < sz; x++) {
    const u = x / sz, v = y / sz;
    let a = 0, r = 0, g = 0, b = 0; // 叠加序：底 → T → 小柱
    const sb = sdRoundRect(x + .5, y + .5, sz / 2, sz / 2, sz / 2 - 1, sz / 2 - 1, sz * 0.22);
    const ab = 1 - smooth(sb);
    if (ab > 0) { const c = mix(BG1, BG2, (u + v) / 2); r = c[0]; g = c[1]; b = c[2]; a = ab; }
    const sBar = sdRoundRect(x + .5, y + .5, sz * 0.42, sz * 0.265, sz * 0.31, sz * 0.062, sz * 0.03);
    const sStem = sdRoundRect(x + .5, y + .5, sz * 0.42, sz * 0.62, sz * 0.078, sz * 0.30, sz * 0.03);
    const sT = Math.min(sBar, sStem);   // SDF 并集取 min
    const aT = 1 - smooth(sT);
    if (aT > 0) {
      const c = mix(T1, T2, Math.min(Math.max((v - 0.16) / 0.72, 0), 1));
      const na = aT + a * (1 - aT);
      r = (c[0] * aT + r * a * (1 - aT)) / na; g = (c[1] * aT + g * a * (1 - aT)) / na; b = (c[2] * aT + b * a * (1 - aT)) / na; a = na;
    }
    const bars = [[0.66, 0.14], [0.76, 0.24], [0.86, 0.19]];
    for (let i = 0; i < 3; i++) {
      const [bx, bh] = bars[i];
      const sB = sdRoundRect(x + .5, y + .5, sz * bx, sz * (0.79 - bh / 2), sz * 0.031, sz * bh / 2, sz * 0.02);
      const aB = (1 - smooth(sB)) * 0.95;
      if (aB > 0) {
        const c = i === 1 ? [126, 224, 163] : [76, 141, 255];
        const na = aB + a * (1 - aB);
        r = (c[0] * aB + r * a * (1 - aB)) / na; g = (c[1] * aB + g * a * (1 - aB)) / na; b = (c[2] * aB + b * a * (1 - aB)) / na; a = na;
      }
    }
    const o = (y * sz + x) * 4;
    px[o] = Math.round(r); px[o + 1] = Math.round(g); px[o + 2] = Math.round(b); px[o + 3] = Math.round(a * 255);
  }
  return px;
}

if (process.argv.includes('--png')) {   // 预览模式：输出 256 PNG 供肉眼核对
  fs.writeFileSync(path.join(__dirname, 't-icon-preview.png'), png(256, 256, paint(256)));
  console.log('预览 PNG 已生成'); process.exit(0);
}
// ── 组装 ICO：小尺寸 BMP 帧，256 PNG 帧 ───────────────────
const sizes = [32, 64, 128, 256];
const frames = sizes.map((s) => { const rgba = paint(s); return s === 256 ? png(s, s, rgba) : dib(s, rgba); });
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(frames.length, 4);
const dir = Buffer.alloc(16 * frames.length);
let off = 6 + 16 * frames.length;
sizes.forEach((s, i) => {
  const o = i * 16;
  dir[o] = s >= 256 ? 0 : s; dir[o + 1] = s >= 256 ? 0 : s;
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(frames[i].length, o + 8); dir.writeUInt32LE(off, o + 12);
  off += frames[i].length;
});
const out = path.join(__dirname, 't-icon.ico');
fs.writeFileSync(out, Buffer.concat([head, dir, ...frames]));
console.log('ICO 已生成:', out, fs.statSync(out).size, 'bytes');
