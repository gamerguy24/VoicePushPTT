'use strict';

// Draws the Walkie icon (amber disc with a microphone) as a PNG of any size,
// so the app needs no image assets. Run directly to write a file:
//   node icon.js build/icon.png [size]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const AMBER = [245, 165, 36];
const DARK = [20, 23, 28];

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Distance from point (u, v) to the vertical segment x = 0.5, y0..y1.
function distToStem(u, v, y0, y1) {
  const y = Math.min(Math.max(v, y0), y1);
  return Math.hypot(u - 0.5, v - y);
}

// Returns null (transparent), AMBER or DARK for a point in unit coordinates.
function colorAt(u, v) {
  if (Math.hypot(u - 0.5, v - 0.5) > 0.47) return null;
  const capsule = distToStem(u, v, 0.33, 0.45) <= 0.105;
  const ring = Math.hypot(u - 0.5, v - 0.45);
  const cradle = v >= 0.45 && ring >= 0.165 && ring <= 0.21;
  const stem = Math.abs(u - 0.5) <= 0.024 && v >= 0.63 && v <= 0.75;
  const base = Math.abs(u - 0.5) <= 0.12 && v >= 0.735 && v <= 0.775;
  return capsule || cradle || stem || base ? DARK : AMBER;
}

function makePng(size) {
  const SS = 4; // supersampling per axis for smooth edges
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; hits++;
        }
      }
      const o = y * stride + 1 + x * 4;
      if (hits) {
        raw[o] = Math.round(r / hits);
        raw[o + 1] = Math.round(g / hits);
        raw[o + 2] = Math.round(b / hits);
        raw[o + 3] = Math.round((hits / (SS * SS)) * 255);
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { makePng };

if (require.main === module) {
  const out = process.argv[2] || 'build/icon.png';
  const size = Number(process.argv[3]) || 512;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, makePng(size));
  console.log(`wrote ${out} (${size}x${size})`);
}
