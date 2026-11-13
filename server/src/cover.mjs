/**
 * 一个最小可用的 PNG 生成器（不引依赖）。
 * 用途：媒体库没有封面图时，按标题哈希给一张渐变色占位图。
 * 客户端拿到的必须是真图片字节（它会先按魔数判断，判不出才去尝试解密）。
 */
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 由字符串派生一对颜色（HSL → RGB，明度压暗一点适合当封面底） */
function palette(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + (h >> 8) % 80) % 360;
  const hsl = (deg, s, l) => {
    const k = (n) => (n + deg / 30) % 12;
    const f = (n) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  };
  return [hsl(a, 0.55, 0.42), hsl(b, 0.6, 0.22)];
}

/**
 * @param {string} seed 决定颜色
 * @param {number} w
 * @param {number} h
 * @returns {Buffer} PNG 字节
 */
export function coverPng(seed, w = 640, h = 360) {
  const [c1, c2] = palette(seed || "hghub");
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    const t = y / Math.max(1, h - 1);
    for (let x = 0; x < w; x++) {
      const s = (t * 0.75 + (x / Math.max(1, w - 1)) * 0.25);
      raw[p++] = Math.round(c1[0] + (c2[0] - c1[0]) * s);
      raw[p++] = Math.round(c1[1] + (c2[1] - c1[1]) * s);
      raw[p++] = Math.round(c1[2] + (c2[2] - c1[2]) * s);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
