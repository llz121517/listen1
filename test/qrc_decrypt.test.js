/* global DecompressionStream */
/**
 * QRC 解密（js/provider/qq_qrc.js）：定制 DES（ECB，三重）+ zlib 解压 + 取 LyricContent。
 *
 * 测试向量是合成的：一段虚构的 QRC XML，用参考实现加密后写成常量，
 * 不包含任何真实的腾讯响应数据。
 * 用 vm 载入真实文件，测的就是浏览器里跑的那一份。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const QRC_MODULE = path.join(__dirname, '..', 'js', 'provider', 'qq_qrc.js');
const PAKO_MODULE = path.join(
  __dirname,
  '..',
  'js',
  'vendor',
  'pako_inflate.min.js'
);

const CIPHER_HEX =
  '6f2ade97f0271021c065a13752e392bfdb8c128de88c36b0e88bdd875ed55b305cc809a9deeecbf6b594a56ca83255cea1f127996d51a6e8d2fd6f1c7424b23479078fdcdee9b27d6dd825807a5ab168631681b21b3e9c49f4da868cee75ad772e6d5866a9a5cbb079649f3481f06611dacae193427e03af3a0eed32298a7c7ade328364500fa1a87fd248eadf90758a4f3418351fd2beedcb85c29758d4e925b6923d038b28973548abeeca85930100b5b768b71fa6ef48e5e85fb2b4c31a44d9d182b6f954e80901c28b3c7f1ffcb1';
const BLOCK_VECTORS = [
  { cipher: '6f2ade97f0271021', plain: '789c3d8f310f8230' },
  { cipher: 'c065a13752e392bf', plain: '1085777e45d3a94d' },
];
const XML_SHA256 =
  '8798ace3f5e8b324a35e09f0daa3a4e7838b0e882a6493c2f82213d154de98c1';
const LYRIC_CONTENT =
  '[ti:test]\n[ar:nobody]\n[offset:0]\n[0,600]a(0,200) (200,100)b(300,300)\n[600,400]((600,100)c(700,300))(1000,0)\n';
const XML =
  '<?xml version="1.0" encoding="utf-8"?>\n<QrcInfos>\n<QrcHeadInfo SaveTime="1" Version="100"/>\n<LyricInfo LyricCount="1">\n<Lyric_1 LyricType="1" LyricContent="' +
  LYRIC_CONTENT +
  '"/>\n</LyricInfo>\n</QrcInfos>';

function loadQrc({ native }) {
  const sandbox = { console, Uint8Array, TextDecoder, Response, Blob };
  if (native) sandbox.DecompressionStream = DecompressionStream;
  vm.createContext(sandbox);
  if (!native) {
    vm.runInContext(fs.readFileSync(PAKO_MODULE, 'utf8'), sandbox, {
      filename: PAKO_MODULE,
    });
  }
  vm.runInContext(fs.readFileSync(QRC_MODULE, 'utf8'), sandbox, {
    filename: QRC_MODULE,
  });
  return sandbox;
}

const native = loadQrc({ native: true });
const { qrcDecryptBlock, qrcDecrypt, extractQrcLyricContent } = native;

function toHex(bytes) {
  return Buffer.from(Array.from(bytes)).toString('hex');
}

function fromHex(hex) {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

describe('qrcDecryptBlock：定制三重 DES 解密单个 8 字节块', () => {
  test('合成密文块解出与参考实现一致的明文（首块是 zlib 头 78 9c）', () => {
    BLOCK_VECTORS.forEach((vector) => {
      assert.strictEqual(
        toHex(qrcDecryptBlock(fromHex(vector.cipher))),
        vector.plain
      );
    });
  });

  test('块长度不是 8 字节时抛异常', () => {
    assert.throws(() => qrcDecryptBlock(new Uint8Array(7)));
    assert.throws(() => qrcDecryptBlock(new Uint8Array(16)));
  });
});

describe('qrcDecrypt：hex 密文 → XML 明文', () => {
  test('原生 DecompressionStream：解出的 XML 与参考一致', async () => {
    const xml = await qrcDecrypt(CIPHER_HEX);
    assert.strictEqual(xml, XML);
    assert.strictEqual(
      crypto.createHash('sha256').update(xml, 'utf8').digest('hex'),
      XML_SHA256
    );
  });

  test('没有 DecompressionStream 时回退 pako，结果一致', async () => {
    const fallback = loadQrc({ native: false });
    assert.strictEqual(typeof fallback.DecompressionStream, 'undefined');
    assert.strictEqual(typeof fallback.pako.inflate, 'function');
    assert.strictEqual(await fallback.qrcDecrypt(CIPHER_HEX), XML);
  });

  test('空串、奇数长度、非 hex、长度不是 8 的倍数都 reject（上层回退 LRC）', async () => {
    await assert.rejects(() => qrcDecrypt(''));
    await assert.rejects(() => qrcDecrypt('abc'));
    await assert.rejects(() => qrcDecrypt('zz'.repeat(8)));
    await assert.rejects(() => qrcDecrypt('00'.repeat(9)));
    await assert.rejects(() => qrcDecrypt(null));
  });

  test('密文损坏时 zlib 解压失败也是 reject，不是挂起', async () => {
    await assert.rejects(() => qrcDecrypt('00'.repeat(16)));
  });
});

describe('extractQrcLyricContent：从 XML 里截出 LyricContent', () => {
  test('合成样本：取出头部标签与逐字行，不含 XML 结尾', async () => {
    const content = extractQrcLyricContent(await qrcDecrypt(CIPHER_HEX));
    assert.strictEqual(content, LYRIC_CONTENT);
  });

  test('属性值里出现未转义的双引号时，仍以最后一个结尾标记截断（不用 XML 解析器）', () => {
    const xml =
      '<Lyric_1 LyricType="1" LyricContent="[0,10]say "hi"(0,10)\n"/>\n</LyricInfo>';
    assert.strictEqual(
      extractQrcLyricContent(xml),
      '[0,10]say "hi"(0,10)\n'
    );
  });

  test('没有 LyricContent 时返回空串', () => {
    assert.strictEqual(extractQrcLyricContent('<QrcInfos></QrcInfos>'), '');
    assert.strictEqual(extractQrcLyricContent(null), '');
    assert.strictEqual(extractQrcLyricContent(''), '');
  });
});
