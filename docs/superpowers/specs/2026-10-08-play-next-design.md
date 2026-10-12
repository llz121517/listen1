# 播放列表「下一首播放」

- 日期：2026-10-08
- 状态：设计已确认（新增「下一首播放」入口，现有「添加到当前播放」语义不动），**待实施**；本轮只落文档，代码未动
- 影响文件：`js/player_thread.js`、`js/l1_player.js`、`js/app.js`、`listen1.html`、`css/common2.css`（可能）、`i18n/*.json`（7 个）、`test/`、`docs/INDEX.md`、`CHANGELOG.md`
- 相关约定：[docs/CONVENTIONS.md](../../CONVENTIONS.md)（§1 行号纪律、§3 CHANGELOG、§6 HTML 注释、§9 提交范围）

## 1. 背景

### 1.1 现状链路

界面上的「添加到当前播放」= i18n 键 `_ADD_TO_QUEUE`，在两处歌曲行操作区各有一个 ➕（`listen1.html` 的 `ul.detail-songlist` 里 `class="detail-add-button"`）：

```
listen1.html  <a add-without-play="song" title="{{_ADD_TO_QUEUE}}">
  → js/app.js            app.directive('addWithoutPlay')          // 点击 → l1Player.addTrack(song)
  → js/l1_player.js      addTrack(track)                          // getPlayerAsync → player.insertAudio(track)
  → js/player_thread.js  insertAudio(audio, idx)                  // 无 idx → playlist.push()，随后 resetRandomPlaylist()
```

批量那条（歌单/专辑的「加入全部」）走 `addMylist → addTracks → appendAudioList`，内部逐个 `insertAudio`，同样作废随机顺序。

### 1.2 实测行为（一次性探针，2000 次，已删除）

| 场景 | 结果 |
| --- | --- |
| 顺序 / 单曲循环，5 首、当前下标 2，追加一首 | 新曲落在**队尾**：之后 next 依次是 3 → 4 → 5(新曲) → 0 → 1 → 2 |
| 随机，5 首、走了 2 步后追加（l=6） | 新曲成为下一首 **403/2000 = 20.1%**（理论 1/(l−1) = 20%）；原本排好的「下一首」只剩 **18.6%** 保留 |
| 随机，等到新曲 | 平均按 **3.25 次** next；分布 1 次 20% / 2 次 20% / 3 次 20% / 4 次 18% / 5 次 13%，再往后是跨轮 |
| 插入本身 | 长度 +1、当前曲目与下标 **2000/2000 不变** |

结论：现有行为是「进队尾 + 作废随机顺序」，语义自洽、不是缺陷；但**没有任何入口能做到「下一首就播」**。本设计只新增入口，不动现有语义。

## 2. 目标与非目标

**目标**

1. 新增「下一首播放」动作：点一下就把该曲排到当前曲之后，**顺序 / 单曲循环 / 随机三种模式下都真的下一首就播**；
2. 顺序模式下它在播放列表里可见地紧跟当前曲（`当前下标 + 1`）；
3. 自动切歌（曲终 `onend`）与手按 `next` 走同一条强制逻辑（随机模式 `onend` 走的是 `skip('random')`，与 `skip('next')` 共用 `nextIndexFn`）。

**非目标**

- 不改「添加到当前播放」的语义（仍进队尾），也不删它的 ➕；
- 不改批量「加入全部」（`appendAudioList` 仍纯追加）；批量里的「下一首」语义留给以后；
- 不改拖拽中段插入（`insertAudioByDirection`）；
- 不做持久化、快捷键、右键菜单、最近播放等周边；
- 不改洗牌算法本身（轮长、Fisher–Yates、跨轮不接续都保持现状）。

## 3. 设计

### 3.1 为什么把新曲「插进洗牌袋」，而不是加一个强制下一首槽

洗牌袋（`js/player_thread.js` 的 `buildShuffleBag(l)`）是长度 `2l` 的数组：前半是本轮播放顺序（值 = 曲目下标），后半是逆映射（`[l + 下标] = 它在本轮里的位置`），`skip()` 只靠 `_random_anchor` / `_random_steps` / `_random_len` 在它上面 O(1) 走位。

- 若另立 `_random_pending`（「下一首强制槽」），就要额外定义：槽在 `skip('prev')` 时怎么办、本轮重建时槽是否作废、槽与 `_random_steps` 谁先消费 —— 三处补丁，且与袋子容易互相打架；
- 把新曲**换进袋子的目标格**则只有一个真源：袋子仍是合法排列、逆映射仍自洽，`next` / `prev` / 轮末 / 跨轮全部照旧工作。

一次性探针对候选算法实测（2000 次随机起点 + 随机进度）：新曲成为下一首 **2000/2000**；袋子不变量（长度 2L、前半是 0..L−1 的排列、后半互逆）**2000/2000 完好**；插入不换掉当前曲目 **2000/2000**；插入后 12000 次 next 的每首出现次数 1985–2013（期望 2000，无偏置）；轮内重复 0。对照：不插袋时命中率 18.1%。

### 3.2 算法（`Player.insertNext(track)`）

```
insertNext(track):
  originIndex = this.index
  this.insertAudio(track, originIndex + 1)      // ① 落在当前曲之后
  if this._loop_mode !== 2: return              // ② 顺序 / 单曲循环：位置就是播放顺序，收工
  this.startRandomRound(this.index)             // ③ 按新长度重洗一轮（此时下标已被按 id 找回）
  l = this.playlist.length
  target = (this._random_anchor + this._random_steps + 1 + l) % l   // 下一次 next 会踩到的格
  newIdx = this.index >= 0 ? this.index + 1 : 0
  bag = this._random_playlist
  newPos = bag[l + newIdx]
  if newPos !== target:                         // ④ 对调新曲与目标格，并同步逆映射
    other = bag[target]
    bag[target] = newIdx;  bag[newPos] = other
    bag[l + newIdx] = target;  bag[l + other] = newPos
```

要点：

- ① 复用现有 `insertAudio(audio, idx)`：`idx >= 0 && idx < length` 时 splice 并按 id 找回当前曲目下标（上一版已修）；当前是最后一首时 `idx === length` 会落到 push 分支 → 结果同样是「紧接当前曲之后」；`index === -1`（没有播放位置）时 `idx = 0` → 落在开头。
- ③ 必须**在插入之后**重洗：中段插入会让其后所有曲目的下标位移，袋里存的正是下标，所以顺序模式下也不能复用旧袋。
- ④ 对调只碰 `newIdx` 与 `other` 两个下标：当前曲目坐在 `anchor + steps` 格上（`target` 是它的下一格），位置互异，所以当前曲目的位置与逆映射不动 —— 这也是「插入不换掉当前曲目」的原因。
- 被顶掉的那首（原本占着「下一首」格）会落到新曲原来的格上：若该格在本轮轮长 `k` 之外，它就得等下一轮。这不算 bug（半随机轮长本来就有这个自由度），**不**为此把 `k` 调大。

### 3.3 `skip()` 的一处边界修正

`skip(direction)` 里 `index` 不在范围内（`index === -1`）时，现有分支无条件 `startRandomRound(-1)`：

```js
if (!indexInRange) {
  this.startRandomRound(-1);
  this._random_steps = direction === 'prev' ? 0 : 1;
  return this._random_playlist[direction === 'prev' ? l - 1 : 0];
}
```

这会把 `insertNext` 刚插好的袋子整个覆盖（探针里唯一失败的边界：`index = -1` 时命中率为 0）。改为**只在袋子与当前长度不符时重建**：

```js
if (!indexInRange) {
  if (this._random_playlist.length / 2 !== l) {
    this.startRandomRound(-1);
  }
  this._random_steps = direction === 'prev' ? 0 : 1;
  return this._random_playlist[direction === 'prev' ? l - 1 : 0];
}
```

对既有路径等价：能走到这个分支时，袋子的唯一来源就是上一次 `resetRandomPlaylist()` 之后的空袋（长度 `0 / 2 !== l` → 仍重建），而 `insertNext` 用 `startRandomRound(-1)` 预建的袋锚位在 `l - 1`、`steps = 0`，`next` 取 `bag[0]`、`prev` 取 `bag[l - 1]`，与上面两处直接下标一致。

### 3.4 门面、指令与 UI

- `js/l1_player.js`：新增 `playNext(track)`，`getPlayerAsync(mode, (player) => player.insertNext(track))`，写法照抄 `insertTrack`。
- `js/app.js`：新增指令 `playNext`，仿 `addWithoutPlay` —— 点击 `l1Player.playNext(scope.song)` + `notyf.success(i18next.t('_PLAY_NEXT_SUCCESS'))`（随机模式下队列位置看不出「下一首」，toast 是主要反馈）。
- `listen1.html`：两处歌曲行的 `.tools` 里，在 ➕ 左侧加一个 ⏭ 按钮：`title="{{_PLAY_NEXT}}"`、`play-next="song"`、`ng-show="options"`。图标**逐字复用**播放区已有的 FontAwesome `step-forward` 路径（`listen1.html` 里 `data-icon="step-forward"` 那只，`viewBox="0 0 448 512"`），带 `class="icon"` 以继承 `css/common2.css` 的 `.tools .icon`（16×16、`#9d9d9d`、`margin-right: 10px`）。
- **待实测的容量问题**：`ul.detail-songlist li .tools` 是固定 `flex: 0 0 110px`（`css/common2.css`）。满配时同时可见 4 个图标（➕、收藏、删除、⏭）= 4 × 26px = 104px，理论刚好放得下；放不下就把 `flex-basis` 放宽到 130px（无浏览器环境，需人工确认）。

### 3.5 i18n

新增两个键，7 个语言文件（`zh-CN` / `zh-TC` / `en-US` / `ja-JP` / `ko-KR` / `pt-BR` / `fr-FR`）**同序同位**插入，键数 179 → 181：

| 键 | zh-CN |
| --- | --- |
| `_PLAY_NEXT` | 下一首播放 |
| `_PLAY_NEXT_SUCCESS` | 已设为下一首播放 |

注意：键集与**键序**必须 7 份完全一致；`zh-TC.json` 带 UTF-8 BOM，改它时别把 BOM 弄丢。

### 3.6 边界一览

| 场景 | 期望 |
| --- | --- |
| 顺序模式，当前下标 2 / 共 5 首 | 新曲插到下标 3，`next` 命中它，当前曲目与下标不变 |
| 顺序模式，当前是最后一首 | 新曲落在末尾，`next` 命中它 |
| 单曲循环（`loop_mode === 1`） | 同上（曲终仍重复本曲，这是单曲循环的定义） |
| 随机模式，任意起点与进度 | `next` 命中新曲（探针 2000/2000）；袋子不变量完好 |
| `index === -1`（无播放位置） | 新曲落在开头，`next` 命中它（依赖 §3.3 的修正） |
| `prev` 之后（`steps === -1`）再插入 | 仍命中（探针已验证） |
| 空歌单 | 插入后 `next` 命中它，不抛异常 |
| 批量「加入全部」 | 不变，仍纯追加 |
| 拖拽中段插入 | 不变，仍只 `resetRandomPlaylist()` |

## 4. 验收

**① 自动测试（TDD：先红后绿）**

现有测试设施：`npm test` = `node --test --test-isolation=none "test/**/*.test.js"`，`test/helpers/player_harness.js` 用 `node:vm` 载入真实的 `js/player_thread.js`（Howler 桩 + `__nextRandom` 可注入随机源）。当前 20 项全绿，新增用例：

| 用例 | 断言 |
| --- | --- |
| 顺序模式插入 | 新曲下标 = 当前 + 1；`skip('next')` 命中；当前曲目与下标不变 |
| 顺序模式、当前为最后一首 | 新曲落末尾；`skip('next')` 命中 |
| 单曲循环插入 | 同上 |
| 随机模式、随机起点/进度 | 多次 `skip('next')` **全部**命中新曲（确定性性质，不是统计） |
| 随机模式袋子不变量 | 长度 2l、前半是 0..l−1 的排列、后半与前半互逆 |
| 随机模式轮内不重复 | 一轮内不重复出现（沿用现有轮长测试的写法） |
| 随机模式长程分布 | 每首出现次数大致均匀（容忍区间同现有测试） |
| `index = -1` 插入 | `skip('next')` 命中新曲（覆盖 §3.3） |
| `prev` 之后插入 | `skip('next')` 命中新曲 |
| 回归 | 现有 20 项（洗牌质量、半随机轮长、失效与重建、非随机与边界、歌单内搜索）全绿 |

**② 静态检查**：`eslint`（`js/player_thread.js`、`js/l1_player.js`、`js/app.js`、`test/**`）、`node --check`、prettier（测试文件）、`listen1.html` 的 §8.1 自检（开始标签内无注释、标签配平、`class="body"` 唯一）、7 个 i18n 文件键集与键序一致（可写一条一次性核对命令）。

**③ 手测清单**（无浏览器环境，必须人工过）

1. 顺序模式：播放第 2 首 → 对第 5 首点 ⏭ → 播放列表里它排在第 3 位，按下一首就是它；
2. 随机模式：点 ⏭ → 按下一首就是它（多试几次）；
3. 随机模式：点 ⏭ 后**不按下一首**，等本曲播完自然切歌 → 仍然是它；
4. 队列里没有播放位置时（刚清空/未播放）点 ⏭ → 按下一首是它；
5. 「添加到当前播放」行为不变（仍进队尾）；
6. 满配 4 个图标不换行、不压字；
7. toast 文案正确；Console 无异常。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 后人把 `skip()` 的 `!indexInRange` 分支改回无条件重建 → `index = -1` 的「下一首」失效 | §3.3 的修正处留注释说明「这里可能已有一轮预建的袋子」；测试覆盖该边界 |
| 有人在 `insertNext` 里先重洗后插入 → 袋中下标与新歌单错位 | 测试断言袋子不变量（长度 2l + 逆映射互逆），错位必然被抓 |
| `_random_pending` 式改写复活 | 本文档记录取舍理由（单一真源） |
| 中段插入也去复用袋子 → 下标位移导致错播 | `insertAudioByDirection` 保持只 `resetRandomPlaylist()`；测试保持现状 |
| 第 4 个图标撑爆 `.tools` 的 110px | 手测 6；必要时 `flex-basis` 放宽到 130px |
| i18n 只改部分语言 / 键序错位 | 手测 + 一次性键集键序核对；按 §3.5 同序同位插入 |

## 6. 实施顺序

1. **红**：按 §4① 写测试（含边界），确认失败原因是「`insertNext` 不存在」而非拼写/夹具问题；
2. **绿**：`insertAudio` 旁的 `insertNext` + `skip()` 的 §3.3 修正；
3. 门面 `playNext` → 指令 → 两处 ⏭ 标记 → i18n ×7 → CSS（如需）；
4. 文档：`CHANGELOG.md`（`Added` 两条：下一首播放入口、`insertNext` 的随机插袋）、`docs/INDEX.md`（`player_thread.js` / `l1_player.js` 的符号表与「我想…」定位表补 `insertNext` / `playNext`）；
5. `npm test` + eslint + 静态检查 + 手测清单；按 §9 显式按路径暂存（本项目当前工作分支为 `dev`）。
