/**
 * 守卫测试：**任何 provider 在失败时都必须回调**。
 *
 * 为什么要有这一条：`js/loweb.js` 的自动切源把每个候选平台的 `search()` 包进一个
 * 「只有回调被调用才会 settle」的 Promise，再交给 `Promise.all`。只要有一个 provider
 * 在失败时（网络错误、412 风控、空响应体）既不调 success 也不调 failure，整条链路就
 * 永久挂起 —— 播放器早已 pause 掉旧音频并把状态广播成 paused，却永远等不到
 * 「标记不可播 + 跳下一首」的信号，表现为：静默暂停、点 play 没反应、也没有版权提示。
 *
 * 这类缺陷已经出现过三次（上游 6d1d8b5 给 kugou/netease 的 search 补 catch；
 * B 站搜索缺 catch 导致勾选 B 站作为切源候选后整条链路挂死）。所以这里不测具体业务，
 * 只锁一条契约：**失败必须回调**。
 *
 * 做法：用真实 provider 文件，配一个所有请求都 reject 的 axios（以及一个 200 但响应体
 * 为空的 axios），要求 bootstrap_track / search 在超时前给出 success 或 failure。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const asyncLib = require('../js/vendor/async.min');

/** 回调超时：provider 若挂死，这里会失败并明确指出是哪个平台。 */
const CALLBACK_TIMEOUT = 500;

const PROVIDERS = {
  kugou: 'js/provider/kugou.js',
  kuwo: 'js/provider/kuwo.js',
  qq: 'js/provider/qq.js',
  migu: 'js/provider/migu.js',
  taihe: 'js/provider/taihe.js',
  netease: 'js/provider/netease.js',
  bilibili: 'js/provider/bilibili.js',
  xiami: 'js/provider/xiami.js',
  localmusic: 'js/provider/localmusic.js',
};

/** 各平台的一条真实形状的 track（id 前缀决定 provider 里 slice 的位置）。 */
const TRACKS = {
  kugou: { id: 'kgtrack_abc123', source: 'kugou' },
  kuwo: { id: 'kwtrack_12345', source: 'kuwo' },
  qq: { id: 'qqtrack_003abc', source: 'qq' },
  migu: {
    id: 'mgtrack_6009',
    content_id: '6009',
    quality: '110000',
    source: 'migu',
  },
  taihe: { id: 'thtrack_12345', source: 'taihe' },
  netease: { id: 'netrack_1901371647', source: 'netease' },
  bilibili: { id: 'bitrack_v_BV1xx411c7m', source: 'bilibili' },
  xiami: { id: 'xmtrack_1', source: 'xiami' },
  localmusic: { id: 'lmtrack_1', source: 'localmusic', sound_url: 'file:///a.mp3' },
};

const SEARCH_URL = '/search?keywords=test&curpage=1&type=0';

/** 所有请求都 reject 的 axios：模拟 412 / 断网。 */
function failingAxios() {
  const reject = () =>
    Promise.reject(new Error('Request failed with status code 412'));
  const instance = {
    get: reject,
    post: reject,
    create: () => instance,
    interceptors: { request: { use: () => {} }, response: { use: () => {} } },
    defaults: {},
  };
  return instance;
}

/** 200 但响应体为空的 axios：模拟风控返回空 data。 */
function emptyBodyAxios() {
  const respond = () => Promise.resolve({ data: {} });
  const instance = {
    get: respond,
    post: respond,
    create: () => instance,
    interceptors: { request: { use: () => {} }, response: { use: () => {} } },
    defaults: {},
  };
  return instance;
}

/** forge 的最小替身：provider 只是拿它做签名 / 加密，返回什么不影响回调契约。 */
function createStubForge() {
  const md = () => ({
    create: () => {
      const api = {
        update: () => api,
        digest: () => ({ toHex: () => 'deadbeef', bytes: () => '' }),
      };
      return api;
    },
    update: () => md(),
  });
  const cipherResult = () => ({
    toHex: () => 'deadbeef',
    bytes: () => '',
    getBytes: () => '',
    length: () => 0,
  });
  return {
    md5: md(),
    md: { sha1: md(), sha256: md() },
    util: {
      encodeUtf8: (s) => s,
      bytesToHex: () => '00',
      hexToBytes: () => [],
      createBuffer: () => ({
        putBytes: () => {},
        getBytes: () => '1234567890abcdef1234567890abcdef',
        putBuffer: () => {},
        bytes: () => '',
        toHex: () => 'deadbeef',
        length: () => 16,
      }),
      encode64: () => 'base64',
    },
    cipher: {
      createCipher: () => ({
        start: () => {},
        update: () => {},
        finish: () => {},
        output: cipherResult(),
      }),
    },
    random: { getBytesSync: () => '12345678' },
    pbe: { opensslDeriveBytes: () => 'x' },
    jsbn: { BigInteger: class {} },
    pki: { publicKeyFromPem: () => ({ encrypt: () => '' }) },
  };
}

/** 在 vm 沙箱里加载真实 provider 文件，补上浏览器全局。 */
function loadProvider(name, axios, overrides = {}) {
  const file = PROVIDERS[name];
  const sandbox = {
    axios,
    async: asyncLib,
    forge: createStubForge(),
    // cookie 一律视为「没有」，让 provider 走取令牌 / 写 cookie 的失败分支
    cookieGet: (request, callback) => callback(null),
    cookieSet: (cookie, callback) => callback && callback(),
    cookieRemove: (request, callback) => callback && callback(),
    getParameterByName: (key, url) => {
      const query = String(url).split('?')[1] || '';
      return new URLSearchParams(query).get(key);
    },
    isElectron: () => false,
    localStorage: {
      getObject: () => null,
      setObject: () => {},
      getItem: () => null,
    },
    DOMParser: class {
      parseFromString(value) {
        return { body: { textContent: value } };
      }
    },
    window: { forge: null },
    URL,
    URLSearchParams,
    Blob: class {},
    console,
    setTimeout,
    clearTimeout,
    Promise,
    ...overrides,
  };
  sandbox.globalThis = sandbox;
  sandbox.window.forge = sandbox.forge;

  const context = vm.createContext(sandbox);
  vm.runInContext(
    `${fs.readFileSync(path.join(ROOT, file), 'utf8')}\n;globalThis.__provider = ${name};`,
    context,
    { filename: file }
  );
  // 把沙箱挂到 provider 上，方便个别用例替换全局（如 cookieSet 永不回调）
  Object.defineProperty(sandbox.__provider, '__sandbox', {
    value: sandbox,
    enumerable: false,
  });
  return sandbox.__provider;
}

/**
 * 调用一个回调式 API，要求它在超时前给出结果。
 * resolve 值形如 'success' / 'failure'，超时则 reject 并指出平台。
 */
function expectCallback(name, scenario, start) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${name} 的 ${scenario} 在 ${CALLBACK_TIMEOUT}ms 内没有任何回调（调用方会永久挂起）`
        )
      );
    }, CALLBACK_TIMEOUT);
    const settle = (outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    };
    try {
      start(() => settle('success'), () => settle('failure'));
    } catch (error) {
      clearTimeout(timer);
      reject(
        new Error(`${name} 的 ${scenario} 抛出异常而没回调：${error.message}`)
      );
    }
  });
}

const bootstrapScenarios = [
  ['请求全部失败（412 / 断网）', failingAxios],
  ['响应体为空（风控返回空 data）', emptyBodyAxios],
];

describe('provider 契约：bootstrap_track 失败时必须回调', () => {
  Object.keys(TRACKS).forEach((name) => {
    bootstrapScenarios.forEach(([scenario, makeAxios]) => {
      test(`${name}：${scenario}`, async () => {
        const provider = loadProvider(name, makeAxios());
        const outcome = await expectCallback(name, scenario, (ok, fail) =>
          provider.bootstrap_track(TRACKS[name], ok, fail)
        );
        assert.ok(
          outcome === 'success' || outcome === 'failure',
          '必须回调且只能是 success / failure'
        );
      });
    });
  });
});

describe('provider 契约：search 失败时必须回调（自动切源依赖它）', () => {
  // xiami 已停服、localmusic 不联网，两者本就不提供 search
  ['kugou', 'kuwo', 'qq', 'migu', 'taihe', 'netease', 'bilibili'].forEach(
    (name) => {
      test(`${name}：请求失败时回空结果`, async () => {
        const provider = loadProvider(name, failingAxios());
        const outcome = await expectCallback(name, 'search', (ok, fail) =>
          provider.search(SEARCH_URL).success(() => ok('success', fail))
        );
        assert.strictEqual(outcome, 'success');
      });
    }
  );
});

describe('provider 契约：cookie 读写异常时也不能挂死', () => {
  test('bilibili：cookieSet 永不回调时，search 仍会给出结果（靠兜底）', async () => {
    // cookieSet 故意永不回调，模拟扩展 API 静默失败
    const provider = loadProvider('bilibili', emptyBodyAxios(), {
      cookieSet: () => {},
    });

    let settled = false;
    provider.search(SEARCH_URL).success(() => {
      settled = true;
    });

    // ensure_buvid3 的兜底是 3s，这里等到 4s
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.strictEqual(
      settled,
      true,
      'cookieSet 不回调时也必须继续走到搜索，不能把上层挂死'
    );
  });
});
