/**
 * 网易云 provider 的两条回归线：
 *
 * 1. `ne_ensure_cookie()` 的放行条件。9105790 给预置 cookie 加上 `secure: true` 之后
 *    三个 cookie 才真正落盘；而旧实现只在「至少缺一个 cookie」时调用 callback，
 *    于是 cookie 齐全（正常状态）时 callback 永不触发，ne_get_playlist 里的请求
 *    也就永远发不出去 —— 歌单页一直停在 loading。
 *
 * 2. 歌单详情接口版本。网页端与第三方库现在都取 `weapi/v6/playlist/detail`，
 *    v3 是同一后端的老前缀；曲目详情仍以 `weapi/v3/song/detail` 为现行接口。
 *
 * 被测对象是真实的 js/provider/netease.js，这里用 vm 沙箱补上浏览器全局
 * （async / axios / cookie* / btoa / URLSearchParams），不复制业务逻辑。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const NETEASE_SOURCE = path.join(ROOT, 'js', 'provider', 'netease.js');
const asyncLib = require('../js/vendor/async.min');

const PLAYLIST_DETAIL_URL = 'https://music.163.com/weapi/v6/playlist/detail';
const SONG_DETAIL_URL = 'https://music.163.com/weapi/v3/song/detail';

// 复刻 chrome.cookies.get / chrome.cookies.set 的异步与回调签名：
//   get  → 未命中时回调 null
//   set  → 成功时回调 Cookie 对象（注意这是「第一个参数」，不是 error）
function createCookieJar(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writeAttempts = [];

  return {
    store,
    writeAttempts,
    cookieGet: (request, callback) => {
      setTimeout(() => {
        callback(
          store.has(request.name)
            ? { name: request.name, value: store.get(request.name) }
            : null
        );
      }, 0);
    },
    cookieSet: (cookie, callback) => {
      writeAttempts.push(cookie.name);
      setTimeout(() => {
        store.set(cookie.name, cookie.value);
        callback({ name: cookie.name, value: cookie.value });
      }, 0);
    },
  };
}

function loadNetease({ cookieGet, cookieSet, axios }) {
  const sandbox = {
    async: asyncLib,
    axios,
    cookieGet,
    cookieSet,
    cookieRemove: (cookie, callback) => callback && callback(null),
    getParameterByName: (name, url) => {
      const query = String(url).split('?')[1] || '';
      return new URLSearchParams(query).get(name);
    },
    btoa,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(
    `${fs.readFileSync(
      NETEASE_SOURCE,
      'utf8'
    )}\n;globalThis.__netease = netease;`,
    context,
    { filename: NETEASE_SOURCE }
  );
  return sandbox.__netease;
}

function callEnsureCookie(netease, timeoutMs = 800) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ne_ensure_cookie 没有调用 callback')),
      timeoutMs
    );
    netease.ne_ensure_cookie(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function callGetPlaylist(netease, url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ne_get_playlist 没有回调（歌单请求没有发出去）')),
      timeoutMs
    );
    netease.get_playlist(url).success((playlist) => {
      clearTimeout(timer);
      resolve(playlist);
    });
  });
}

const PRESET_COOKIES = ['_ntes_nuid', '_ntes_nnid3', 'NMTID'];

const PLAYLIST_BODY = {
  data: {
    playlist: {
      id: 3778678,
      name: '热歌榜',
      coverImgUrl: 'http://p1.music.126.net/cover.jpg',
      trackCount: 2,
      trackIds: [{ id: 101 }, { id: 102 }],
    },
  },
};

const SONGS_BODY = {
  data: {
    songs: [
      {
        id: 101,
        name: '歌一',
        ar: [{ id: 1, name: '歌手一' }],
        al: { id: 11, name: '专辑一', picUrl: 'http://p1.music.126.net/a.jpg' },
      },
      {
        id: 102,
        name: '歌二',
        ar: [{ id: 2, name: '歌手二' }],
        al: { id: 12, name: '专辑二', picUrl: 'http://p1.music.126.net/b.jpg' },
      },
    ],
  },
};

function createAxiosStub() {
  const requests = [];
  return {
    requests,
    post: (url, body) => {
      requests.push({ url, body });
      if (url === PLAYLIST_DETAIL_URL) {
        return Promise.resolve(PLAYLIST_BODY);
      }
      if (url === SONG_DETAIL_URL) {
        return Promise.resolve(SONGS_BODY);
      }
      return Promise.reject(new Error(`unexpected request: ${url}`));
    },
  };
}

function createNeteaseWithAllCookies() {
  const jar = createCookieJar(
    Object.fromEntries(PRESET_COOKIES.map((name) => [name, `${name}-value`]))
  );
  const axios = createAxiosStub();
  const netease = loadNetease({
    cookieGet: jar.cookieGet,
    cookieSet: jar.cookieSet,
    axios,
  });
  // 不加载 forge：weapi 只负责产出 body，测试不关心密文
  netease.weapi = () => ({ params: 'stub-params', encSecKey: 'stub-key' });
  return { jar, axios, netease };
}

describe('网易云预置 cookie（ne_ensure_cookie）', () => {
  test('三个 cookie 齐全时仍然回调（回归：9105790 之后歌单卡加载）', async () => {
    const { jar, netease } = createNeteaseWithAllCookies();

    await callEnsureCookie(netease);

    assert.deepStrictEqual(
      jar.writeAttempts,
      [],
      'cookie 齐全时不应再重复写入'
    );
  });

  test('只有部分 cookie 缺失时，只补缺失的那张，并回调一次', async () => {
    const jar = createCookieJar({ _ntes_nuid: 'kept', NMTID: '0' });
    const netease = loadNetease({
      cookieGet: jar.cookieGet,
      cookieSet: jar.cookieSet,
      axios: createAxiosStub(),
    });
    netease.weapi = () => ({ params: 'stub-params', encSecKey: 'stub-key' });

    let calls = 0;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('ne_ensure_cookie 没有调用 callback')),
        800
      );
      netease.ne_ensure_cookie(() => {
        calls += 1;
        clearTimeout(timer);
        resolve();
      });
    });

    assert.strictEqual(calls, 1, 'callback 应当只调用一次');
    assert.deepStrictEqual(jar.writeAttempts, ['_ntes_nnid3']);
    assert.strictEqual(
      jar.store.get('_ntes_nuid'),
      'kept',
      '已有 cookie 不应被覆盖'
    );
    assert.deepStrictEqual(
      PRESET_COOKIES.filter((name) => !jar.store.has(name)),
      []
    );
  });
});

describe('网易云歌单加载', () => {
  test('cookie 齐全时仍发出 v6 歌单详情请求，并返回曲目', async () => {
    const { axios, netease } = createNeteaseWithAllCookies();

    const playlist = await callGetPlaylist(
      netease,
      '/playlist?list_id=neplaylist_3778678'
    );

    assert.deepStrictEqual(
      axios.requests.map((request) => request.url),
      [PLAYLIST_DETAIL_URL, SONG_DETAIL_URL],
      '歌单详情走 v6，曲目详情仍走 v3'
    );
    assert.strictEqual(playlist.info.id, 'neplaylist_3778678');
    assert.strictEqual(playlist.info.title, '热歌榜');
    assert.strictEqual(
      playlist.info.cover_img_url,
      'http://p1.music.126.net/cover.jpg'
    );
    assert.deepStrictEqual(
      playlist.tracks.map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artist,
        source: track.source,
      })),
      [
        {
          id: 'netrack_101',
          title: '歌一',
          artist: '歌手一',
          source: 'netease',
        },
        {
          id: 'netrack_102',
          title: '歌二',
          artist: '歌手二',
          source: 'netease',
        },
      ]
    );
  });
});
