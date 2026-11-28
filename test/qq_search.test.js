/**
 * QQ provider 的歌曲搜索（js/provider/qq.js 的 search）：
 * musicu.fcg 的桌面搜索接口会对未登录请求随机回 req.code=2001（空结果），
 * 所以歌曲搜索同时并行请求旧的 search_for_qq_cp（无需登录），谁先给出非空结果用谁。
 * 任何情况下回调只触发一次，两路都失败 / 都为空时回空结果（自动切源依赖这个回调）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const SEARCH_URL = '/search?keywords=test&curpage=2&type=0';
const PLAYLIST_URL = '/search?keywords=test&curpage=1&type=1';

const legacySong = {
  songmid: 'm1',
  songname: '七里香',
  singer: [{ name: '周杰伦', mid: 's1' }],
  albumname: '七里香',
  albummid: 'a1',
  switch: 104193,
};
const legacyOk = {
  data: { code: 0, data: { song: { totalnum: 600, list: [legacySong] } } },
};
const legacyEmpty = {
  data: { code: 0, data: { song: { totalnum: 0, list: [] } } },
};
const musicuThrottled = {
  data: {
    req: {
      code: 2001,
      data: {
        body: { song: { list: [] }, songlist: { list: [] } },
        meta: { sum: 0 },
      },
    },
  },
};
const musicuOk = {
  data: {
    req: {
      code: 0,
      data: {
        body: {
          song: {
            list: [
              {
                mid: 'm2',
                name: 'N',
                singer: [{ name: 'S', mid: 's2' }],
                album: { name: 'A', mid: 'a2' },
              },
            ],
          },
        },
        meta: { sum: 5 },
      },
    },
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const after = (ms, value) => () => sleep(ms).then(() => value);
const fail = () => Promise.reject(new Error('Request failed'));

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

function loadQq(axios) {
  const sandbox = {
    axios,
    console,
    Promise,
    URLSearchParams,
    DOMParser: class {
      parseFromString(value) {
        return { body: { textContent: value } };
      }
    },
    getParameterByName: (key, url) =>
      new URLSearchParams(String(url).split('?')[1] || '').get(key),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js/provider/qq.js'), 'utf8'),
    sandbox,
    { filename: 'js/provider/qq.js' }
  );
  return vm.runInContext('qq', sandbox);
}

/** 调用 search，返回第一次回调的结果；等一会儿确认回调只触发了一次。 */
async function runSearch(axios, url = SEARCH_URL) {
  const provider = loadQq(axios);
  const results = [];
  provider.search(url).success((result) => {
    results.push(JSON.parse(JSON.stringify(result)));
  });
  await sleep(150);
  assert.strictEqual(results.length, 1, '回调必须且只能触发一次');
  return results[0];
}

describe('QQ 歌曲搜索：musicu 与 search_for_qq_cp 双路并行', () => {
  test('musicu 被限流（2001）时用旧接口的结果，并转成统一 track', async () => {
    const axios = fakeAxios({
      post: () => Promise.resolve(musicuThrottled),
      get: () => Promise.resolve(legacyOk),
    });
    const result = await runSearch(axios);
    assert.strictEqual(result.result.length, 1);
    assert.strictEqual(result.result[0].id, 'qqtrack_m1');
    assert.strictEqual(result.result[0].title, '七里香');
    assert.strictEqual(result.result[0].artist, '周杰伦');
    assert.strictEqual(result.result[0].album_id, 'qqalbum_a1');
    assert.strictEqual(result.total, 600);
    assert.strictEqual(result.type, '0');
  });

  test('旧接口请求带关键词、页码与每页 30 条', async () => {
    const axios = fakeAxios({
      post: () => Promise.resolve(musicuThrottled),
      get: () => Promise.resolve(legacyOk),
    });
    await runSearch(axios);
    assert.strictEqual(axios.calls.get.length, 1);
    const url = axios.calls.get[0];
    assert.ok(url.includes('c.y.qq.com/soso/fcgi-bin/search_for_qq_cp'));
    assert.ok(url.includes('w=test'));
    assert.ok(url.includes('p=2'));
    assert.ok(url.includes('n=30'));
    assert.ok(url.includes('format=json'));
    assert.strictEqual(axios.calls.post.length, 1, 'musicu 也要同时发出');
  });

  test('旧接口失败时用 musicu 的结果', async () => {
    const axios = fakeAxios({
      post: () => Promise.resolve(musicuOk),
      get: fail,
    });
    const result = await runSearch(axios);
    assert.strictEqual(result.result[0].id, 'qqtrack_m2');
    assert.strictEqual(result.total, 5);
  });

  test('先返回空的一路不抢答：等另一路的非空结果', async () => {
    const axios = fakeAxios({
      post: () => Promise.resolve(musicuThrottled),
      get: after(40, legacyOk),
    });
    const result = await runSearch(axios);
    assert.strictEqual(result.result[0].id, 'qqtrack_m1');
  });

  test('两路都有结果时先到的非空结果胜出', async () => {
    const axios = fakeAxios({
      post: after(40, musicuOk),
      get: () => Promise.resolve(legacyOk),
    });
    const result = await runSearch(axios);
    assert.strictEqual(result.result[0].id, 'qqtrack_m1');
  });

  test('两路都为空：回空结果，回调只一次', async () => {
    const axios = fakeAxios({
      post: () => Promise.resolve(musicuThrottled),
      get: () => Promise.resolve(legacyEmpty),
    });
    const result = await runSearch(axios);
    assert.deepStrictEqual(result.result, []);
    assert.strictEqual(result.total, 0);
  });

  test('两路都失败：仍然回空结果（自动切源不会挂起）', async () => {
    const axios = fakeAxios({ post: fail, get: fail });
    const result = await runSearch(axios);
    assert.deepStrictEqual(result.result, []);
    assert.strictEqual(result.total, 0);
  });

  test('旧接口响应体缺失 / 结构异常也不抛异常', async () => {
    const axios = fakeAxios({
      post: () => Promise.resolve(musicuOk),
      get: () => Promise.resolve({ data: null }),
    });
    const result = await runSearch(axios);
    assert.strictEqual(result.result[0].id, 'qqtrack_m2');
  });

  test('歌单搜索（type=1）只走 musicu，不请求旧接口', async () => {
    const axios = fakeAxios({
      post: () => Promise.resolve(musicuThrottled),
      get: () => Promise.resolve(legacyOk),
    });
    const result = await runSearch(axios, PLAYLIST_URL);
    assert.strictEqual(axios.calls.get.length, 0);
    assert.deepStrictEqual(result.result, []);
  });
});
