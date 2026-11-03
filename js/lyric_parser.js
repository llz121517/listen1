/* eslint-disable no-param-reassign */
/* eslint-disable no-unused-vars */
/*
歌词处理层：把 provider 取回的「整行 LRC / 翻译 TLRC / 逐字歌词」三份原始文本，
整形成播放页直接消费的歌词数组（时间统一毫秒、结构统一、lineNumber 连续）。
一次整形产出两种视图，播放页按「逐字歌词显示」开关选一个：
- LRC 视图（关闭逐字）：行文本、行时间、翻译配对全部来自 LRC；
- 逐字视图（开启逐字）：行文本与行时间直接来自逐字数据，翻译行通过 LRC 桥接
  （tlyric 时间戳本来就基于 LRC，先配到 LRC 原句，再对齐到逐字行），
  所以不需要猜逐字时间与 tlyric 时间的对应关系。
对外暴露 parseLyric() / parseWordLyric() / parseYrc() / wordLyricProgress() /
findCurrentLyricLines()，由 listen1.html 引入，controller 与单测直接使用
（所以这里关掉 no-unused-vars）。

分层（高内聚、低耦合）：
- js/provider/*.js       只负责取原始文本（平台相关的解密也留在 provider），逐字歌词以
                         { format: 'yrc', text } 形式返回，不解析、不碰歌词结构
- js/lyric_parser.js     本模块：格式分发 → 统一模型 → 两种视图 / 挂载 / 翻译配对 /
                         行号；不碰 DOM、chrome.*、播放器，可以单测
- js/controller/play.js  只负责按播放位置选行、给当前行写渐变进度、按开关切换视图

新增一个平台的逐字歌词（例如 QQ 的 QRC、酷狗的 KRC）：
1. provider 里拿到明文后返回 wordLyric: { format: '<格式名>', text }；
2. 在本文件写对应的 parseXxx(text)，产出下面的统一模型；
3. 在 WORD_LYRIC_PARSERS 里注册一行；
   对齐（attachWordLyricLines）、翻译配对（pairTranslations）、渐变进度
   （wordLyricProgress）和播放页渲染全部复用，无需改动。
统一模型：一行 = { lineStart, lineDuration, content, words: [{ start, dur, text }] }，
时间一律绝对毫秒；行的语义、文本匹配规则见各函数注释。
*/

const YRC_LINE_REG = /^\[(\d+),(\d+)\](.*)$/;
const YRC_WORD_REG = /\((\d+),(\d+),(\d+)\)([^()]*)/g;
const LYRIC_HTML_UNESCAPES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};
// 逐字行与 LRC 行文本对不上时（简繁、用词差异），退回纯时间匹配的容差
const WORD_LYRIC_TIME_TOLERANCE_MS = 600;
// 行文本一致时允许的时间偏差上限：逐字歌词与 LRC 出自不同发行方，个别行会差到数秒
// （实测 744722 尾段 3.6s、28768718 8.9s，QQ 音乐的时间戳与逐字数据一致、LRC 是错的）；
// 再远就可能是不同版本里的另一句，宁可不用，避免把句子挪到别的时间上
const WORD_LYRIC_TEXT_MATCH_MAX_DRIFT_MS = 12000;
// 逐字数据里可能多出 LRC 没有的行（口白、纯音乐），文本匹配允许向前跳过几行
const WORD_LYRIC_LOOKAHEAD_LINES = 4;
// 文本对不上时（简繁、错字），字符重合率达到这个比例才认作同一句（实测变体 ≥ 0.67）
const WORD_LYRIC_TEXT_OVERLAP_MIN = 0.5;
// tlyric 的时间戳提取自 lrc（多数完全相等），这里只容忍少量抖动
const TRANSLATION_MATCH_TOLERANCE_MS = 500;

function unescapeLyricEntities(text) {
  return String(text).replace(
    /&(?:amp|lt|gt|quot|#39|apos);/g,
    (match) => LYRIC_HTML_UNESCAPES[match]
  );
}

/** 字符数按码点算，emoji / 生僻字不会被当成两个字。 */
function lyricCharLength(text) {
  return Array.from(String(text)).length;
}

function clampLyricProgress(value) {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 解析网易云 YRC 逐字歌词文本，格式为
 * `[行开始ms,行时长ms](词1开始ms,词1时长ms,0)词1(词2开始ms,词2时长ms,0)词2`，
 * 时间一律是绝对毫秒（格式与实测样本见 docs/archive/2026-11-03-netease-yrc-lyrics.md）。
 * 返回 [{ lineStart, lineDuration, content, words: [{ start, dur, text }] }]
 * （即统一模型）；空输入、非字符串、没有词组的行都跳过，解析不出内容时返回空数组。
 */
function parseYrc(yrc) {
  if (typeof yrc !== 'string' || yrc === '') {
    return [];
  }
  const lines = [];
  yrc.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (line === '') return;
    const lineMatch = YRC_LINE_REG.exec(line);
    if (!lineMatch) return;
    const words = [];
    YRC_WORD_REG.lastIndex = 0;
    let wordMatch = YRC_WORD_REG.exec(lineMatch[3]);
    while (wordMatch !== null) {
      words.push({
        start: Number(wordMatch[1]),
        dur: Number(wordMatch[2]),
        text: unescapeLyricEntities(wordMatch[4]),
      });
      wordMatch = YRC_WORD_REG.exec(lineMatch[3]);
    }
    if (words.length === 0) return;
    lines.push({
      lineStart: Number(lineMatch[1]),
      lineDuration: Number(lineMatch[2]),
      content: words.map((word) => word.text).join(''),
      words,
    });
  });
  return lines;
}

/**
 * 平台格式 → 统一模型的注册表。新增平台时在这里加一项：
 * `qrc: parseQrc`、`krc: parseKrc` …… key 与 provider 返回的 wordLyric.format 对应。
 */
const WORD_LYRIC_PARSERS = {
  yrc: parseYrc,
};

/**
 * 按平台格式解析逐字歌词文本，产出统一模型。
 * 没有逐字数据、格式未注册、解析失败都返回空数组（调用方回退整行歌词）。
 */
function parseWordLyric(wordLyric) {
  if (!wordLyric || typeof wordLyric !== 'object') {
    return [];
  }
  const parser = WORD_LYRIC_PARSERS[wordLyric.format];
  if (typeof parser !== 'function') {
    return [];
  }
  try {
    return parser(wordLyric.text);
  } catch (error) {
    return [];
  }
}

/**
 * 逐字渐变的推进比例（0~1）：这一行已经唱到哪个位置，与平台格式无关。
 * 词内按时间插值，再按词的字符数占比折算成横向比例，渐变扫过的速度与文字宽度一致，
 * 中文长词不会一下跳过去。早于第一个词返回 0，晚于最后一个词返回 1。
 * 时长为 0 的词（逐字数据里标点常常是 dur=0）是瞬时唱完的，直接计入已唱字数继续往后算，
 * 不能就地返回 —— 否则渐变会停在句中标点处不再推进。
 */
function wordLyricProgress(line, posMs) {
  if (!line) return 0;
  const words = Array.isArray(line.words) ? line.words : [];
  const position = Number(posMs) || 0;
  const totalChars = words.reduce(
    (sum, word) => sum + lyricCharLength(word.text),
    0
  );
  if (totalChars === 0) {
    // 整行没有可显示字符时退回按行时间线性推进
    const duration = Number(line.lineDuration) || 0;
    if (duration <= 0) {
      return position >= Number(line.lineStart) ? 1 : 0;
    }
    return clampLyricProgress((position - Number(line.lineStart)) / duration);
  }
  let sungChars = 0;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const chars = lyricCharLength(word.text);
    const dur = Number(word.dur) || 0;
    const start = Number(word.start) || 0;
    if (dur <= 0) {
      // 瞬时词：还没到点就停在上一词唱完的位置，到了就算已经唱完并继续
      if (position < start) {
        return clampLyricProgress(sungChars / totalChars);
      }
      sungChars += chars;
    } else if (position < start) {
      // 落在词与词之间的空隙：停在上一词唱完的位置，不提前点亮下一个词
      return clampLyricProgress(sungChars / totalChars);
    } else if (position < start + dur) {
      const intra = (position - start) / dur;
      return clampLyricProgress((sungChars + intra * chars) / totalChars);
    } else {
      sungChars += chars;
    }
  }
  return 1;
}

/**
 * 把一份带时间戳的歌词文本拆成行（LRC 的 `[mm:ss.xx]` 格式）。
 * 一行可以有多个时间戳（同一句复用多段），每个时间戳产出一条。
 * `[ti:]` `[ar:]` `[by:]` 这类元信息行不参与展示。
 */
function parseTimedLines(text, translationFlag) {
  if (typeof text !== 'string' || text === '') {
    return [];
  }
  const lines = [];
  text.split('\n').forEach((line) => {
    if (/\[\D*:([^\]]+)\]/.test(line)) return;
    const timeReg = /\[(\d{2,}):(\d{2})(?:\.(\d{1,3}))?\]/g;
    const content = unescapeLyricEntities(line.replace(timeReg, ''));
    let match = timeReg.exec(line);
    while (match !== null) {
      lines.push({
        content,
        seconds:
          Number(match[1]) * 60 * 1000 +
          Number(match[2]) * 1000 +
          (match[3] ? Number(`${match[3]}00`.slice(0, 3)) : 0),
        translationFlag,
        index: lines.length,
      });
      match = timeReg.exec(line);
    }
  });
  return lines;
}

/** 行文本归一化：只用来判断逐字行和 LRC 行是不是同一句（空白、标点不参与比较）。 */
function normalizeLyricText(text) {
  return String(text)
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：'"“”‘’()（）\-—–~～[\]【】]/g, '');
}

/**
 * 判断逐字行与 LRC 行是不是同一句：归一化后相等，或长句互为子串
 * （发行方偶尔会漏掉句首的虚词，如 LRC 的 "but just smile for me any more"
 * 对逐字的 "just smile for me any more"；太短的句子不做包含判断，避免误配）。
 */
function lyricTextMatches(left, right) {
  if (left === '' || right === '') return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  return shorter.length >= 6 && longer.includes(shorter);
}

/**
 * 字符重合率：文本对不上但可能是同一句时（简繁、个别错字）用来兜底判断。
 * 按词频取交集（重复的字不重复计数），避免英文短句靠字母重复刷高重合率。
 * 实测简繁/错字变体的重合率 ≥ 0.67，而“把相邻的另一句吸过来”的重合率很低。
 */
function lyricTextOverlap(left, right) {
  if (left === '' || right === '') return 0;
  const leftChars = Array.from(left);
  const rightCounts = new Map();
  Array.from(right).forEach((char) => {
    rightCounts.set(char, (rightCounts.get(char) || 0) + 1);
  });
  let common = 0;
  leftChars.forEach((char) => {
    const count = rightCounts.get(char) || 0;
    if (count > 0) {
      common += 1;
      rightCounts.set(char, count - 1);
    }
  });
  return common / Math.max(leftChars.length, Array.from(right).length);
}

/**
 * 第一轮对齐：按顺序做时间 + 文本匹配，返回 Map(候选原句下标 -> 逐字行下标)。
 * 两边出自不同发行方，行起点可能差到数秒，但同序且文本相同的才是同一句；
 * 允许向前跳过几行逐字数据，因为逐字里可能多出口白/纯音乐行。重复句按顺序各自
 * 配对，不会都挤到第一处。匹配单向推进，不会把后面的逐字行挪到前面的原句上。
 */
function matchWordLyricLinesByTime(candidates, wordLyricLines) {
  const matches = new Map();
  let nextLine = 0;
  candidates.forEach((line, candidateIndex) => {
    // 时间轴整体错位（不同版本、LRC 时间戳明显不准）时把指针推到可能的时间窗口，
    // 否则一条对不上就会一直卡住，后面的句子全都对不上
    while (
      nextLine < wordLyricLines.length &&
      wordLyricLines[nextLine].lineStart <
        line.seconds - WORD_LYRIC_TEXT_MATCH_MAX_DRIFT_MS
    ) {
      nextLine += 1;
    }
    const target = normalizeLyricText(line.content);
    let matchedIndex = -1;
    for (
      let i = nextLine;
      i < wordLyricLines.length && i < nextLine + WORD_LYRIC_LOOKAHEAD_LINES;
      i += 1
    ) {
      const drift = Math.abs(wordLyricLines[i].lineStart - line.seconds);
      if (
        drift <= WORD_LYRIC_TEXT_MATCH_MAX_DRIFT_MS &&
        lyricTextMatches(target, normalizeLyricText(wordLyricLines[i].content))
      ) {
        matchedIndex = i;
        break;
      }
    }
    if (matchedIndex < 0) {
      // 文本对不上（简繁、错字）：按顺序找时间足够近、且文本足够像的下一行
      for (
        let i = nextLine;
        i < wordLyricLines.length && i < nextLine + WORD_LYRIC_LOOKAHEAD_LINES;
        i += 1
      ) {
        const wordLyricLine = wordLyricLines[i];
        if (
          Math.abs(wordLyricLine.lineStart - line.seconds) <=
            WORD_LYRIC_TIME_TOLERANCE_MS &&
          lyricTextOverlap(target, normalizeLyricText(wordLyricLine.content)) >=
            WORD_LYRIC_TEXT_OVERLAP_MIN
        ) {
          matchedIndex = i;
          break;
        }
      }
    }
    if (matchedIndex < 0) return;
    matches.set(candidateIndex, matchedIndex);
    nextLine = matchedIndex + 1;
  });
  return matches;
}

/**
 * 把逐字行对齐到 LRC 原句上，返回 [{ original, wordLyricLine }]（按逐字行顺序）。
 * 逐字视图的行直接用逐字数据，这里对齐只为把「LRC 原句 → 翻译行」桥接过去。
 * 空占位行（只有时间戳）不参与对齐；匹配规则见 matchWordLyricLinesByTime。
 */
function attachWordLyricLines(originals, wordLyricLines) {
  if (!Array.isArray(wordLyricLines) || wordLyricLines.length === 0) return [];
  const candidates = originals
    .filter((line) => String(line.content).trim() !== '')
    .sort((a, b) => a.seconds - b.seconds || a.index - b.index);
  const matches = matchWordLyricLinesByTime(candidates, wordLyricLines);
  return Array.from(matches)
    .sort((left, right) => left[1] - right[1])
    .map(([candidateIndex, wordIndex]) => ({
      original: candidates[candidateIndex],
      wordLyricLine: wordLyricLines[wordIndex],
    }));
}

/**
 * 翻译行挂到最近的 LRC 原句上（配对用 LRC 时间戳，tlyric 的时间戳提取自 lrc，
 * 允许少量抖动）。有内容的原句才接收翻译：间奏空行上的翻译行多是从上一句延迟过来的，
 * 挂上去会渲染成「空行 / 翻译」，直接丢掉。
 * 同一句原句允许多条翻译（歌词本身可能提供多版翻译），保持原始顺序。
 * 返回 [{ line, original }]，由 parseLyric 把翻译行的时间跟原句对齐。
 */
function pairTranslations(originals, translations) {
  if (
    !Array.isArray(translations) ||
    translations.length === 0 ||
    originals.length === 0
  ) {
    return [];
  }
  const paired = [];
  translations.forEach((line) => {
    if (String(line.content).trim() === '') return;
    let nearest = null;
    let nearestDiff = Infinity;
    originals.forEach((original) => {
      if (String(original.content).trim() === '') return;
      const diff = Math.abs(original.seconds - line.seconds);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearest = original;
      }
    });
    if (nearest === null || nearestDiff > TRANSLATION_MATCH_TOLERANCE_MS) {
      return;
    }
    paired.push({ line, original: nearest });
  });
  return paired;
}

/**
 * 按播放位置找「当前原句」与它自己的翻译行（播放页高亮 / 逐字渐变 / 桌面歌词共用）。
 * 原句取最后一个时间已到的非翻译行；翻译行只认紧跟在它之后、时间相同的连续翻译行
 * （同一句有多条翻译时取最后一条，与旧的“最后一条已到翻译行”表现一致），
 * 不会把上一句的翻译带过来 —— 跳转播放位置后旧翻译行必须立刻取消高亮。
 * 返回 { line, translation }，没唱到任何原句时两者都是 null。
 */
function findCurrentLyricLines(lines, posMs) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { line: null, translation: null };
  }
  const position = Number(posMs) || 0;
  let line = null;
  lines.forEach((candidate) => {
    if (!candidate.translationFlag && position >= candidate.seconds) {
      line = candidate;
    }
  });
  if (line === null) {
    return { line: null, translation: null };
  }
  let translation = null;
  for (let i = line.lineNumber + 1; i < lines.length; i += 1) {
    const candidate = lines[i];
    if (!candidate.translationFlag || candidate.seconds !== line.seconds) {
      break;
    }
    translation = candidate;
  }
  return { line, translation };
}

/** 把「原句 → 翻译」配对按原句分组，供两种视图各自组装行。 */
function groupTranslationsByOriginal(translationPairs) {
  const byOriginal = new Map();
  translationPairs.forEach(({ line, original }) => {
    const list = byOriginal.get(original);
    if (list) {
      list.push(line);
    } else {
      byOriginal.set(original, [line]);
    }
  });
  return byOriginal;
}

/**
 * LRC 视图（关闭逐字时）：原句来自 LRC，行时间用 LRC 时间戳，翻译行按 LRC 时间配对。
 * 行按时间升序，同一句的翻译行紧跟在原句之后。
 */
function buildLrcLines(originals, translationPairs) {
  const translationsByOriginal =
    groupTranslationsByOriginal(translationPairs);
  originals.sort((a, b) => a.seconds - b.seconds || a.index - b.index);
  const rows = [];
  originals.forEach((original) => {
    rows.push(original);
    const translations = translationsByOriginal.get(original);
    if (translations) {
      translations.forEach((line) => {
        rows.push({ ...line, seconds: original.seconds });
      });
    }
  });
  rows.forEach((line, index) => {
    line.lineNumber = index;
  });
  return rows;
}

/**
 * 逐字视图（开启逐字时）：行文本、行时间、词都直接来自逐字数据（逐字时间是平台给的
 * 逐字同步时间，比 LRC 时间戳准）。翻译行经 LRC 桥接：tlyric 先按时间配到 LRC 原句，
 * LRC 原句再对齐到逐字行，于是翻译只挂在它真正对应的逐字行后面。
 * 逐字行没对上 LRC 原句（口白等）就没有翻译；LRC 有而逐字没有的行不出现。
 */
function buildWordLyricLines(wordLyricLines, attached, translationPairs) {
  const wordLineByOriginal = new Map();
  attached.forEach(({ original, wordLyricLine }) => {
    wordLineByOriginal.set(original, wordLyricLine);
  });
  const translationsByWordLine = new Map();
  translationPairs.forEach(({ line, original }) => {
    const wordLine = wordLineByOriginal.get(original);
    if (!wordLine) return;
    const list = translationsByWordLine.get(wordLine);
    if (list) {
      list.push(line);
    } else {
      translationsByWordLine.set(wordLine, [line]);
    }
  });
  const rows = [];
  wordLyricLines.forEach((wordLine) => {
    rows.push({
      seconds: wordLine.lineStart,
      content: wordLine.content,
      translationFlag: false,
      lineStart: wordLine.lineStart,
      lineDuration: wordLine.lineDuration,
      words: wordLine.words,
      karaoke: true,
    });
    const translations = translationsByWordLine.get(wordLine);
    if (translations) {
      translations.forEach((line) => {
        rows.push({ ...line, seconds: wordLine.lineStart });
      });
    }
  });
  rows.forEach((line, index) => {
    line.lineNumber = index;
  });
  return rows;
}

/**
 * 歌词整形入口，一次产出两种视图（播放页按「逐字歌词显示」开关选一个）：
 * - lrcLines:       关闭逐字时用；原句/翻译都来自 LRC，行时间用 LRC 时间戳；
 * - wordLyricLines: 开启逐字时用；行文本与行时间直接来自逐字数据，翻译经 LRC 桥接；
 *                   没有逐字数据（或格式解析不了）时为 null，播放页回退 LRC 视图。
 * 参数约定（与 provider 返回值一致）：
 * - lyric:    LRC 文本；
 * - tlyric:   翻译 LRC 文本，可为空（时间戳提取自 lrc，配对用 LRC 时间）；
 * - wordLyric: { format, text } 或 null，逐字歌词的原始文本与格式名，可为空。
 * 两种视图的行都是 [{ seconds(ms), content, translationFlag, lineNumber, karaoke?, words? }]，
 * 数组按 seconds 升序，同一句的翻译行紧跟在原句之后。
 */
function parseLyric(lyric, tlyric, wordLyric) {
  const originals = parseTimedLines(lyric, false);
  const translations = parseTimedLines(tlyric, true);
  const wordLyricLines = parseWordLyric(wordLyric);
  const attached = attachWordLyricLines(originals, wordLyricLines);
  const translationPairs = pairTranslations(originals, translations);
  return {
    lrcLines: buildLrcLines(originals, translationPairs),
    wordLyricLines:
      wordLyricLines.length === 0
        ? null
        : buildWordLyricLines(wordLyricLines, attached, translationPairs),
  };
}
