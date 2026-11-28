/* eslint-disable no-bitwise, no-unused-vars */
/* global DecompressionStream pako */
/*
QQ 音乐 QRC 解密（独立实现）：hex 密文 → 三重定制 DES（ECB，逐 8 字节块）→ zlib 解压 → XML 明文，
再从 XML 里截出 LyricContent（行文本交给 js/lyric_parser.js 的 parseQrc）。

结构是标准 DES（IP / E / S 盒 / P / FP，MSB 优先），与标准 DES 的差异只有两处，
都由 test/fixtures/qrc_sample.json 里的真实密文校验：
1. 密钥压缩（PC-2）取 D 半部分时下标偏移是 -27 而不是 -28，超出 28 位的当作 0；
2. S 盒有个别表项与标准表不同（见 QRC_SBOX）。
三重组合：解密按 D(key3) → E(key2) → D(key1) 依次作用在每个 8 字节块上。

纯 JS，不依赖 Node；zlib 优先用浏览器原生 DecompressionStream，没有时用全局 pako.inflate 兜底。
*/

const QRC_KEY_TEXT = '!@#)(*$%123ZXC!@!@#)(NHL';
const QRC_IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const QRC_FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const QRC_E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const QRC_P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const QRC_PC1_C = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36];
const QRC_PC1_D = [63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const QRC_PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const QRC_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
// 每张表 64 项：下标 = 外侧两位(b0,b5) * 16 + 中间四位(b1..b4)
const QRC_SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

// 与参考实现逐向量比对（32/32 一致）得出：QRC 的 DES 把每个 32 位半区按小端读入，
// 所以密钥、输入块、输出块的字节在半区内是倒序的（3,2,1,0,7,6,5,4），这个置换是对合的。
const QRC_BYTE_ORDER = [3, 2, 1, 0, 7, 6, 5, 4];

function qrcReorder(bytes) {
  return Uint8Array.from(QRC_BYTE_ORDER.map((index) => bytes[index]));
}

function qrcBits(bytes) {
  const bits = [];
  for (let i = 0; i < bytes.length; i += 1) {
    for (let j = 7; j >= 0; j -= 1) {
      bits.push((bytes[i] >> j) & 1);
    }
  }
  return bits;
}

function qrcPermute(bits, table) {
  return table.map((position) => bits[position - 1]);
}

function qrcKeySchedule(keyBytes, decrypt) {
  const keyBits = qrcBits(qrcReorder(keyBytes));
  let c = qrcPermute(keyBits, QRC_PC1_C);
  let d = qrcPermute(keyBits, QRC_PC1_D);
  const keys = [];
  for (let round = 0; round < 16; round += 1) {
    const shift = QRC_SHIFTS[round];
    c = c.slice(shift).concat(c.slice(0, shift));
    d = d.slice(shift).concat(d.slice(0, shift));
    const key = [];
    for (let j = 0; j < 48; j += 1) {
      const k = QRC_PC2[j] - 1;
      // D 半部分的下标偏移是 -27（不是标准的 -28），越界的位当 0
      key.push(j < 24 ? c[k] : d[k - 27] || 0);
    }
    keys.push(key);
  }
  return decrypt ? keys.reverse() : keys;
}

function qrcRoundFunction(right, key) {
  const expanded = qrcPermute(right, QRC_E);
  const out = [];
  for (let i = 0; i < 8; i += 1) {
    const o = i * 6;
    const t = [];
    for (let k = 0; k < 6; k += 1) {
      t.push(expanded[o + k] ^ key[o + k]);
    }
    const index =
      (t[0] << 5) | (t[5] << 4) | (t[1] << 3) | (t[2] << 2) | (t[3] << 1) | t[4];
    const value = QRC_SBOX[i][index];
    out.push((value >> 3) & 1, (value >> 2) & 1, (value >> 1) & 1, value & 1);
  }
  return qrcPermute(out, QRC_P);
}

function qrcDesBlock(bits, keys) {
  const ip = qrcPermute(bits, QRC_IP);
  let left = ip.slice(0, 32);
  let right = ip.slice(32);
  for (let i = 0; i < 16; i += 1) {
    const f = qrcRoundFunction(right, keys[i]);
    const next = left.map((bit, x) => bit ^ f[x]);
    left = right;
    right = next;
  }
  return qrcPermute(right.concat(left), QRC_FP);
}

const QRC_KEY_SCHEDULES = (function buildSchedules() {
  const key = [];
  for (let i = 0; i < QRC_KEY_TEXT.length; i += 1) {
    key.push(QRC_KEY_TEXT.charCodeAt(i));
  }
  return [
    qrcKeySchedule(key.slice(16, 24), true),
    qrcKeySchedule(key.slice(8, 16), false),
    qrcKeySchedule(key.slice(0, 8), true),
  ];
})();

/** 解密单个 8 字节块（三重定制 DES），长度不对抛异常。 */
function qrcDecryptBlock(block) {
  if (!block || block.length !== 8) {
    throw new Error('QRC block must be 8 bytes');
  }
  let bits = qrcBits(qrcReorder(block));
  for (let i = 0; i < 3; i += 1) {
    bits = qrcDesBlock(bits, QRC_KEY_SCHEDULES[i]);
  }
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) {
      value = (value << 1) | bits[i * 8 + j];
    }
    out[i] = value;
  }
  return qrcReorder(out);
}

function qrcHexToBytes(hex) {
  if (
    typeof hex !== 'string' ||
    hex.length === 0 ||
    hex.length % 16 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(hex)
  ) {
    throw new Error('invalid QRC hex');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/** 带 78 xx 头的 zlib 流：优先原生 DecompressionStream，没有时用全局 pako。 */
async function qrcInflate(bytes) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (typeof pako !== 'undefined' && typeof pako.inflate === 'function') {
    return pako.inflate(bytes);
  }
  throw new Error('no zlib inflate available');
}

/** hex 密文 → XML 明文（去 BOM）。任何一步失败都 reject，上层回退 LRC。 */
async function qrcDecrypt(hex) {
  const cipher = qrcHexToBytes(hex);
  const plain = new Uint8Array(cipher.length);
  for (let i = 0; i < cipher.length; i += 8) {
    plain.set(qrcDecryptBlock(cipher.subarray(i, i + 8)), i);
  }
  // 密文按 8 字节补零对齐，zlib 流结束后会带尾部填充；
  // 原生 DecompressionStream 对尾部多余字节会报错，所以先截到流末尾（adler32 之后）。
  // 这里无法提前知道流长度，改为逐步尝试去掉末尾的 0x00 填充（最多 7 字节）。
  let end = plain.length;
  let trimmed = 0;
  while (end > 0 && plain[end - 1] === 0 && trimmed < 7) {
    end -= 1;
    trimmed += 1;
  }
  let inflated;
  try {
    inflated = await qrcInflate(plain.subarray(0, end));
  } catch (error) {
    // adler32 校验和末尾本身可能含 0x00，被误裁时回退到完整数据再试
    inflated = await qrcInflate(plain);
  }
  return new TextDecoder('utf-8').decode(inflated).replace(/^\ufeff/, '');
}

/**
 * 从 XML 里截出 LyricContent 的值。属性值里可能有未转义的双引号，
 * 所以不用 XML 解析器：从 `LyricContent="` 之后截到最后一个 `"/>`。
 */
function extractQrcLyricContent(xml) {
  if (typeof xml !== 'string' || xml === '') return '';
  const marker = 'LyricContent="';
  const begin = xml.indexOf(marker);
  if (begin < 0) return '';
  const start = begin + marker.length;
  const end = xml.lastIndexOf('"/>');
  if (end < start) return '';
  return xml.slice(start, end);
}
