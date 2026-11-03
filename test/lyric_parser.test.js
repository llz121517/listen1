/**
 * 歌词处理层（js/lyric_parser.js）：LRC 解析、逐字歌词格式分发与挂载、翻译行配对、渐变进度。
 *
 * 这里用 vm 载入真实文件，测的就是浏览器里跑的那一份。时间轴一律绝对毫秒
 * （YRC 格式与实测样本见 docs/netease-yrc-lyrics.md）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const LYRIC_PARSER = path.join(__dirname, '..', 'js', 'lyric_parser.js');

function loadLyricParser() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(LYRIC_PARSER, 'utf8'), sandbox, {
    filename: LYRIC_PARSER,
  });
  return sandbox;
}

const { parseYrc, parseWordLyric, wordLyricProgress, parseLyric } =
  loadLyricParser();

// vm 里的数组/对象属于另一个 realm，deepStrictEqual 会因为原型不同而失败，
// 断言前统一过一遍 JSON（只比较可序列化的数据）。
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** provider 返回的逐字歌词格式：格式名 + 原始文本。 */
function wordLyricOf(text) {
  return { format: 'yrc', text };
}

/** 构造一行统一模型的逐字歌词，词按 { text, start, dur } 给。 */
function wordLyricLine(lineStart, lineDuration, words) {
  return {
    lineStart,
    lineDuration,
    content: words.map((item) => item.text).join(''),
    words,
  };
}

function makeWord(text, start, dur) {
  return { text, start, dur };
}

function contents(lines) {
  return plain(lines.map((line) => line.content));
}

function lineNumbers(lines) {
  return plain(lines.map((line) => line.lineNumber));
}

describe('parseYrc：解析网易云 YRC 文本（产出统一模型）', () => {
  test('单行拆出绝对毫秒的行/词时间与文本', () => {
    const lines = parseYrc('[12345,320](12345,180,0)我(12525,140,0)们');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].lineStart, 12345);
    assert.strictEqual(lines[0].lineDuration, 320);
    assert.strictEqual(lines[0].content, '我们');
    assert.deepStrictEqual(plain(lines[0].words), [
      makeWord('我', 12345, 180),
      makeWord('们', 12525, 140),
    ]);
  });

  test('多行、空行与无法识别的行：只保留合法行，顺序不变', () => {
    const lines = parseYrc(
      ['[100,50](100,50,0)啊', '', '这不是一行歌词', '[200,50](200,50,0)哦'].join(
        '\n'
      )
    );
    assert.deepStrictEqual(contents(lines), ['啊', '哦']);
    assert.deepStrictEqual(
      plain(lines.map((line) => line.lineStart)),
      [100, 200]
    );
  });

  test('兼容 CRLF 与行尾空白', () => {
    const lines = parseYrc('[100,50](100,50,0)啊\r\n[200,50](200,50,0)哦  \r\n');
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[1].content, '哦');
  });

  test('词文本里的 HTML 实体反转义（渲染时由插值重新转义）', () => {
    const lines = parseYrc('[0,20](0,10,0)&amp;(10,10,0)&lt;');
    assert.strictEqual(lines[0].content, '&<');
    assert.deepStrictEqual(
      plain(lines[0].words.map((item) => item.text)),
      ['&', '<']
    );
  });

  test('首词的前导空格按原样保留（作词信息行）', () => {
    const lines = parseYrc('[0,10](0,10,0) 作词 : 程璧');
    assert.strictEqual(lines[0].content, ' 作词 : 程璧');
  });

  test('没有词组的行（只有行时间）被跳过', () => {
    assert.strictEqual(parseYrc('[0,10]').length, 0);
    assert.strictEqual(parseYrc('[0,10]没有词').length, 0);
    assert.strictEqual(parseYrc('[0,10]\n[20,10]').length, 0);
  });

  test('空值 / 非字符串返回空数组，不抛异常', () => {
    [undefined, null, '', 0, 123, {}, []].forEach((value) => {
      assert.strictEqual(parseYrc(value).length, 0);
    });
  });
});

describe('parseWordLyric：按格式名分发', () => {
  test('已注册的格式交给对应解析器', () => {
    const lines = parseWordLyric(wordLyricOf('[100,50](100,50,0)啊'));
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].content, '啊');
  });

  test('未注册的格式、缺字段、非对象都返回空数组（上层回退整行歌词）', () => {
    [
      null,
      undefined,
      '',
      'yrc',
      {},
      { format: 'unknown', text: '[100,50](100,50,0)啊' },
      { format: 'yrc' },
      { text: '[100,50](100,50,0)啊' },
    ].forEach((value) => {
      assert.strictEqual(parseWordLyric(value).length, 0);
    });
  });

  test('未注册格式不影响 parseLyric：照常输出整行歌词', () => {
    const lines = parseLyric('[00:01.00]一', null, {
      format: 'unknown',
      text: '[1000,50](1000,50,0)一',
    });
    assert.deepStrictEqual(contents(lines), ['一']);
    assert.strictEqual(lines[0].karaoke, undefined);
  });
});

describe('wordLyricProgress：逐字渐变的推进比例', () => {
  const line = wordLyricLine(1000, 2000, [
    makeWord('我', 1000, 1000),
    makeWord('们', 2000, 1000),
  ]);

  test('行开始前是 0，唱完后是 1，超出也钳到 1', () => {
    assert.strictEqual(wordLyricProgress(line, 500), 0);
    assert.strictEqual(wordLyricProgress(line, 1000), 0);
    assert.strictEqual(wordLyricProgress(line, 3000), 1);
    assert.strictEqual(wordLyricProgress(line, 90000), 1);
  });

  test('词内按时间插值、再按字数占比折算（两字各半）', () => {
    assert.strictEqual(wordLyricProgress(line, 1500), 0.25);
    assert.strictEqual(wordLyricProgress(line, 2000), 0.5);
    assert.strictEqual(wordLyricProgress(line, 2500), 0.75);
  });

  test('落在词与词的空隙时停在上一词唱完的位置', () => {
    const gapped = wordLyricLine(1000, 3000, [
      makeWord('我', 1000, 500),
      makeWord('们', 2000, 500),
    ]);
    assert.strictEqual(wordLyricProgress(gapped, 1700), 0.5);
  });

  test('按字符数加权：长短词不会一起跳', () => {
    const mixed = wordLyricLine(0, 2000, [
      makeWord('abc', 0, 1000),
      makeWord('的', 1000, 1000),
    ]);
    assert.strictEqual(wordLyricProgress(mixed, 500), 0.375);
    assert.strictEqual(wordLyricProgress(mixed, 1500), 0.875);
  });

  test('没有词时退回按行时长线性推进', () => {
    const plainLine = { lineStart: 1000, lineDuration: 2000 };
    assert.strictEqual(wordLyricProgress(plainLine, 2000), 0.5);
    assert.strictEqual(wordLyricProgress({ lineStart: 1000 }, 1500), 1);
    assert.strictEqual(wordLyricProgress(null, 1000), 0);
  });
});

describe('parseLyric：LRC 主时间轴', () => {
  test('按时间排序，lineNumber 连续，原句在前', () => {
    const lines = parseLyric(
      '[00:01.00]一\n[00:05.00]二',
      '[00:04.99]trans\n[00:01.00]one',
      null
    );
    assert.deepStrictEqual(contents(lines), ['一', 'one', '二', 'trans']);
    assert.deepStrictEqual(lineNumbers(lines), [0, 1, 2, 3]);
    assert.deepStrictEqual(
      plain(lines.map((line) => line.translationFlag)),
      [false, true, false, true]
    );
    // 翻译行被拉到原句的时间上，同秒时原句在前
    assert.deepStrictEqual(
      plain(lines.map((line) => line.seconds)),
      [1000, 1000, 5000, 5000]
    );
  });

  test('标签行（[ti:] 等）不参与展示', () => {
    const lines = parseLyric('[ti:歌名]\n[ar:歌手]\n[00:01.00]一', null, null);
    assert.deepStrictEqual(contents(lines), ['一']);
  });

  test('一行多个时间戳各产出一条；HTML 实体反转义', () => {
    const lines = parseLyric('[00:01.00][00:02.00]&amp;', null, null);
    assert.deepStrictEqual(contents(lines), ['&', '&']);
    assert.deepStrictEqual(
      plain(lines.map((line) => line.seconds)),
      [1000, 2000]
    );
  });

  test('内容为空的翻译行不展示（lrc 间奏处的占位）', () => {
    const lines = parseLyric(
      '[00:01.00]一\n[00:02.00]',
      '[00:02.00]\n[00:01.00]one',
      null
    );
    // 空的原句行照旧保留（改动前的 LRC 展示也有），空翻译行被丢掉
    assert.deepStrictEqual(contents(lines), ['一', 'one', '']);
    assert.strictEqual(lines.filter((line) => line.translationFlag).length, 1);
  });

  test('没有对应原句的翻译行不单独成行', () => {
    const lines = parseLyric('[00:01.00]一', '[00:30.00]noise', null);
    assert.deepStrictEqual(contents(lines), ['一']);
  });

  test('同一原句允许有多条翻译（歌词本身可能提供多版翻译）', () => {
    const lines = parseLyric(
      '[00:01.00]一',
      '[00:01.00]译文甲\n[00:01.00]译文乙',
      null
    );
    assert.deepStrictEqual(contents(lines), ['一', '译文甲', '译文乙']);
  });

  test('空输入返回空数组，不抛异常', () => {
    [undefined, null, ''].forEach((value) => {
      assert.deepStrictEqual(plain(parseLyric(value, value, value)), []);
    });
  });
});

describe('parseLyric：逐字歌词挂载（原句仍以 LRC 为准）', () => {
  const lrc = '[00:01.00]一\n[00:02.00]\n[00:03.00]三';
  const yrc = [
    '[1000,500](1000,200,0)一',
    '[3000,500](3000,500,0)三',
    '[9000,100](9000,100,0)逐字里多出来的行',
  ].join('\n');

  test('原句来自 LRC：行数与 LRC 相同，逐字里多出来的行不新增行', () => {
    const lines = parseLyric(lrc, null, wordLyricOf(yrc));
    assert.deepStrictEqual(contents(lines), ['一', '', '三']);
    assert.deepStrictEqual(
      plain(lines.map((line) => line.seconds)),
      [1000, 2000, 3000]
    );
  });

  test('只有匹配上的原句带 karaoke / words，空占位行不带', () => {
    const lines = parseLyric(lrc, null, wordLyricOf(yrc));
    assert.strictEqual(lines[0].karaoke, true);
    assert.deepStrictEqual(
      plain(lines[0].words.map((item) => item.text)),
      ['一']
    );
    assert.strictEqual(lines[1].karaoke, undefined);
    assert.strictEqual(lines[1].words, undefined);
    assert.strictEqual(lines[2].karaoke, true);
  });

  test('时间锚点在容差内才挂载（几十毫秒的偏差正常）', () => {
    const lines = parseLyric(
      '[00:01.00]一',
      null,
      wordLyricOf('[1000,500](1200,100,0)一')
    );
    assert.strictEqual(lines[0].karaoke, true);

    // 文本对不上、时间又差 2s：不挂逐字
    const far = parseLyric('[00:01.00]一', null, wordLyricOf('[3000,500](3000,100,0)二'));
    assert.strictEqual(far[0].karaoke, undefined);
  });

  test('文本一致时可以容忍更大的时间偏差（发行方时间戳尺度不同）', () => {
    // 实测 406072775：LRC 34.61s 的 "Moving up, way up"，YRC 行起点 33.96s（差 650ms）
    const lines = parseLyric(
      '[00:34.61]Moving up, way up',
      null,
      wordLyricOf(
        '[33960,1560](33960,300,0)Moving (34260,300,0)up, (34560,300,0)way (34860,300,0)up'
      )
    );
    assert.strictEqual(lines[0].karaoke, true);
    assert.strictEqual(lines[0].lineStart, 33960);
  });

  test('文本对不上时退回纯时间匹配（容差内仍然挂）', () => {
    const lines = parseLyric(
      '[00:02.00]一',
      null,
      wordLyricOf('[2100,500](2100,500,0)壹')
    );
    assert.strictEqual(lines[0].karaoke, true);
  });

  test('文本一致但相差超过扫描范围：不挂（避免匹配到别的段落）', () => {
    const lines = parseLyric(
      '[00:01.00]一',
      null,
      wordLyricOf('[5000,500](5000,500,0)一')
    );
    assert.strictEqual(lines[0].karaoke, undefined);
  });

  test('没有逐字歌词时整行歌词照常解析，不带逐字字段', () => {
    const lines = parseLyric('[00:01.00]一', '[00:01.00]one', null);
    assert.deepStrictEqual(contents(lines), ['一', 'one']);
    lines.forEach((line) => {
      assert.strictEqual(line.karaoke, undefined);
      assert.strictEqual(line.words, undefined);
    });
  });
});

describe('parseLyric：翻译行配对（回归用例，曲目 406072775）', () => {
  // 真实数据：逐字歌词缺少 LRC 里的间奏空行；tlyric 在间奏处有一行空翻译，
  // 下一行才是真翻译。旧实现按逐字行起点就近吸附，会把空翻译吸到下一句真原句上，
  // 渲染成「原句 / 空行 / 翻译」。
  const lrc = [
    '[00:02.19]I need to unlock like a phone',
    '[00:17.73]',
    "[00:18.69]Can't be this lost one no more",
  ].join('\n');
  const yrc = [
    '[2190,3540](2190,240,0)I (2430,300,0)need (2730,270,0)to (3000,480,0)unlock (3480,270,0)like (3750,60,0)a (3810,1920,0)phone',
    '[18420,3450](18420,270,0)Can\'t (18690,840,0)be (19530,150,0)this (19680,60,0)lost (19740,240,0)one (19980,1890,0)no (21870,0,0)more',
  ].join('\n');
  const tlyric = [
    '[00:02.55]我像手机一样需要被密码解锁',
    '[00:17.73]',
    '[00:18.69]我不能再如此迷失下去',
  ].join('\n');

  test('空翻译行被丢弃，真翻译紧跟原句，不出现空行', () => {
    const lines = parseLyric(lrc, tlyric, wordLyricOf(yrc));
    assert.deepStrictEqual(contents(lines), [
      'I need to unlock like a phone',
      '我像手机一样需要被密码解锁',
      '',
      "Can't be this lost one no more",
      '我不能再如此迷失下去',
    ]);
    const translations = lines.filter((line) => line.translationFlag);
    assert.deepStrictEqual(
      plain(translations.map((line) => line.content)),
      ['我像手机一样需要被密码解锁', '我不能再如此迷失下去']
    );
    // 每条翻译行都紧跟在同秒的原句后面
    translations.forEach((translation) => {
      const previous = lines[translation.lineNumber - 1];
      assert.strictEqual(previous.translationFlag, false);
      assert.strictEqual(previous.seconds, translation.seconds);
    });
  });

  test('间奏空行保留为原句（与改动前的 LRC 展示一致），但不带逐字', () => {
    const lines = parseLyric(lrc, tlyric, wordLyricOf(yrc));
    const blank = lines[2];
    assert.strictEqual(blank.content, '');
    assert.strictEqual(blank.translationFlag, false);
    assert.strictEqual(blank.karaoke, undefined);
  });

  test('翻译行时间戳比原句早几十毫秒时被拉到原句之后', () => {
    const lines = parseLyric(
      '[00:10.00]line',
      '[00:09.98]译文',
      wordLyricOf('[10000,500](10000,100,0)line')
    );
    assert.deepStrictEqual(contents(lines), ['line', '译文']);
    assert.strictEqual(lines[1].seconds, 10000);
    assert.strictEqual(lines[1].lineNumber, 1);
  });
});
