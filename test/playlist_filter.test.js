/**
 * 歌单内搜索（listen1.html 的 #playlist-search-input → NavigationController 的
 * playlistFilter.key / fieldFilter）用的匹配规则。
 *
 * 生产实现是 js/lowebutil.js 的 matchPlaylistFilter()：这里用 vm 载入真实文件，
 * 测的就是浏览器里跑的那一份，不复制逻辑。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const LOWEBUTIL = path.join(__dirname, '..', 'js', 'lowebutil.js');

function loadMatchPlaylistFilter() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(LOWEBUTIL, 'utf8'), sandbox, {
    filename: LOWEBUTIL,
  });
  return sandbox.matchPlaylistFilter;
}

const match = loadMatchPlaylistFilter();

describe('歌单内搜索的匹配规则', () => {
  test('大小写不敏感：hello / HELLO / HeLLo 命中同一首', () => {
    const track = { title: 'Hello, World', artist: 'Jay', album: 'Album' };
    ['hello', 'HELLO', 'HeLLo', 'hello, world'].forEach((key) => {
      assert.strictEqual(match(track, key), true, `"${key}" 应当命中`);
    });
  });

  test('空格分词后每个关键词都要命中（AND）', () => {
    const track = { title: '稻香', artist: '周杰伦', album: '魔杰座' };
    assert.strictEqual(match(track, '周杰伦 稻香'), true, '两个词都命中');
    assert.strictEqual(match(track, '稻香 周杰伦'), true, '与词序无关');
    assert.strictEqual(
      match(track, '周杰伦 不存在'),
      false,
      '缺一个词就不命中'
    );
  });

  test('首尾空白、连续空格、制表符与全角空格都当分隔符', () => {
    const track = { title: '稻香', artist: '周杰伦', album: '魔杰座' };
    [
      '  周杰伦 稻香  ',
      '周杰伦   稻香',
      '周杰伦\t稻香',
      '周杰伦\u3000稻香',
    ].forEach((key) => {
      assert.strictEqual(match(track, key), true, `"${key}" 应当命中`);
    });
  });

  test('空查询与纯空白查询不过滤任何曲目', () => {
    const track = { title: '稻香', artist: '周杰伦', album: '魔杰座' };
    ['', '   ', '\t', '\u3000', undefined, null].forEach((key) => {
      assert.strictEqual(match(track, key), true, `"${key}" 应当放行`);
    });
  });

  test('标题之外，歌手与专辑字段也能命中', () => {
    const track = { title: '稻香', artist: 'Jay Chou', album: 'Capricorn' };
    assert.strictEqual(match(track, 'jay'), true, '歌手字段');
    assert.strictEqual(match(track, 'capricorn'), true, '专辑字段');
    assert.strictEqual(match(track, 'jay capricorn'), true, '两个字段各中一词');
    assert.strictEqual(match(track, '青花瓷'), false, '哪个字段都没有');
  });

  test('缺失 artist / album 字段时不抛异常，也不会误命中', () => {
    assert.strictEqual(match({ title: '稻香' }, '稻香'), true);
    assert.strictEqual(
      match({ title: '稻香', artist: undefined }, '周杰伦'),
      false
    );
    assert.strictEqual(match({ title: '稻香', album: null }, '魔杰座'), false);
    assert.strictEqual(match({}, '稻香'), false);
  });
});
