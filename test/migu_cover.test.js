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

describe('咪咕：歌单搜索与专辑歌曲封面的取值与空值保护', () => {
  const migu = loadMigu();

  test('歌单搜索结果的封面来自 musicListPicUrl', () => {
    assert.strictEqual(
      migu.mg_playlist_search_cover({
        musicListPicUrl: 'https://d.musicapp.migu.cn/a.png',
      }),
      'https://d.musicapp.migu.cn/a.png'
    );
  });

  test('歌单搜索结果没有封面字段时返回空串，不抛异常', () => {
    assert.strictEqual(migu.mg_playlist_search_cover({}), '');
    assert.strictEqual(migu.mg_playlist_search_cover(null), '');
  });

  test('mg_convert_song：albumImgs 优先取第 2 项，不足时取第 1 项，缺失时为空串', () => {
    const base = {
      copyrightId: 'c1',
      songName: 'S',
      singer: 'Singer',
      singerId: '1',
      albumId: '2',
      album: 'A',
    };
    assert.strictEqual(
      migu.mg_convert_song({
        ...base,
        albumImgs: [{ img: 'https://x/1.webp' }, { img: 'https://x/2.webp' }],
      }).img_url,
      'https://x/2.webp'
    );
    assert.strictEqual(
      migu.mg_convert_song({
        ...base,
        albumImgs: [{ img: 'https://x/1.webp' }],
      }).img_url,
      'https://x/1.webp'
    );
    assert.strictEqual(migu.mg_convert_song({ ...base }).img_url, '');
    assert.strictEqual(
      migu.mg_convert_song({ ...base, albumImgs: [] }).img_url,
      ''
    );
  });
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
