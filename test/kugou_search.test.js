/**
 * 酷狗歌曲搜索的封面：直接用 song_search_v2 结果自带的 Image 字段，
 * 不再逐条请求已经失效的 www.kugou.com play/getdata（返回 err_code 20010，data 为空）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const asyncLib = require('../js/vendor/async.min');

const SEARCH_URL = '/search?keywords=test&curpage=1&type=0';

function item(hash, extra = {}) {
  return {
    FileHash: hash,
    SongName: 'S',
    SingerName: 'Singer',
    SingerId: [1],
    AlbumName: 'A',
    AlbumID: '2',
    ...extra,
  };
}

function loadKugou(lists) {
  const calls = [];
  const axios = {
    get: (url) => {
      calls.push(url);
      if (String(url).includes('song_search_v2')) {
        return Promise.resolve({ data: { data: { lists, total: lists.length } } });
      }
      // 旧的封面接口：失效，返回空数据
      return Promise.resolve({ data: { data: [], status: 0, err_code: 20010 } });
    },
  };
  const sandbox = {
    axios,
    async: asyncLib,
    console,
    Promise,
    URLSearchParams,
    getParameterByName: (key, url) =>
      new URLSearchParams(String(url).split('?')[1] || '').get(key),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js/provider/kugou.js'), 'utf8'),
    sandbox,
    { filename: 'js/provider/kugou.js' }
  );
  return { provider: vm.runInContext('kugou', sandbox), calls };
}

function runSearch(provider) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('search 没有回调')), 2000);
    provider.search(SEARCH_URL).success((result) => {
      clearTimeout(timer);
      resolve(JSON.parse(JSON.stringify(result)));
    });
  });
}

describe('酷狗搜索：封面来自搜索结果自带的 Image', () => {
  test('Image 的 {size} 换成 400 作为 img_url', async () => {
    const { provider } = loadKugou([
      item('H1', { Image: 'http://imge.kugou.com/stdmusic/{size}/a.jpg' }),
    ]);
    const result = await runSearch(provider);
    assert.strictEqual(
      result.result[0].img_url,
      'http://imge.kugou.com/stdmusic/400/a.jpg'
    );
  });

  test('Image 为空时退回 trans_param.union_cover', async () => {
    const { provider } = loadKugou([
      item('H1', {
        Image: '',
        trans_param: { union_cover: 'http://imge.kugou.com/stdmusic/{size}/b.jpg' },
      }),
    ]);
    const result = await runSearch(provider);
    assert.strictEqual(
      result.result[0].img_url,
      'http://imge.kugou.com/stdmusic/400/b.jpg'
    );
  });

  test('都没有封面时 img_url 为空串，结果仍然保留', async () => {
    const { provider } = loadKugou([item('H1'), item('H2')]);
    const result = await runSearch(provider);
    assert.strictEqual(result.result.length, 2);
    assert.strictEqual(result.result[0].img_url, '');
  });

  test('不再逐条请求 play/getdata，只发一次搜索请求', async () => {
    const { provider, calls } = loadKugou([item('H1'), item('H2'), item('H3')]);
    await runSearch(provider);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes('song_search_v2'));
  });
});
