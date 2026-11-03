/**
 * 歌词处理层（js/lyric_parser.js）：LRC 解析、逐字歌词格式分发与对齐、
 * LRC 视图 / 逐字视图（含翻译桥接）、渐变进度。
 *
 * 这里用 vm 载入真实文件，测的就是浏览器里跑的那一份。时间轴一律绝对毫秒
 * （YRC 格式与实测样本见 docs/archive/2026-11-03-netease-yrc-lyrics.md）。
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

const {
  parseYrc,
  parseWordLyric,
  wordLyricProgress,
  parseLyric,
  findCurrentLyricLines,
} = loadLyricParser();

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

/**
 * parseLyric 一次产出两种视图：LRC 视图（关闭逐字）与逐字视图（开启逐字）。
 * 下面按视图各测各的。
 */
function lrcView(lyric, tlyric, wordLyric) {
  return parseLyric(lyric, tlyric, wordLyric).lrcLines;
}

function wordView(lyric, tlyric, wordLyric) {
  return parseLyric(lyric, tlyric, wordLyric).wordLyricLines;
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

  test('未注册格式不影响 parseLyric：LRC 视图照常输出整行歌词，逐字视图不可用', () => {
    const parsed = parseLyric('[00:01.00]一', null, {
      format: 'unknown',
      text: '[1000,50](1000,50,0)一',
    });
    assert.deepStrictEqual(contents(parsed.lrcLines), ['一']);
    assert.strictEqual(parsed.lrcLines[0].karaoke, undefined);
    assert.strictEqual(parsed.wordLyricLines, null);
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

  test('时长为 0 的词（标点 dur=0）是瞬时唱完，渐变不会停在句中标点处', () => {
    const punctuated = wordLyricLine(0, 3000, [
      makeWord('我', 0, 1000),
      makeWord('、', 1000, 0),
      makeWord('们', 1000, 1000),
    ]);
    // 我 唱到一半
    assert.strictEqual(wordLyricProgress(punctuated, 500), 0.16666666666666666);
    // 我 + 、 已算唱完，们 唱到一半
    assert.strictEqual(wordLyricProgress(punctuated, 1500), 0.8333333333333334);
    assert.strictEqual(wordLyricProgress(punctuated, 2500), 1);
  });

  test('句首的零时长词在行开始后直接算唱完', () => {
    const leadingZero = wordLyricLine(1000, 2000, [
      makeWord('～', 1000, 0),
      makeWord('啊', 1000, 2000),
    ]);
    assert.strictEqual(wordLyricProgress(leadingZero, 999), 0);
    assert.strictEqual(wordLyricProgress(leadingZero, 1000), 0.5);
    assert.strictEqual(wordLyricProgress(leadingZero, 2000), 0.75);
    assert.strictEqual(wordLyricProgress(leadingZero, 3000), 1);
  });

  test('回归 744722：含 dur=0 标点的真实行，渐变随时间继续推进', () => {
    // 实测数据里「嗚呼、耳元で…」的「、」是 dur=0，旧实现到这里就返回，整行卡住不动
    const [parsedLine] = parseYrc(
      '[36240,6700](36240,90,0)嗚(36330,60,0)呼(36390,0,0)、(36390,750,0)耳(37140,780,0)元(37920,160,0)で(38080,610,0)爽(38690,600,0)や(39290,530,0)か(39820,410,0)に(40230,690,0)夏(40920,500,0)の(41420,550,0)足(41970,970,0)音'
    );
    assert.strictEqual(parsedLine.content, '嗚呼、耳元で爽やかに夏の足音');
    const early = wordLyricProgress(parsedLine, 36570);
    const middle = wordLyricProgress(parsedLine, 40000);
    const late = wordLyricProgress(parsedLine, 42000);
    assert.ok(middle > early + 0.3, `early=${early} middle=${middle}`);
    assert.ok(late > middle, `middle=${middle} late=${late}`);
    assert.ok(late <= 1);
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

describe('parseLyric：LRC 视图（关闭逐字时，原句与时间都来自 LRC）', () => {
  test('按时间排序，lineNumber 连续，原句在前', () => {
    const lines = lrcView(
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
    const lines = lrcView('[ti:歌名]\n[ar:歌手]\n[00:01.00]一', null, null);
    assert.deepStrictEqual(contents(lines), ['一']);
  });

  test('一行多个时间戳各产出一条；HTML 实体反转义', () => {
    const lines = lrcView('[00:01.00][00:02.00]&amp;', null, null);
    assert.deepStrictEqual(contents(lines), ['&', '&']);
    assert.deepStrictEqual(
      plain(lines.map((line) => line.seconds)),
      [1000, 2000]
    );
  });

  test('内容为空的翻译行不展示（lrc 间奏处的占位）', () => {
    const lines = lrcView(
      '[00:01.00]一\n[00:02.00]',
      '[00:02.00]\n[00:01.00]one',
      null
    );
    // 空的原句行照旧保留（改动前的 LRC 展示也有），空翻译行被丢掉
    assert.deepStrictEqual(contents(lines), ['一', 'one', '']);
    assert.strictEqual(lines.filter((line) => line.translationFlag).length, 1);
  });

  test('没有对应原句的翻译行不单独成行', () => {
    const lines = lrcView('[00:01.00]一', '[00:30.00]noise', null);
    assert.deepStrictEqual(contents(lines), ['一']);
  });

  test('同一原句允许有多条翻译（歌词本身可能提供多版翻译）', () => {
    const lines = lrcView(
      '[00:01.00]一',
      '[00:01.00]译文甲\n[00:01.00]译文乙',
      null
    );
    assert.deepStrictEqual(contents(lines), ['一', '译文甲', '译文乙']);
  });

  test('LRC 视图不带逐字字段：即使有逐字数据也照旧用 LRC 时间戳', () => {
    const parsed = parseLyric(
      '[00:01.00]一',
      null,
      wordLyricOf('[5000,500](5000,500,0)一')
    );
    assert.strictEqual(parsed.lrcLines[0].seconds, 1000);
    assert.strictEqual(parsed.lrcLines[0].karaoke, undefined);
    assert.strictEqual(parsed.lrcLines[0].words, undefined);
  });

  test('空输入返回空 LRC 视图与 null 逐字视图，不抛异常', () => {
    [undefined, null, ''].forEach((value) => {
      const parsed = plain(parseLyric(value, value, value));
      assert.deepStrictEqual(parsed.lrcLines, []);
      assert.strictEqual(parsed.wordLyricLines, null);
    });
  });
});

describe('parseLyric：逐字视图（开启逐字时，行文本与时间都来自逐字数据）', () => {
  const lrc = '[00:01.00]一\n[00:02.00]\n[00:03.00]三';
  const yrc = [
    '[1000,500](1000,200,0)一',
    '[3000,500](3000,500,0)三',
    '[9000,100](9000,100,0)逐字里多出来的行',
  ].join('\n');

  test('行就是逐字数据：内容与行时间来自逐字，LRC 的空行不出现', () => {
    const lines = wordView(lrc, null, wordLyricOf(yrc));
    assert.deepStrictEqual(contents(lines), ['一', '三', '逐字里多出来的行']);
    assert.deepStrictEqual(
      plain(lines.map((line) => line.seconds)),
      [1000, 3000, 9000]
    );
    assert.deepStrictEqual(lineNumbers(lines), [0, 1, 2]);
  });

  test('每行都带 karaoke / words / lineStart，行时间等于逐字行起点', () => {
    const lines = wordView(lrc, null, wordLyricOf(yrc));
    lines.forEach((line) => {
      assert.strictEqual(line.karaoke, true);
      assert.strictEqual(line.translationFlag, false);
      assert.strictEqual(line.seconds, line.lineStart);
      assert.ok(Array.isArray(line.words));
    });
  });

  test('没有逐字数据时逐字视图为 null（播放页回退 LRC 视图）', () => {
    assert.strictEqual(
      wordView('[00:01.00]一\n[00:02.00]二', null, null),
      null
    );
    assert.strictEqual(wordView('[00:01.00]一', null, wordLyricOf('')), null);
    assert.strictEqual(
      wordView('[00:01.00]一', null, {
        format: 'unknown',
        text: '[1000,50](1000,50,0)一',
      }),
      null
    );
  });

  test('两种视图的时间轴各自独立：LRC 视图用 LRC 时间，逐字视图用逐字时间', () => {
    const parsed = parseLyric(
      '[00:04.00]一',
      null,
      wordLyricOf('[1000,500](1000,500,0)一')
    );
    assert.strictEqual(parsed.lrcLines[0].seconds, 4000);
    assert.strictEqual(parsed.lrcLines[0].karaoke, undefined);
    assert.strictEqual(parsed.wordLyricLines[0].seconds, 1000);
  });
});

describe('parseLyric：逐字视图的翻译行（经 LRC 桥接）', () => {
  test('翻译先按 LRC 时间配到原句，再挂到对应逐字行后面', () => {
    const lines = wordView(
      '[00:01.00]一\n[00:02.00]二',
      '[00:01.00]one\n[00:02.00]two',
      wordLyricOf(
        '[1000,500](1000,500,0)一\n[5000,500](5000,500,0)二'
      )
    );
    assert.deepStrictEqual(contents(lines), ['一', 'one', '二', 'two']);
    assert.deepStrictEqual(
      plain(lines.map((line) => line.seconds)),
      [1000, 1000, 5000, 5000]
    );
    lines
      .filter((line) => line.translationFlag)
      .forEach((translation) => {
        const previous = lines[translation.lineNumber - 1];
        assert.strictEqual(previous.translationFlag, false);
        assert.strictEqual(previous.seconds, translation.seconds);
      });
  });

  test('逐字行没对上任何 LRC 原句（口白）时，它没有翻译', () => {
    const lines = wordView(
      '[00:01.00]一',
      '[00:01.00]one',
      wordLyricOf(
        ['[1000,500](1000,500,0)一', '[1500,100](1500,100,0)口白'].join('\n')
      )
    );
    assert.deepStrictEqual(contents(lines), ['一', 'one', '口白']);
    assert.strictEqual(lines[2].translationFlag, false);
  });

  test('LRC 有而逐字没有的行不出现，它的翻译也不会出现', () => {
    const lines = wordView(
      '[00:01.00]一\n[00:02.00]二',
      '[00:01.00]one\n[00:02.00]two',
      wordLyricOf('[1000,500](1000,500,0)一')
    );
    assert.deepStrictEqual(contents(lines), ['一', 'one']);
  });

  test('原文完全对不上时不硬配别人的翻译（逐字行照常显示）', () => {
    const lines = wordView(
      '[00:01.00]完全不同的一句',
      '[00:01.00]translation',
      wordLyricOf('[1000,500](1000,500,0)一')
    );
    assert.deepStrictEqual(contents(lines), ['一']);
  });
});

describe('parseLyric：逐字行对齐（LRC 时间戳不可靠时的文本匹配）', () => {
  test('文本一致时可容忍数秒偏差（实测 406072775：LRC 34.61s / 逐字 33.96s）', () => {
    const lines = wordView(
      '[00:34.61]Moving up, way up',
      '[00:34.61]向上移动',
      wordLyricOf(
        '[33960,1560](33960,300,0)Moving (34260,300,0)up, (34560,300,0)way (34860,300,0)up'
      )
    );
    assert.deepStrictEqual(contents(lines), ['Moving up, way up', '向上移动']);
    assert.deepStrictEqual(
      plain(lines.map((line) => line.seconds)),
      [33960, 33960]
    );
  });

  test('文本一致但偏差超过上限：不挂（可能是不同版本的另一句），不冒领翻译', () => {
    const lines = wordView(
      '[00:01.00]一',
      '[00:01.00]one',
      wordLyricOf('[20000,500](20000,500,0)一')
    );
    assert.deepStrictEqual(contents(lines), ['一']);
  });

  test('无关的相邻句不抢翻译（实测 744722：时间只差 30ms）', () => {
    const lines = wordView(
      '[05:10.56]"the sky, the earth, the sun, a wind,',
      '[05:10.56]天空、大地、太阳、风',
      wordLyricOf(
        '[310590,3480](310590,250,0)and (310840,250,0)a (311090,300,0)little (311390,300,0)rain'
      )
    );
    assert.deepStrictEqual(contents(lines), ['and a little rain']);
  });

  test('逐字数据里多出 LRC 没有的行时，跳过后继续按顺序配对', () => {
    const lines = wordView(
      '[00:01.00]一\n[00:02.00]二',
      '[00:01.00]one\n[00:02.00]two',
      wordLyricOf(
        [
          '[1000,500](1000,500,0)一',
          '[1500,100](1500,100,0)口白',
          '[2000,500](2000,500,0)二',
        ].join('\n')
      )
    );
    assert.deepStrictEqual(contents(lines), ['一', 'one', '口白', '二', 'two']);
    assert.strictEqual(lines[2].translationFlag, false);
  });

  test('重复句按顺序各自配对，翻译不会都挤到第一处', () => {
    const lines = wordView(
      '[04:50.38]"the sky\n[05:10.56]"the sky',
      '[04:50.38]天空甲\n[05:10.56]天空乙',
      wordLyricOf(
        [
          '[288150,3650](288150,300,0)" (288450,250,0)the (288700,250,0)sky',
          '[306940,3650](306940,300,0)" (307240,250,0)the (307490,250,0)sky',
        ].join('\n')
      )
    );
    assert.deepStrictEqual(contents(lines), [
      '" the sky',
      '天空甲',
      '" the sky',
      '天空乙',
    ]);
    assert.deepStrictEqual(
      plain(lines.map((line) => line.seconds)),
      [288150, 288150, 306940, 306940]
    );
  });

  test('简繁差异：时间够近且字符重合率高时仍能挂上翻译', () => {
    const lines = wordView(
      '[00:02.00]少年よ 神话になれ',
      '[00:02.00]少年啊 成为神话吧',
      wordLyricOf('[2100,500](2100,500,0)少年よ (2100,500,0)神話になれ')
    );
    assert.deepStrictEqual(contents(lines), [
      '少年よ 神話になれ',
      '少年啊 成为神话吧',
    ]);
    assert.deepStrictEqual(
      plain(lines.map((line) => line.seconds)),
      [2100, 2100]
    );
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

  test('LRC 视图：空翻译行被丢弃，真翻译紧跟原句，不出现空行', () => {
    const lines = lrcView(lrc, tlyric, wordLyricOf(yrc));
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

  test('LRC 视图：间奏空行保留为原句（与改动前的 LRC 展示一致）', () => {
    const lines = lrcView(lrc, tlyric, wordLyricOf(yrc));
    const blank = lines[2];
    assert.strictEqual(blank.content, '');
    assert.strictEqual(blank.translationFlag, false);
  });

  test('LRC 视图：翻译行时间戳比原句早几十毫秒时被拉到原句之后', () => {
    const lines = lrcView(
      '[00:10.00]line',
      '[00:09.98]译文',
      wordLyricOf('[10000,500](10000,100,0)line')
    );
    assert.deepStrictEqual(contents(lines), ['line', '译文']);
    assert.strictEqual(lines[1].seconds, 10000);
    assert.strictEqual(lines[1].lineNumber, 1);
  });

  test('LRC 视图：翻译不会被挂到间奏空行上（挂上去会渲染成「空行 / 翻译」）', () => {
    const lines = lrcView(
      '[00:10.00]one\n[00:20.00]',
      '[00:20.00]译文',
      null
    );
    assert.deepStrictEqual(contents(lines), ['one', '']);
    assert.strictEqual(lines.filter((line) => line.translationFlag).length, 0);
  });

  test('逐字视图：行时间来自逐字，翻译经 LRC 桥接挂到对应逐字行后', () => {
    const lines = wordView(lrc, tlyric, wordLyricOf(yrc));
    assert.deepStrictEqual(contents(lines), [
      'I need to unlock like a phone',
      '我像手机一样需要被密码解锁',
      "Can't be this lost one no more",
      '我不能再如此迷失下去',
    ]);
    assert.deepStrictEqual(
      plain(lines.map((line) => line.seconds)),
      [2190, 2190, 18420, 18420]
    );
    assert.deepStrictEqual(lineNumbers(lines), [0, 1, 2, 3]);
  });
});

describe('findCurrentLyricLines：当前原句与它自己的翻译行', () => {
  // 真实数据里有些原句没有翻译，旧实现取“位置之前最后一条翻译行”，
  // 跳转播放位置落到这类原句上时，上一句的翻译行会一直保持高亮。
  const lines = lrcView(
    '[00:10.00]one\n[00:20.00]two\n[00:30.00]three\n[00:40.00]four',
    '[00:10.00]一\n[00:30.00]三',
    null
  );

  test('空歌词 / 未唱到第一句时都返回空结果', () => {
    [undefined, null, []].forEach((value) => {
      const current = findCurrentLyricLines(value, 10000);
      assert.strictEqual(current.line, null);
      assert.strictEqual(current.translation, null);
    });
    const beforeFirst = findCurrentLyricLines(lines, 9999);
    assert.strictEqual(beforeFirst.line, null);
    assert.strictEqual(beforeFirst.translation, null);
  });

  test('唱到有翻译的句子时，原句和它的翻译行一起返回', () => {
    const current = findCurrentLyricLines(lines, 10500);
    assert.strictEqual(current.line.content, 'one');
    assert.strictEqual(current.translation.content, '一');
  });

  test('跳转到没有翻译的原句：翻译行必须为空（回归：不能残留上一句的翻译）', () => {
    const current = findCurrentLyricLines(lines, 20500);
    assert.strictEqual(current.line.content, 'two');
    assert.strictEqual(current.translation, null);
  });

  test('继续到下一句时换成它自己的翻译，不会回退到更早的翻译', () => {
    const current = findCurrentLyricLines(lines, 30500);
    assert.strictEqual(current.line.content, 'three');
    assert.strictEqual(current.translation.content, '三');
  });

  test('同一句有多条翻译时取最后一条（与旧的最后一条已到翻译行一致）', () => {
    const multi = lrcView(
      '[00:10.00]one',
      '[00:10.00]译文甲\n[00:10.00]译文乙',
      null
    );
    const current = findCurrentLyricLines(multi, 10000);
    assert.strictEqual(current.line.content, 'one');
    assert.strictEqual(current.translation.content, '译文乙');
  });

  test('原句时间点之前恰好是翻译行的时间也不会串句', () => {
    const current = findCurrentLyricLines(lines, 10000);
    assert.strictEqual(current.line.content, 'one');
    assert.strictEqual(current.translation.content, '一');
  });
});
