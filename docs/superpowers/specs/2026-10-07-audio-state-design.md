# 播放器静音 / 音量状态收敛

- 日期：2026-10-07
- 状态：设计已确认，待实施
- 影响文件：`js/player_thread.js`、`js/l1_player.js`、`js/controller/play.js`、`js/app.js`（+ `CHANGELOG.md`）；`listen1.html` 与 CSS **不动**
- 相关约定：[docs/CONVENTIONS.md](../../CONVENTIONS.md)（§3 CHANGELOG、§7 SemVer、§9 提交范围）

## 1. 背景

音量与静音这一小块目前有**三个状态写入点**：

1. `Player`（`js/player_thread.js`）把 Howler 当状态源：`get volume() { return Howler.volume(); }`、`get muted() { return !!Howler._muted; }`；
2. UI（`js/controller/play.js`）持有 `$scope.volume` / `$scope.mute`，由 `BG_PLAYER:VOLUME` / `BG_PLAYER:MUTE` 两条消息各自写入；
3. `js/app.js` 在拖动结束时**直接写** `player-settings.volume`，`play.js` 另有自己的 `loadLocalSettings/saveLocalSettings`。

叠加 Howler 自身的双静音源（全局 `Howler._muted` 与每个音源自己的 `_muted`），产生了两个已确认的缺陷。

### 1.1 缺陷 A：静音态下改音量要等下一次播放才生效

`Howler.volume(v)` 先存 `_volume`，随后 `if (self._muted) return self;` —— **静音时不更新任何 HTML5 节点**（`js/vendor/howler.core.min.js:80-86`）；而 `Howler.mute(false)` 只把 `node.muted` 恢复成 `sound._muted`，**从不重写 `node.volume`**（`:120-153`）。节点音量下一次被写是 play 时（`:1020`）。原先"先设音量、再解静音"的调用序因此把新音量挡在门外。

已在 `d1f7615` 以"`set volume` 里先解静音再设音量"临时修复；本设计用 `applyAudioState()` 的固定顺序吸收它。

### 1.2 缺陷 B：全局静音期间新建的音源永久静音

- `new Howl({ mute: self.muted })`（`js/player_thread.js:277`）把**当前全局静音状态固化**成该音源自己的 `_muted`（`:664 self._muted = o.mute || false;`）；
- 之后全局 `mute(false)` 只会把 `node.muted` 恢复成 **`sound._muted`**（= true，`:149`），解不掉；
- play 时 `node.muted = sound._muted || … || node.muted`（`:1018-1019`，还把旧值一起 OR，彻底粘住）。

复现：暂停 → 音量调到 0 → 静音 → 切下一首 → 播放 → 此后无论调音量、取消静音、暂停播放**均无声**，只有再次切歌（重建 Howl）才恢复。

## 2. 目标与非目标

**目标**

1. 状态只有一个权威来源，且只有一条落到 Howler 的通道；
2. 语义统一为：**调音量即取消静音**（滑块 / 滚轮 / 快捷键 / 今后新增入口同一条规则）；
3. UI 与播放器之间只保留一条音频状态消息；`$scope.volume` / `$scope.mute` 只有一处写入点；
4. 持久化只有一处写入点。

**非目标**

- 不改动播放列表、载入、seek、mediaSession、歌词等其余播放逻辑；
- 不改 `listen1.html` 与任何 CSS（继续用 `$scope.volume` 百分数与 `$scope.mute`）；
- 不新增常驻测试框架（仓库没有测试设施，按 YAGNI 只做一次性 harness + 手测清单）。

## 3. 设计

### 3.1 状态模型（谁说了算）

`Player` 持有权威字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_volume` | 0..1 | 唯一音量真相源 |
| `_muted` | boolean | 唯一静音真相源 |

- `get volume()` / `get muted()` 只读上述字段，**不再读 Howler**；
- `getAudioState()` 返回对外口径 `{ volume: 0..100, muted: boolean }`（内部 0..1，换算只发生在协议边界）；
- `setVolume(pct)`：`_volume = clamp(pct)/100` **且 `_muted = false`**（语义 A）→ `applyAudioState()` → `sendAudioStateEvent()`；
- `adjustVolume(delta)`：直接转调 `setVolume(当前值 + delta)`（去掉现在"改字段 + 额外补发事件"的重复）；
- `setMuted(bool)` / `toggleMuted()`：只改 `_muted`，不碰音量 → `applyAudioState()` → `sendAudioStateEvent()`；
- 初值 `_volume = 1` / `_muted = false`（与 Howler 默认一致）；持久化的音量由 UI 在 `loadLocalSettings()` 里**只调 `l1Player.setVolume(settings.volume)`**（不自己写 `$scope.volume`），落到 `$scope` 的路径统一走 §3.3 的订阅。

### 3.2 与 Howler 的唯一出口

- 新增私有 `applyAudioState()`，是**唯一**调用 `Howler.mute()` / `Howler.volume()` 的地方，顺序固定：

  ```js
  Howler.mute(this._muted);      // 先解/加静音
  Howler.volume(this._volume);   // 再落音量：Howler 静音时会短路 volume()，顺序不能反（vendor:84-86）
  ```

- `new Howl({…})` **删除 `mute: self.muted`**：让音源级 `_muted` 恒为 false，全局静音只经 `Howler._muted` 在 play 时生效（`:1019`），于是缺陷 B 的结构性前提消失；
- 换歌 / 新建 Howl **不需要重放状态**（全局 `_muted` / `_volume` 在 play 时自动生效），引擎自愈；
- 删除 `d1f7615` 在 `set volume` 里加的"先解静音"guard —— 职责已由 `applyAudioState()` 的顺序承担，避免两处同类逻辑。

### 3.3 协议与 UI

- **两条消息合并为一条**：

  | 旧 | 新 |
  | --- | --- |
  | `BG_PLAYER:VOLUME`，`data = <0..100>` | `BG_PLAYER:AUDIO_STATE`，`data = { volume: <0..100>, muted: boolean }` |
  | `BG_PLAYER:MUTE`，`data = boolean` | 同上（合并） |

  player 侧 `sendVolumeEvent()` 改名 `sendAudioStateEvent()`；`mute()` / `unmute()` 里内联的两条 MUTE 消息删除。
- `js/controller/play.js`：dispatcher 的 `VOLUME` + `MUTE` 两个 case 合并为 `AUDIO_STATE`，**这一处**写 `$scope.volume` / `$scope.mute`（沿用现有写法，包在 `$scope.$evalAsync()` 里，因为消息可能在 digest 之外到达），并**只在这里**持久化（`saveLocalSettings`）。
- `js/controller/play.js` 初始化：`$scope.volume` / `$scope.mute` 的初值改为同步读一次 `l1Player.getAudioState()`；`loadLocalSettings()` 不再自己写这两个 `$scope` 字段（只调 `setVolume`），保证 `$scope` 的**唯一写入点**就是上面的 `AUDIO_STATE` 订阅。
- `js/app.js`：拖动结束写 `player-settings` 的那段删除；拖动与 `volumeWheel` 只调门面方法。
- `js/l1_player.js`（门面）：`setVolume(pct)` / `adjustVolume(delta)` / `setMuted(bool)` / `toggleMuted()` / `getAudioState()`；删除 `mute()` / `unmute()` 与 `status.volume` / `status.muted`（加载时冻结的快照本身就是旧值来源）。
- `listen1.html` 不改：仍用 `$scope.volume`（百分数）与 `$scope.mute`。

### 3.4 迁移与兼容

- 一次性改完，**不保留旧消息名**（协议两端同仓库、同版本一起加载）；
- 后台播放（Firefox MV2）与页面内播放共用同一个 `player_thread.js`，两条路同时生效；`getPlayerAsync('background')` 的直连对象调用不变；
- 唯一的破坏性在于消息名，而它只出现在本仓库的两端。

## 4. 验收

**验收 ①（一次性 harness，Howler 语义逐条抄自 vendor 并标注行号，被测代码从真实文件抽取而非副本）**

| 用例 | 期望 |
| --- | --- |
| 复现序列：静音 → 切歌（此刻建 Howl）→ 取消静音 → 播放 → 调音量 | 取消静音后即有声音；调音量即时跟手（修复前：永久无声） |
| 全局静音期间新建音源并播放 | 仍然静音（不能漏音） |
| 静音态下调音量 | `_muted` 变 false、节点音量即时等于目标值 |
| 非静音态上调音量 | 行为与改造前一致（无回归） |

**验收 ②（手测清单）**

1. 静音 → 切下一首 → 取消静音 → 播放：有声音；
2. 静音状态下拖动音量条：立刻有声且音量跟手；
3. 滚轮与快捷键调音量：同样取消静音；
4. 刷新后音量保持上次的值；
5. Firefox MV2 后台播放模式同样成立。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 协议改名后某一端漏改 → 状态不再同步 | 一次性全改，并在 harness 里断言消息载荷形状；手测清单第 1-3 条覆盖 |
| `applyAudioState()` 顺序被后人调换 → 缺陷 A 复活 | 在方法内写死顺序并加注释引用 vendor 行号；CHANGELOG 记录原因 |
| 有人重新给 `new Howl` 加回 `mute:` → 缺陷 B 复活 | 在 `new Howl` 那处留注释说明为何不能传 `mute` |
| 旧会话里已被固化的 Howl（缓存于 `playlist[].howl`）在升级后仍静音 | 属升级前的存量状态，重启扩展即消失；不为此增加迁移代码 |
