/**
 * 咪咕歌曲搜索的封面：搜索接口返回的 img1 是不带域名的相对路径，
 * 必须补全成 https://d.musicapp.migu.cn/... 才能加载。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');

function loadMigu() {
  const sandbox = {
    console,
    Promise,
    URLSearchParams,
    getParameterByName: () => '',
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js/provider/migu.js'), 'utf8'),
    sandbox,
    { filename: 'js/provider/migu.js' }
  );
  return vm.runInContext('migu', sandbox);
}

const song = (img1) => ({
  copyrightId: 'c1',
  songName: 'S',
  singerList: [{ id: '1', name: 'Singer' }],
  albumId: '2',
  album: 'A',
  img1,
  ext: { lrcUrl: '', trcUrl: '' },
});

describe('咪咕搜索：封面地址补全', () => {
  const migu = loadMigu();

  test('相对路径补全为 d.musicapp.migu.cn 的完整地址', () => {
    assert.strictEqual(
      migu.mg_convert_song2(song('/data/oss/resource/00/41/zf/a.webp')).img_url,
      'https://d.musicapp.migu.cn/data/oss/resource/00/41/zf/a.webp'
    );
  });

  test('已经是完整地址时原样保留', () => {
    assert.strictEqual(
      migu.mg_convert_song2(song('https://x.migu.cn/a.webp')).img_url,
      'https://x.migu.cn/a.webp'
    );
  });

  test('协议相对地址补 https:', () => {
    assert.strictEqual(
      migu.mg_convert_song2(song('//x.migu.cn/a.webp')).img_url,
      'https://x.migu.cn/a.webp'
    );
  });

  test('没有封面时 img_url 为空串', () => {
    assert.strictEqual(migu.mg_convert_song2(song(undefined)).img_url, '');
    assert.strictEqual(migu.mg_convert_song2(song('')).img_url, '');
  });
});
