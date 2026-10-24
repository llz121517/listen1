/**
 * 播放页“词/译”开关的显示条件。
 *
 * 翻译开关是否出现，取决于当前歌词里有没有真正可显示的翻译行：切歌后歌词是异步
 * 取回的，所以判定只能发生在 parseLyric() 之后。生产实现是 js/lowebutil.js 的
 * hasLyricTranslationLines()：这里用 vm 载入真实文件，测的就是浏览器里跑的那一份。
 *
 * 翻译行由 parseLyric() 打上 translationFlag；只有时间戳、内容为空的翻译行不算。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const LOWEBUTIL = path.join(__dirname, '..', 'js', 'lowebutil.js');

function loadHasLyricTranslationLines() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(LOWEBUTIL, 'utf8'), sandbox, {
    filename: LOWEBUTIL,
  });
  return sandbox.hasLyricTranslationLines;
}

const hasTranslation = loadHasLyricTranslationLines();

describe('歌词翻译开关的显示条件', () => {
  test('只有原词行、没有翻译行时收起', () => {
    assert.strictEqual(
      hasTranslation([
        { seconds: 1000, content: '原词一', translationFlag: false },
        { seconds: 2000, content: '原词二', translationFlag: false },
      ]),
      false
    );
  });

  test('至少一行有内容的翻译行时显示', () => {
    assert.strictEqual(
      hasTranslation([
        { seconds: 1000, content: '原词', translationFlag: false },
        { seconds: 1000, content: 'translation', translationFlag: true },
        { seconds: 2000, content: '原词二', translationFlag: false },
      ]),
      true
    );
  });

  test('只有时间戳、内容为空的翻译行不算（空行 / 纯空白）', () => {
    assert.strictEqual(
      hasTranslation([{ seconds: 1000, content: '', translationFlag: true }]),
      false
    );
    assert.strictEqual(
      hasTranslation([
        { seconds: 1000, content: '   ', translationFlag: true },
      ]),
      false
    );
  });

  test('空数组、null、非数组都按“没有翻译”处理', () => {
    [undefined, null, [], {}].forEach((value) => {
      assert.strictEqual(hasTranslation(value), false);
    });
  });

  test('字段缺失或类型异常时不抛异常', () => {
    assert.strictEqual(
      hasTranslation([
        null,
        {},
        { content: 1, translationFlag: true },
        { content: '原词', translationFlag: false },
      ]),
      false
    );
  });
});
