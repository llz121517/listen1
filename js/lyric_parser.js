/* eslint-disable no-param-reassign */
/* eslint-disable no-unused-vars */
/*
歌词整形：把 provider 取回的「整行 LRC / 翻译 TLRC / 逐字 YRC」三份原始文本，
变成播放页直接消费的 lyricArray（时间统一毫秒，结构统一，lineNumber 连续）。
对外暴露 parseLyric() / parseYrc() / yrcLineProgress()，由 listen1.html 引入，
controller 与单测直接使用（所以这里关掉 no-unused-vars）。

分层（高内聚、低耦合）：
- js/provider/*.js       只负责取原始文本（网易云在 static lyric() 里带 yv: -1 取 yrc）
- js/lyric_parser.js     只做纯数据变换：不碰 DOM、不碰 chrome.*、不碰播放器，可单测
- js/controller/play.js  只负责按播放位置选行、给当前行写渐变进度

原句（时间轴、行号、翻译挂靠）始终以 LRC 为准；YRC 只给对应行补词级时间。
因此关闭逐字开关后拿到的就是改动前的整行歌词展示，两套数据不互相污染。
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
// YRC 的行起点是首词时间，与 LRC 行时间戳可能差几十到几百毫秒（实测最多约 1.1s）
const YRC_LINE_MATCH_TOLERANCE_MS = 600;
// 行文本一致时可以容忍更大的时间偏差（不同发行方给的时间戳尺度不同），
// 但只在前后这么多毫秒内找候选，避免把副歌重复句匹配到别的段落
const YRC_CONTENT_MATCH_TOLERANCE_MS = 3000;
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
 * 时间一律是绝对毫秒（格式与实测样本见 docs/netease-yrc-lyrics.md）。
 * 返回 [{ lineStart, lineDuration, content, words: [{ start, dur, text }] }]；
 * 空输入、非字符串、没有词组的行都跳过，解析不出内容时返回空数组（调用方回退整行歌词）。
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
 * 逐字渐变的推进比例（0~1）：这一行已经唱到哪个位置。
 * 词内按时间插值，再按词的字符数占比折算成横向比例，渐变扫过的速度与文字宽度一致，
 * 中文长词不会一下跳过去。早于第一个词返回 0，晚于最后一个词返回 1。
 */
function yrcLineProgress(line, posMs) {
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

/** 行文本归一化：只用来判断 YRC 行和 LRC 行是不是同一句（空白、标点不参与比较）。 */
function normalizeLyricText(text) {
  return String(text)
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：'"“”‘’()（）\-—–~～[\]【】]/g, '');
}

/**
 * 把逐字行挂到 LRC 原句上：
 * 1. 优先按行文本匹配（YRC 与 LRC 的发行方不同，行起点可能差到 1s 上下，
 *    但文本相同的才是同一句；重复句取时间最近的一处）；
 * 2. 文本对不上时再退回纯时间匹配（容差 YRC_LINE_MATCH_TOLERANCE_MS）。
 * 两边都按时间升序，匹配单向推进，不会把后面的逐字行挪到前面的原句上；
 * 空占位行（只有时间戳、没有文字）不挂逐字。
 */
function attachYrcLines(originals, yrcLines) {
  if (!Array.isArray(yrcLines) || yrcLines.length === 0) return;
  let nextYrc = 0;
  originals.forEach((line) => {
    if (String(line.content).trim() === '') return;
    const target = normalizeLyricText(line.content);
    while (
      nextYrc < yrcLines.length &&
      yrcLines[nextYrc].lineStart <
        line.seconds - YRC_CONTENT_MATCH_TOLERANCE_MS
    ) {
      nextYrc += 1;
    }
    let contentIndex = -1;
    let contentDiff = Infinity;
    let timeIndex = -1;
    let timeDiff = Infinity;
    for (let i = nextYrc; i < yrcLines.length; i += 1) {
      const candidate = yrcLines[i];
      if (candidate.lineStart > line.seconds + YRC_CONTENT_MATCH_TOLERANCE_MS) {
        break;
      }
      const diff = Math.abs(candidate.lineStart - line.seconds);
      if (diff < timeDiff) {
        timeDiff = diff;
        timeIndex = i;
      }
      if (
        target !== '' &&
        diff < contentDiff &&
        normalizeLyricText(candidate.content) === target
      ) {
        contentDiff = diff;
        contentIndex = i;
      }
    }
    let matchedIndex = -1;
    if (contentIndex >= 0) {
      matchedIndex = contentIndex;
    } else if (timeDiff <= YRC_LINE_MATCH_TOLERANCE_MS) {
      matchedIndex = timeIndex;
    }
    if (matchedIndex < 0) return;
    const matched = yrcLines[matchedIndex];
    line.karaoke = true;
    line.words = matched.words;
    line.lineStart = matched.lineStart;
    line.lineDuration = matched.lineDuration;
    nextYrc = matchedIndex + 1;
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
 * 歌词整形入口：LRC 为主时间轴，YRC 补逐字数据，tlyric 挂到对应原句上。
 * 返回 [{ seconds(ms), content, translationFlag, lineNumber, karaoke?, words? }]，
 * 结构与改动前一致（新增字段只出现在挂了逐字的行上），播放页按同一套字段渲染。
 */
function parseLyric(lyric, tlyric, yrc) {
  const originals = parseTimedLines(lyric, false);
  const translations = parseTimedLines(tlyric, true);
  attachYrcLines(originals, parseYrc(yrc));
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
