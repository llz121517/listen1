/* eslint-disable no-param-reassign */
/* eslint-disable no-unused-vars */
/*
歌词处理层：把 provider 取回的「整行 LRC / 翻译 TLRC / 逐字歌词」三份原始文本，
整形成播放页直接消费的 lyricArray（时间统一毫秒、结构统一、lineNumber 连续）。
对外暴露 parseLyric() / parseWordLyric() / parseYrc() / wordLyricProgress() /
findCurrentLyricLines()，由 listen1.html 引入，controller 与单测直接使用
（所以这里关掉 no-unused-vars）。

分层（高内聚、低耦合）：
- js/provider/*.js       只负责取原始文本（平台相关的解密也留在 provider），逐字歌词以
                         { format: 'yrc', text } 形式返回，不解析、不碰歌词结构
- js/lyric_parser.js     本模块：格式分发 → 统一模型 → 挂载 / 翻译配对 / 行号；不碰 DOM、
                         chrome.*、播放器，可以单测
- js/controller/play.js  只负责按播放位置选行、给当前行写渐变进度

新增一个平台的逐字歌词（例如 QQ 的 QRC、酷狗的 KRC）：
1. provider 里拿到明文后返回 wordLyric: { format: '<格式名>', text }；
2. 在本文件写对应的 parseXxx(text)，产出下面的统一模型；
3. 在 WORD_LYRIC_PARSERS 里注册一行；
   挂载（attachWordLyricLines）、翻译配对（pairTranslations）、渐变进度
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
// 逐字行起点与 LRC 行时间戳的纯时间容差（文本对不上时的兜底）
const WORD_LYRIC_ATTACH_TOLERANCE_MS = 600;
// 行文本一致时可以容忍更大的时间偏差（不同发行方给的时间戳尺度不同），
// 但只在前后这么多毫秒内找候选，避免把副歌重复句匹配到别的段落
const WORD_LYRIC_TEXT_MATCH_WINDOW_MS = 3000;
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
    if (position < word.start) {
      // 落在词与词之间的空隙：停在上一词唱完的位置，不提前点亮下一个词
      return clampLyricProgress(sungChars / totalChars);
    }
    if (dur <= 0 || position < word.start + dur) {
      const intra = dur <= 0 ? 1 : (position - word.start) / dur;
      return clampLyricProgress((sungChars + intra * chars) / totalChars);
    }
    sungChars += chars;
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
 * 把逐字行挂到 LRC 原句上：
 * 1. 优先按行文本匹配（逐字歌词与 LRC 的发行方不同，行起点可能差到 1s 上下，
 *    但文本相同的才是同一句；重复句取时间最近的一处）；
 * 2. 文本对不上时再退回纯时间匹配（容差 WORD_LYRIC_ATTACH_TOLERANCE_MS）。
 * 两边都按时间升序，匹配单向推进，不会把后面的逐字行挪到前面的原句上；
 * 空占位行（只有时间戳、没有文字）不挂逐字。
 */
function attachWordLyricLines(originals, wordLyricLines) {
  if (!Array.isArray(wordLyricLines) || wordLyricLines.length === 0) return;
  let nextLine = 0;
  originals.forEach((line) => {
    if (String(line.content).trim() === '') return;
    const target = normalizeLyricText(line.content);
    while (
      nextLine < wordLyricLines.length &&
      wordLyricLines[nextLine].lineStart <
        line.seconds - WORD_LYRIC_TEXT_MATCH_WINDOW_MS
    ) {
      nextLine += 1;
    }
    let textIndex = -1;
    let textDiff = Infinity;
    let timeIndex = -1;
    let timeDiff = Infinity;
    for (let i = nextLine; i < wordLyricLines.length; i += 1) {
      const candidate = wordLyricLines[i];
      if (
        candidate.lineStart >
        line.seconds + WORD_LYRIC_TEXT_MATCH_WINDOW_MS
      ) {
        break;
      }
      const diff = Math.abs(candidate.lineStart - line.seconds);
      if (diff < timeDiff) {
        timeDiff = diff;
        timeIndex = i;
      }
      if (
        target !== '' &&
        diff < textDiff &&
        normalizeLyricText(candidate.content) === target
      ) {
        textDiff = diff;
        textIndex = i;
      }
    }
    let matchedIndex = -1;
    if (textIndex >= 0) {
      matchedIndex = textIndex;
    } else if (timeDiff <= WORD_LYRIC_ATTACH_TOLERANCE_MS) {
      matchedIndex = timeIndex;
    }
    if (matchedIndex < 0) return;
    const matched = wordLyricLines[matchedIndex];
    line.karaoke = true;
    line.words = matched.words;
    line.lineStart = matched.lineStart;
    line.lineDuration = matched.lineDuration;
    nextLine = matchedIndex + 1;
  });
}

/**
 * 翻译行挂到最近的 LRC 原句上（时间戳对齐，允许少量抖动），挂上后强制与原句同秒，
 * 排序时紧跟原句；找不到可挂的原句（噪声行）就不单独成行。
 * 内容为空的翻译行只是 lrc 间奏处的占位，展示出来就是一行空白，直接丢掉。
 * 同一句原句允许多条翻译（歌词本身可能提供多版翻译），保持原始顺序。
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
      const diff = Math.abs(original.seconds - line.seconds);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearest = original;
      }
    });
    if (nearest === null || nearestDiff > TRANSLATION_MATCH_TOLERANCE_MS) {
      return;
    }
    paired.push({ ...line, seconds: nearest.seconds });
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

/**
 * 歌词整形入口：LRC 主时间轴 + 逐字歌词按格式解析后挂到对应行 + tlyric 翻译配对。
 * 参数约定（与 provider 返回值一致）：
 * - lyric:    LRC 文本，主时间轴；
 * - tlyric:   翻译 LRC 文本，可为空；
 * - wordLyric: { format, text } 或 null，逐字歌词的原始文本与格式名，可为空。
 * 返回 [{ seconds(ms), content, translationFlag, lineNumber, karaoke?, words? }]，
 * 结构与改动前一致（新增字段只出现在挂了逐字的行上），播放页按同一套字段渲染。
 */
function parseLyric(lyric, tlyric, wordLyric) {
  const originals = parseTimedLines(lyric, false);
  const translations = parseTimedLines(tlyric, true);
  attachWordLyricLines(originals, parseWordLyric(wordLyric));
  const result = originals.concat(pairTranslations(originals, translations));
  result.sort((a, b) => {
    if (a.seconds !== b.seconds) return a.seconds - b.seconds;
    if (a.translationFlag !== b.translationFlag) {
      return a.translationFlag ? 1 : -1;
    }
    return a.index - b.index;
  });
  result.forEach((line, index) => {
    line.lineNumber = index;
  });
  return result;
}
