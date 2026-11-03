# 网易云 YRC 逐字歌词调研

> 个人调研记录，功能已于 2026-11-03 实现并归档（实现说明见第 6 节）。
> 目标：给 listen1 的网易云曲目接逐字（词级）歌词，效果对齐官方 web 播放器。

## 1. 结论速览

- 接口仍是 `POST https://music.163.com/weapi/song/lyric?csrf_token=`，body 明文：
  `{ id, lv: -1, tv: -1, yv: -1, csrf_token: '' }`，用 `js/provider/netease.js` 里的 `weapi()` 加密成
  `params` + `encSecKey` 两个表单字段（和现有 `static lyric(url)` 完全同一条链路）。
- 想拿逐字必须显式带 `yv: -1`（或 `yv: 1`）：**只带 `lv/tv` 时响应里没有 `yrc` 字段**，
  这和官方 web 端默认行为一致。
- 响应结构：`lrc.lyric`（整行 LRC）、`tlyric.lyric`（翻译）、**`yrc.lyric`（逐字）**。
- 匿名请求（不带 `MUSIC_U`）也能拿到 `yrc`，该接口没有登录门槛。
- **不是每首歌都有逐字**：没有时响应里没有 `yrc`，必须回退到 `lrc`。

实测样本（2026-11-02 在扩展页里带 `yv: -1` 请求核对过）：

| 曲目 | id | 结果 |
| --- | --- | --- |
| 你们 | 28656170 | 有 `yrc`，26 行 / 241 个词 |
| 成都 | 436514312 | 有 `yrc`，57 行（同一首 `lrc` 是 59 行） |
| 画 | 202369 | 有 `yrc`，29 行（`lrc` 31 行） |
| 一座 | 445505961 | **无** `yrc`，只有 `lrc` |
| 旧词 | 450567505 | **无** |
| — | 2757646601 | **无** |

## 2. 响应格式（`yrc.lyric`）

每行一条文本，行与行之间用 `\n` 分隔，单行格式：

```
[行开始ms,行时长ms](词1开始ms,词1时长ms,0)词1(词2开始ms,词2时长ms,0)词2...
```

要点：

- 时间全部是**绝对毫秒整数**，不是 LRC 的 `[mm:ss.xx]`。
- 词级三元组的第三个字段实测恒为 `0`（用途未知，忽略即可）。
- 词与词之间没有分隔符，必须靠 `(start,dur,0)` 切分；词文本里不会出现 `(` `)`。
- 行文本可能包含 `<` `>` `&` 等字符，渲染前要转义（LRC 现在也是这样处理的）。
- 有的行首个词文本**带前导空格**（如 `(0,1000,0) 作词 : 程璧`），渲染时按原样保留或按需 trim。
- 例：`[12345,320](12345,180,0)我(12525,140,0)们`
  → 行从 12.345s 开始、持续 0.32s；「我」在 12.345s 起 0.18s、「们」在 12.525s 起 0.14s（词级时间都是绝对时间，可直接和播放位置比）。

参考解析：

```js
const YRC_LINE = /^\[(\d+),(\d+)\](.*)$/;
const YRC_WORD = /\((\d+),(\d+),(\d+)\)([^()]*)/g;

function parseYrc(yrc) {
  return yrc
    .split('\n')
    .map((line) => {
      const m = YRC_LINE.exec(line.trim());
      if (!m) return null;
      const lineStart = Number(m[1]);
      const lineDur = Number(m[2]);
      const words = [];
      let w;
      YRC_WORD.lastIndex = 0;
      while ((w = YRC_WORD.exec(m[3])) !== null) {
        words.push({
          start: Number(w[1]),
          dur: Number(w[2]),
          text: w[4],
        });
      }
      if (!words.length) return null;
      return {
        lineStart,
        lineDur,
        content: words.map((x) => x.text).join(''),
        words,
      };
    })
    .filter(Boolean);
}
```

## 3. 接进 listen1 的改法

链路现状（搜函数名定位，仓库约定文档不写行号）：

1. `js/provider/netease.js` → `static lyric(url)`
   - 请求体加上 `yv: -1`；
   - 响应里取 `const yrc = res_data.yrc && res_data.yrc.lyric ? res_data.yrc.lyric : '';`
   - 回调改成 `fn({ lyric: lrc, tlyric: tlrc, yrc })`（多一个字段，老调用方不受影响）。
2. `js/loweb.js` → `MediaService.getLyric()`：直接透传 provider 返回值，不用改。
3. `js/controller/play.js` → `parseLyric(lyric, tlyric)`（外层 `MediaService.getLyric(...).success((res) => ...)`）
   - 改成 `parseLyric(lyric, tlyric, yrc)`；
   - 有 `yrc` 走逐字分支，产出 `[{ seconds, content, words: [{ start, dur, text }], lineStartMs, lineDurMs, lineNumber, translationFlag }]`；
   - 没有 `yrc` 继续走现有 LRC 分支，**两分支保持同一个数组结构**，这样 `listen1.html` 里的
     `ng-repeat="line in lyricArray track by $index"` 和 `line.lineNumber / line.content / line.translationFlag` 都不用改。
   - 翻译行仍来自 `tlyric`（只有整行翻译，没有词级翻译）。**实测 yrc 行数可能少于 lrc**
     （成都 57 vs 59、画 29 vs 31），不能按行号硬对齐，要按行开始时间（`lineStart`）匹配最近的 lrc 行。
4. 高亮（`js/controller/play.js` 里消费 `BG_PLAYER:FRAME_UPDATE` 的 `msg.data.pos`）
   - 现有逻辑按行：`seconds <= pos` 取最后一行，写 `$scope.lyricLineNumber`，HTML 用 `ng-class` 加 `.highlight`；
   - 逐字需要在行内再算「当前词」：`pos * 1000` 与 `word.start` 比较，命中词之前的词标"已唱"。
   - **性能**：`FRAME_UPDATE` 约 10Hz，不要每次 diget 重建 `lyricArray` / 重排 DOM。
     建议：行级仍用 `ng-class`；词级只对当前行做一次 DOM 操作（取 `lineLineNumber` 对应 `<span>`，
     直接改 class 或 CSS 变量 `--p` 做渐变填充），离开该行时复位。
   - 官方效果是「文字从左到右渐进染色」，用 `background-clip: text` + 线性渐变 + `--p` 变量最省事。

## 4. 验证方法

在扩展页（`chrome-extension://<id>/listen1.html`）console 里直接跑，不需要登录网易云：

```js
MediaService.getLyric('netrack_28656170').success((r) => {
  console.log('has yrc:', !!(r && r.yrc));
  console.log((r && r.yrc || '').slice(0, 300));
});
```

没有 `yrc` 的样本：`netrack_2757646601`（应回退到整行歌词）。

注意：`MediaService` 要等页面启动完成（约 5s）后再调用；provider 的返回值是 lazy spec，
必须调用 `.success(cb)` 才会真正发请求。

## 5. 风险与注意

- 响应体积：逐字文本比 LRC 大一个量级（26 行样本约 8KB，长歌可能几十 KB），一次性解析没问题，
  但不要每帧重新解析。
- 版权/稳定性：`weapi` 是官方 web 端接口，匿名可用；和现有 `lyric` 同一接口，风险等同，不需要新增 cookie。
- 如果后续要做「逐字翻译」，`tlyric` 只有整行翻译，词级翻译需要另找接口（未调研）。
- eapi 变体（`interface3.music.163.com/eapi/song/lyric/v1`）也能拿到词级数据，但返回的是富文本 JSON 行，
  和现有 LRC 渲染兼容成本更高；weapi + `yv` 已经够用，不推荐走 eapi。

## 6. 落地实现（2026-11-03）

上面的接入设想已落地，与 3/4 节的早期草案相比，最终实现按「高内聚、低耦合」拆开：

- js/provider/netease.js 只负责取原始文本（yv: -1，回调多给一个 yrc 字段）；
- js/lyric_parser.js 是独立的歌词整形模块：parseLyric(lyric, tlyric, yrc) 一次性产出
  lyricArray，不依赖 DOM、chrome.*、provider 或播放器，可以直接在 vm 里单测；
- 原句时间轴以 **LRC 为准**（YRC 只挂词级时间），所以关闭逐字开关时与改动前完全一致；
  逐字挂载优先按行文本匹配、再退回时间容差（600ms，文本一致时放宽到 3s）；
- 翻译行按 LRC 时间戳吸附到最近原句（500ms），空翻译行丢弃、无原句可挂的噪声行不单独成行；
- js/controller/play.js 只负责按 pos 选行和给当前行写 --yrc-p，样式与开关在
  css/common2.css / listen1.html；
- 单测见 	est/lyric_parser.test.js。
