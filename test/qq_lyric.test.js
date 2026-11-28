/* global DecompressionStream */
/**
 * QQ provider 的歌词获取（js/provider/qq.js 的 lyric / qrc_word_lyric）：
 * LRC 与 QRC 并发取，任何一路失败都不能让回调丢失，QRC 失败时 wordLyric 为 null（回退 LRC）。
 *
 * 用 vm 载入真实的 qq_qrc.js 与 qq.js，axios 用替身；密文是合成的虚构歌词，
 * 不含任何真实腾讯响应数据（与 test/qrc_decrypt.test.js 同一份向量）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const CALLBACK_TIMEOUT = 2000;
const LYRIC_URL = '/lyric?track_id=qqtrack_003abc&album_id=&lyric_url=&tlyric_url=';

const CIPHER_HEX =
  '6f2ade97f0271021c065a13752e392bfdb8c128de88c36b0e88bdd875ed55b305cc809a9deeecbf6b594a56ca83255cea1f127996d51a6e8d2fd6f1c7424b23479078fdcdee9b27d6dd825807a5ab168631681b21b3e9c49f4da868cee75ad772e6d5866a9a5cbb079649f3481f06611dacae193427e03af3a0eed32298a7c7ade328364500fa1a87fd248eadf90758a4f3418351fd2beedcb85c29758d4e925b6923d038b28973548abeeca85930100b5b768b71fa6ef48e5e85fb2b4c31a44d9d182b6f954e80901c28b3c7f1ffcb1';
const LYRIC_CONTENT =
  '[ti:test]\n[ar:nobody]\n[offset:0]\n[0,600]a(0,200) (200,100)b(300,300)\n[600,400]((600,100)c(700,300))(1000,0)\n';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 按调用顺序记录请求的 axios 替身：get / post 各自给一个处理函数。 */
function fakeAxios({ get, post }) {
  const calls = { get: [], post: [] };
  return {
    calls,
    get: (url) => {
      calls.get.push(url);
      return get(url);
    },
    post: (url, body) => {
      calls.post.push({ url, body });
      return post(url, body);
    },
  };
}

function loadQq(axios, { withQrc = true } = {}) {
  const sandbox = {
    axios,
    console,
    Promise,
    Uint8Array,
    TextDecoder,
    DecompressionStream,
    Response,
    Blob,
    URLSearchParams,
    getParameterByName: (key, url) =>
      new URLSearchParams(String(url).split('?')[1] || '').get(key),
  };
  vm.createContext(sandbox);
  const files = withQrc
    ? ['js/provider/qq_qrc.js', 'js/provider/qq.js']
    : ['js/provider/qq.js'];
  files.forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, {
      filename: file,
    });
  });
  return vm.runInContext('qq', sandbox);
}

function fetchLyric(provider) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('lyric 在超时内没有回调（调用方会永久挂起）')),
      CALLBACK_TIMEOUT
    );
    provider.lyric(LYRIC_URL).success((result) => {
      clearTimeout(timer);
      resolve(plain(result));
    });
  });
}

const okLrc = () =>
  Promise.resolve({
    data: { lyric: '[00:01.00]a b', trans: '//\n[00:01.00]译文' },
  });
const qrcResponse = (info) => () =>
  Promise.resolve({ data: { req: { code: 0, data: info } } });
const reject = () => Promise.reject(new Error('Request failed'));

describe('QQ 歌词：LRC 与 QRC 并发获取', () => {
  test('qrc=1：返回 { format: qrc, text }，LRC 与翻译照常带上', async () => {
    const axios = fakeAxios({
      get: okLrc,
      post: qrcResponse({ qrc: 1, crypt: 1, lyric: CIPHER_HEX }),
    });
    const result = await fetchLyric(loadQq(axios));
    assert.deepStrictEqual(result.wordLyric, {
      format: 'qrc',
      text: LYRIC_CONTENT,
    });
    assert.strictEqual(result.lyric, '[00:01.00]a b');
    assert.ok(!result.tlyric.includes('//'), '翻译里的 // 占位要去掉');
    assert.ok(result.tlyric.includes('译文'));
  });

  test('QRC 请求打到 musicu.fcg 的 GetPlayLyricInfo，只传 songMID（不带 songID / sign）', async () => {
    const axios = fakeAxios({
      get: okLrc,
      post: qrcResponse({ qrc: 1, lyric: CIPHER_HEX }),
    });
    await fetchLyric(loadQq(axios));
    assert.strictEqual(axios.calls.post.length, 1);
    const { url, body } = plain(axios.calls.post[0]);
    assert.strictEqual(url, 'https://u.y.qq.com/cgi-bin/musicu.fcg');
    assert.strictEqual(body.req.module, 'music.musichallSong.PlayLyricInfo');
    assert.strictEqual(body.req.method, 'GetPlayLyricInfo');
    assert.strictEqual(body.req.param.songMID, '003abc');
    assert.strictEqual(body.req.param.qrc, 1);
    assert.strictEqual(body.req.param.crypt, 1);
    assert.strictEqual(body.req.param.songID, undefined);
  });

  test('qrc=0（纯音乐 / 没有逐字数据）：wordLyric 为 null，LRC 照常', async () => {
    const axios = fakeAxios({
      get: okLrc,
      post: qrcResponse({ qrc: 0, crypt: 1, lyric: CIPHER_HEX }),
    });
    const result = await fetchLyric(loadQq(axios));
    assert.strictEqual(result.wordLyric, null);
    assert.strictEqual(result.lyric, '[00:01.00]a b');
  });

  test('密文损坏：解密失败静默回退，wordLyric 为 null', async () => {
    const axios = fakeAxios({
      get: okLrc,
      post: qrcResponse({ qrc: 1, lyric: '00'.repeat(16) }),
    });
    const result = await fetchLyric(loadQq(axios));
    assert.strictEqual(result.wordLyric, null);
    assert.strictEqual(result.lyric, '[00:01.00]a b');
  });

  test('QRC 响应缺 req / data 时回退，不抛异常', async () => {
    const payloads = [{ data: {} }, { data: { req: {} } }, {}, null];
    const results = await Promise.all(
      payloads.map((payload) =>
        fetchLyric(
          loadQq(
            fakeAxios({
              get: okLrc,
              post: () => Promise.resolve(payload),
            })
          )
        )
      )
    );
    results.forEach((result) => {
      assert.strictEqual(result.wordLyric, null);
    });
  });

  test('QRC 请求失败：只丢逐字，LRC 与翻译不受影响', async () => {
    const axios = fakeAxios({ get: okLrc, post: reject });
    const result = await fetchLyric(loadQq(axios));
    assert.strictEqual(result.wordLyric, null);
    assert.strictEqual(result.lyric, '[00:01.00]a b');
  });

  test('LRC 请求失败：回调照样触发，逐字仍然可用', async () => {
    const axios = fakeAxios({
      get: reject,
      post: qrcResponse({ qrc: 1, lyric: CIPHER_HEX }),
    });
    const result = await fetchLyric(loadQq(axios));
    assert.strictEqual(result.lyric, '');
    assert.strictEqual(result.tlyric, '');
    assert.strictEqual(result.wordLyric.format, 'qrc');
  });

  test('两路都失败：仍然回调（空歌词 + null），不会永久挂起', async () => {
    const axios = fakeAxios({ get: reject, post: reject });
    const result = await fetchLyric(loadQq(axios));
    assert.deepStrictEqual(result, { lyric: '', tlyric: '', wordLyric: null });
  });

  test('LRC 响应没有 trans 字段（旧代码会抛 TypeError 丢回调）', async () => {
    const axios = fakeAxios({
      get: () => Promise.resolve({ data: { lyric: '[00:01.00]a' } }),
      post: qrcResponse({ qrc: 0 }),
    });
    const result = await fetchLyric(loadQq(axios));
    assert.strictEqual(result.tlyric, '');
    assert.strictEqual(result.lyric, '[00:01.00]a');
  });

  test('LRC 响应体为空 / 缺失也不抛异常', async () => {
    const payloads = [{ data: {} }, { data: null }, null];
    const results = await Promise.all(
      payloads.map((payload) =>
        fetchLyric(
          loadQq(
            fakeAxios({
              get: () => Promise.resolve(payload),
              post: qrcResponse({ qrc: 0 }),
            })
          )
        )
      )
    );
    results.forEach((result) => {
      assert.strictEqual(result.lyric, '');
    });
  });

  test('旧接口没有 trans 时，用 GetPlayLyricInfo 解密出的翻译补上（去掉 // 占位）', async () => {
    const TRANS_HEX =
      '3c80fea4c8965b32c84b90f1b6368823ea7c6c5dec3d3c830fbc2bcebb91c5d5f74451dac223aeda9a871d4988acebbadf206e4397c94992dde57040b3b01d56';
    const axios = fakeAxios({
      get: () => Promise.resolve({ data: { lyric: '[00:01.00]a' } }),
      post: qrcResponse({
        qrc: 1,
        crypt: 1,
        lyric: CIPHER_HEX,
        trans: TRANS_HEX,
      }),
    });
    const result = await fetchLyric(loadQq(axios));
    assert.ok(result.tlyric.includes('[00:01.00]译文一'));
    assert.ok(result.tlyric.includes('[00:02.00]译文二'));
    assert.ok(!result.tlyric.includes('//'));
    assert.strictEqual(plain(axios.calls.post[0]).body.req.param.trans, 1);
  });

  test('旧接口已有 trans 时优先用旧接口的翻译', async () => {
    const axios = fakeAxios({
      get: okLrc,
      post: qrcResponse({ qrc: 1, lyric: CIPHER_HEX, trans: '00'.repeat(16) }),
    });
    const result = await fetchLyric(loadQq(axios));
    assert.ok(result.tlyric.includes('译文'));
  });

  test('解密模块没加载（qq_qrc.js 缺失）：不发 QRC 请求，wordLyric 为 null', async () => {
    const axios = fakeAxios({
      get: okLrc,
      post: qrcResponse({ qrc: 1, lyric: CIPHER_HEX }),
    });
    const result = await fetchLyric(loadQq(axios, { withQrc: false }));
    assert.strictEqual(result.wordLyric, null);
    assert.strictEqual(axios.calls.post.length, 0);
    assert.strictEqual(result.lyric, '[00:01.00]a b');
  });
});
