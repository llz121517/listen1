/**
 * 网易云 provider 的回归测试：
 *
 * 1. 预置 cookie 的路径约束。9105790 让三张预置 cookie 在根路径落盘后，上游原版会卡在
 *    「cookie 齐全 → ne_ensure_cookie 不回调」的死锁里（跨版本副作用）。所以预置 cookie
 *    只允许挂在 /api 下：我们的搜索请求 /api/search/pc 照常带上，上游按根路径
 *    `https://music.163.com` 查不到、仍走「缺失」分支。
 * 2. ne_ensure_cookie 在 cookie 齐全 / 部分缺失时都必须回调（之前修过的死锁）。
 * 3. 歌单详情走 v6、曲目详情走 v3；搜索仍走旧的 /api/search/pc（依赖 /api 下的 cookie）。
 *
 * 被测对象是真实的 js/provider/netease.js，这里用 vm 沙箱补上浏览器全局
 * （async / axios / cookie* / btoa / URLSearchParams），cookie jar 复刻 chrome.cookies
 * 的「按路径匹配」语义，不复制业务逻辑。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const NETEASE_SOURCE = path.join(ROOT, 'js', 'provider', 'netease.js');
const asyncLib = require('../js/vendor/async.min');

const LEGACY_COOKIE_PATH = '/api';
const PLAYLIST_DETAIL_URL = 'https://music.163.com/weapi/v6/playlist/detail';
const SONG_DETAIL_URL = 'https://music.163.com/weapi/v3/song/detail';
const SEARCH_URL = 'https://music.163.com/api/search/pc';

const PRESET_COOKIES = ['_ntes_nuid', '_ntes_nnid3', 'NMTID'];

// 复刻 chrome.cookies.get 的路径匹配：请求路径等于 cookie path 或以「cookiePath/」开头
function cookieMatchesPath(cookiePath, requestPath) {
  if (requestPath === cookiePath) {
    return true;
  }
  const prefix = cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`;
  return requestPath.startsWith(prefix);
}

// 复刻 chrome.cookies.get / chrome.cookies.set 的异步、路径语义与回调签名：
//   get  → 未命中时回调 null（根路径查不到 /api 下的 cookie）
//   set  → 成功时回调 Cookie 对象（注意这是「第一个参数」，不是 error）
function createCookieJar(initial = []) {
  const cookies = initial.map((cookie) => ({ path: '/', ...cookie }));
  const writeAttempts = [];

  return {
    cookies,
    writeAttempts,
    cookieGet: (request, callback) => {
      setTimeout(() => {
        const requestPath = new URL(request.url).pathname || '/';
        const found = cookies.find(
          (cookie) =>
            cookie.name === request.name &&
            cookieMatchesPath(cookie.path, requestPath)
        );
        callback(found ? { ...found } : null);
      }, 0);
    },
    cookieSet: (cookie, callback) => {
      writeAttempts.push({ ...cookie });
      setTimeout(() => {
        const cookiePath = cookie.path || '/';
        const record = {
          name: cookie.name,
          value: cookie.value,
          path: cookiePath,
          secure: cookie.secure,
        };
        const index = cookies.findIndex(
          (item) => item.name === cookie.name && item.path === cookiePath
        );
        if (index >= 0) {
          cookies[index] = record;
        } else {
          cookies.push(record);
        }
        callback({ ...record });
      }, 0);
    },
  };
}

function cookieGetAsync(jar, request) {
  return new Promise((resolve) => jar.cookieGet(request, resolve));
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

function createNetease({ jar, axios }) {
  const netease = loadNetease({
    cookieGet: jar.cookieGet,
    cookieSet: jar.cookieSet,
    axios,
  });
  // 不加载 forge：weapi 只负责产出 body，测试不关心密文
  netease.weapi = () => ({ params: 'stub-params', encSecKey: 'stub-key' });
  return netease;
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

function callSearch(netease, url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('search 没有回调（搜索请求没有发出去）')),
      timeoutMs
    );
    netease.search(url).success((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

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

// 旧搜索接口 /api/search/pc 的返回结构（songs 用 artists / album 字段）
const SEARCH_BODY = {
  data: {
    result: {
      songCount: 1,
      songs: [
        {
          id: 1901371647,
          name: '孤勇者',
          fee: 1,
          artists: [{ id: 1, name: '陈奕迅' }],
          album: {
            id: 11,
            name: '孤勇者',
            picUrl: 'http://p1.music.126.net/s.jpg',
          },
        },
      ],
    },
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
      if (url === SEARCH_URL) {
        return Promise.resolve(SEARCH_BODY);
      }
      return Promise.reject(new Error(`unexpected request: ${url}`));
    },
  };
}

function presetCookieRecords() {
  return PRESET_COOKIES.map((name) => ({
    name,
    value: `${name}-value`,
    path: LEGACY_COOKIE_PATH,
  }));
}

describe('网易云预置 cookie（ne_ensure_cookie）', () => {
  test('三张 cookie 都限定在 /api，上游按根路径查不到（跨版本兼容）', async () => {
    const jar = createCookieJar();
    const netease = createNetease({ jar, axios: createAxiosStub() });

    await callEnsureCookie(netease);

    assert.deepStrictEqual(
      jar.writeAttempts.map((cookie) => cookie.name).sort(),
      [...PRESET_COOKIES].sort()
    );
    jar.writeAttempts.forEach((cookie) => {
      assert.strictEqual(cookie.path, LEGACY_COOKIE_PATH, '只能写 /api 路径');
      assert.strictEqual(cookie.secure, true, 'SameSite=None 必须是 Secure');
    });

    const checks = await Promise.all(
      PRESET_COOKIES.map(async (name) => ({
        name,
        // 模拟上游的检查方式：url 只有根路径
        upstream: await cookieGetAsync(jar, {
          url: 'https://music.163.com',
          name,
        }),
        // 我们自己的检查：落在 /api 路径上
        ours: await cookieGetAsync(jar, {
          url: `https://music.163.com${LEGACY_COOKIE_PATH}`,
          name,
        }),
      }))
    );
    checks.forEach((check) => {
      assert.strictEqual(
        check.upstream,
        null,
        '上游按根路径必须查不到，否则会触发它的“cookie 齐全不回调”死锁'
      );
      assert.ok(check.ours, '我们的 /api 检查必须能查到');
    });
  });

  test('三张 /api cookie 齐全时仍然回调，且不重复写入', async () => {
    const jar = createCookieJar(presetCookieRecords());
    const netease = createNetease({ jar, axios: createAxiosStub() });

    await callEnsureCookie(netease);

    assert.deepStrictEqual(
      jar.writeAttempts,
      [],
      'cookie 齐全时不应再重复写入'
    );
  });

  test('只有部分 cookie 缺失时，只补缺失的那张，并回调一次', async () => {
    const jar = createCookieJar(
      presetCookieRecords().filter((cookie) => cookie.name !== '_ntes_nnid3')
    );
    const netease = createNetease({ jar, axios: createAxiosStub() });

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
    assert.deepStrictEqual(
      jar.writeAttempts.map((cookie) => cookie.name),
      ['_ntes_nnid3']
    );
    assert.strictEqual(
      jar.cookies.find((cookie) => cookie.name === '_ntes_nuid').value,
      '_ntes_nuid-value',
      '已有 cookie 不应被覆盖'
    );
  });
});

describe('网易云歌单加载', () => {
  test('cookie 齐全时仍发出 v6 歌单详情请求，并返回曲目', async () => {
    const jar = createCookieJar(presetCookieRecords());
    const axios = createAxiosStub();
    const netease = createNetease({ jar, axios });

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

describe('网易云搜索', () => {
  test('搜索仍走旧 /api/search/pc，并带上 /api 路径的预置 cookie', async () => {
    const jar = createCookieJar();
    const axios = createAxiosStub();
    const netease = createNetease({ jar, axios });

    const data = await callSearch(
      netease,
      '/search?keywords=周杰伦&curpage=1&type=0'
    );

    assert.deepStrictEqual(
      axios.requests.map((request) => request.url),
      [SEARCH_URL],
      '搜索接口不改，仍走 /api/search/pc'
    );
    const { body } = axios.requests[0];
    assert.strictEqual(body.get('s'), '周杰伦');
    assert.strictEqual(body.get('offset'), '0');
    assert.strictEqual(body.get('type'), '1', '歌曲搜索对应接口 type=1');
    assert.deepStrictEqual(
      jar.writeAttempts.map((cookie) => cookie.path),
      [LEGACY_COOKIE_PATH, LEGACY_COOKIE_PATH, LEGACY_COOKIE_PATH],
      '搜索前补写的预置 cookie 也只能在 /api 路径'
    );
    assert.deepStrictEqual(
      data.result.map((song) => ({
        id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        img_url: song.img_url,
        url: song.url,
      })),
      [
        {
          id: 'netrack_1901371647',
          title: '孤勇者',
          artist: '陈奕迅',
          album: '孤勇者',
          img_url: 'http://p1.music.126.net/s.jpg',
          url: '',
        },
      ]
    );
  });
});
