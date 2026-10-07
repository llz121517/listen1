# 播放器静音 / 音量状态收敛

- 日期：2026-10-07（当日经独立子代理审查后修订）
- 状态：设计已确认并修订，待实施
- 影响文件：`js/player_thread.js`、`js/l1_player.js`、`js/controller/play.js`、`js/app.js`、`docs/INDEX.md`（+ `CHANGELOG.md`）；`listen1.html` 与 CSS **不动**
- 相关约定：[docs/CONVENTIONS.md](../../CONVENTIONS.md)（§1 行号纪律、§3 CHANGELOG、§7 SemVer、§9 提交范围）

## 1. 背景

音量与静音这一小块目前有**三个状态写入点**：

1. `Player`（`js/player_thread.js`）把 Howler 当状态源：`get volume() { return Howler.volume(); }`、`get muted() { return !!Howler._muted; }`；
2. UI（`js/controller/play.js`）持有 `$scope.volume` / `$scope.mute`，由 `BG_PLAYER:VOLUME` / `BG_PLAYER:MUTE` 两条消息各自写入；
3. `js/app.js` 在拖动结束时**直接写** `player-settings.volume`，`play.js` 另有自己的 `loadLocalSettings/saveLocalSettings`。

叠加 Howler 自身的双静音源（全局 `Howler._muted` 与每个音源自己的 `_muted`），产生了两个已确认的缺陷。

### 1.1 缺陷 A：静音态下改音量要等下一次播放才生效

`Howler.volume(v)` 先存 `_volume`，随后 `if (self._muted) return self;` —— **静音时不更新任何 HTML5 节点**（`js/vendor/howler.core.min.js` 的 `volume()`，`if (self._muted) { return self; }`）；而 `Howler.mute(false)` 只把 `node.muted` 恢复成 `sound._muted`，**从不重写 `node.volume`**（同文件 `mute()`，`sound._node.muted = muted ? true : sound._muted;`）。节点音量下一次被写通常是 play 时（HTML5 分支 `node.volume = sound._volume * Howler.volume();`；另有 `Howl.volume()` 与 `Sound.create()` 两个写点，现有调用路径不触发）。

已由 `d1f7615` 以"`set volume` 里先解静音再设音量"临时修复；本设计用 `applyAudioState()` 的固定顺序吸收它。

### 1.2 缺陷 B：全局静音期间新建的音源静音粘滞

- `new Howl({ mute: self.muted })`（`js/player_thread.js:277`）把**当前全局静音状态固化**成该音源自己的 `_muted`（vendor 的 Howl 构造器 `self._muted = o.mute || false;`）；
- 之后全局 `mute(false)` 只会把 `node.muted` 恢复成 **`sound._muted`**（= true，解不掉）；
- play 时 `node.muted = sound._muted || self._muted || Howler._muted || node.muted;`（末尾还把旧值一起 OR，彻底粘住）。

复现：暂停 → 音量调到 0 → 静音 → 切下一首 → 播放 → 此后无论调音量、取消静音、暂停播放**均无声**。

精确说法（审查修正）：切到**从未播过**的曲目会新建 Howl（此时若已解除静音，`mute:` 取到 false，声音恢复）；而**已被固化的那个音源会整会话静音** —— `playlist[].howl` 会被复用，`Howl.unload()` 也不清 `howl._muted`，`Sound.init/reset` 还会从 parent 复制 `_muted`。

另有一条同源的粘滞路径（审查补充，本设计一并兜底）：Howler 的 HTML5 音频**池**在释放节点时不重置 `muted`，`Sound.create()` 也只写 `node.volume`，于是"静音 → 切歌（节点带 `muted=true` 入池）→ 取 URL 期间解除静音（此刻 `Howler._howls` 为空，`mute(false)` 空转）→ 新 Howl 从池里取回该节点 → play 的 `|| node.muted` 把它粘住"仍会无声。

## 2. 目标与非目标

**目标**

1. 状态只有一个权威来源，且只有一条写 mute/volume 到 Howler 的通道（`Howler.unload()` 之类的其它 Howler 调用不算在内）；
2. 语义统一为：**调音量即取消静音**（滑块 / 滚轮 / 快捷键 / 今后新增入口同一条规则）；
3. UI 与播放器之间只保留一条音频状态消息；`$scope.volume` / `$scope.mute` 只有一处常驻写入点（初始化另读一次快照）；
4. 持久化只有一处常驻写入点，且**不覆盖**其它键。

**非目标**

- 不改动播放列表、载入、seek、mediaSession、歌词等其余播放逻辑；
- 不改 `listen1.html` 与任何 CSS（继续用 `$scope.volume` 百分数与 `$scope.mute`）；
- 不新增常驻测试框架（仓库没有测试设施，`npm test` 是 `exit 1` 桩；按 YAGNI 只做一次性 harness + 手测清单）；
- 静音状态**不持久化**（既有语义：重开必为未静音），本次不改。

## 3. 设计

### 3.1 状态模型（谁说了算）

`Player` 持有权威字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_volume` | 0..1 | 唯一音量真相源 |
| `_muted` | boolean | 唯一静音真相源 |

- `get volume()` / `get muted()` 只读上述字段，**不再读 Howler**；
- `getAudioState()` 返回对外口径 `{ volume: 0..100, muted: boolean }`（内部 0..1，换算只发生在边界）；
- `setVolume(pct)`：先做数值兜底（非 `number` 或非有限值直接返回），再 `_volume = clamp(pct, 0, 100)/100` **且 `_muted = false`**（语义 A）→ `applyAudioState()` → `sendAudioStateEvent()`；
- `adjustVolume(increase)`：**保留现有的 boolean 语义**（`inc ? +0.1 : -0.1`），内部转调 `setVolume` —— 现有 4 个调用点传的都是布尔值（`app.js:138` 的滚轮、`play.js` 的两个快捷键），改成"按增量"会让它们全部传错单位；
- `setMuted(bool)` / `toggleMuted()`：只改 `_muted`，不碰音量 → `applyAudioState()` → `sendAudioStateEvent()`；
- 初值 `_volume = 1` / `_muted = false`（与 Howler 默认一致）；持久化的音量由 UI 在 `loadLocalSettings()` 里**只调 `l1Player.setVolume(settings.volume)`**（不自己写 `$scope.volume`）。

### 3.2 与 Howler 的唯一出口

- 新增私有 `applyAudioState()`，是**唯一**写 mute/volume 到 Howler 的地方，顺序固定：

  ```js
  Howler.mute(this._muted);      // ① 全局标志在这里翻
  Howler.volume(this._volume);   // ② 再落音量
  ```

  顺序**不能反**：Howler 的短路依据是全局 `_muted`，而它只在 `Howler.mute()` 里被改写；先写音量会撞上短路（`_volume` 更新了、节点没有），随后 `mute(false)` 又不会回填 `node.volume`。审查曾提出"语义 A 下正反序皆可"，此处不采纳——两者的作用对象不同（Player 的 `_muted` 字段 vs Howler 的全局标志）。
- `new Howl({…})` **删除 `mute: self.muted`**：让音源级 `_muted` 恒为 false，消掉 OR 链里的 `sound._muted` 一项；
- OR 链里还剩 `|| node.muted`（HTML5 池粘滞，见 §1.2），因此**不宣称"引擎天然自愈"**，改为在 `new Howl` 的 `onplay` 回调里**兜底调一次 `applyAudioState()`**：该回调在 Howler 的 `playHtml5` 写完 `node.muted`/`node.volume` 之后触发，`Howler.mute()` 会把本 Howl 各节点的 `muted` 纠正为 `sound._muted`（false），`Howler.volume()` 顺手把音量写正 —— 池粘滞与缓存 Howl 两条路径都在这里收敛；
- 删除 `d1f7615` 在 `set volume` 里加的 guard 与那段注释（职责已由 `applyAudioState()` 承担），并去掉该路径上的 `sendFrameUpdate()`（音量变化不需要重发帧更新，`adjustVolume` 里那次重复发送也一并去掉）。

### 3.3 协议与 UI

- **两条消息合并为一条**：

  | 旧 | 新 |
  | --- | --- |
  | `BG_PLAYER:VOLUME`，`data = <0..100>` | `BG_PLAYER:AUDIO_STATE`，`data = { volume: <0..100>, muted: boolean }` |
  | `BG_PLAYER:MUTE`，`data = boolean` | 同上（合并） |

  player 侧 `sendVolumeEvent()` 改名 `sendAudioStateEvent()`；`mute()` / `unmute()` 里内联的两条 MUTE 消息删除（这两个方法本身也换成 `setMuted` / `toggleMuted`）。
- `js/controller/play.js`：

  - 初始化：`$scope.volume` / `$scope.mute` 初值改为同步读一次 `l1Player.getAudioState()`；`loadLocalSettings()` 不再写这两个字段（只调 `setVolume`）；
  - dispatcher 的 `VOLUME` + `MUTE` 两个 case 合并为 `AUDIO_STATE`，**这里**写 `$scope.volume` / `$scope.mute`（沿用现有写法包在 `$scope.$evalAsync()` 里），并同步 `$scope.settings.volume = state.volume`（否则 `saveLocalSettings()` 会把旧音量写回去——`settings.volume` 目前全仓库没有赋值处）；
  - 持久化：**只写 `volume` 键**，读-改-写当前存储对象；**不能**直接 `saveLocalSettings()`，因为 `$scope.settings` 是陈旧的（`nowplaying_track_id` 由 LOAD 分支直写 storage），整对象回写会把它覆盖成旧值；
  - 拖动时状态事件按帧到达，持久化加**防抖**（约 400ms）后再落盘，避免每帧 `JSON.stringify + setItem`。
- `js/app.js`：拖动处理里 `l1Player.unmute()` 那行**删除**（门面不再有 `unmute()`，留着会抛 TypeError；语义 A 下也多余）；拖动结束直写 `player-settings` 的那段删除；拖动与 `volumeWheel` 只调门面方法。
- `js/l1_player.js`（门面）：`setVolume(pct)` / `adjustVolume(increase)` / `setMuted(bool)` / `toggleMuted()` / `getAudioState()`；删除 `mute()` / `unmute()` 与 `status.volume` / `status.muted`（加载时冻结的快照本身就是旧值来源）；`toggleMute` 现在内部依赖 `player.muted/mute()/unmute()`，改为直接调 `player.toggleMuted()`；`getAudioState()` 是**同步**读，必须判空回退（background 模式下 `getPlayer('background')` 可能 undefined，回退 `{ volume: 100, muted: false }`）。
- `docs/INDEX.md`：门面方法清单、`sendVolumeEvent` 条目、`player-settings` 写入点说明同步更新。
- `listen1.html` 不改：仍用 `$scope.volume`（百分数）与 `$scope.mute`。

### 3.4 迁移与兼容

- 一次性改完，**不保留旧消息名**（`BG_PLAYER:VOLUME` / `BG_PLAYER:MUTE` 只出现在 `js/player_thread.js` 与 `js/controller/play.js`，都在本仓库内；桌面版复用渲染层的情形无法在本仓库核实，故只保证本仓库两端一致）；
- 后台播放（Firefox MV2）与页面内播放共用同一个 `player_thread.js`，两条路同时生效；`getPlayerAsync('background')` 的直连对象调用不变。

## 4. 验收

**验收 ①（一次性 harness，Howler 语义逐条抄自 vendor 并以"函数名 + 片段"标识，被测代码从真实文件抽取而非副本）**

| 用例 | 期望 |
| --- | --- |
| 复现序列：静音 → 切歌（此刻建 Howl）→ 取消静音 → 播放 → 调音量 | 取消静音后即有声音；调音量即时跟手（修复前：永久无声） |
| 池粘滞序列：静音 → 释放节点入池 → 池外解除静音 → 新 Howl 复用该节点 → play | `onplay` 兜底后节点 `muted=false`、音量等于目标值 |
| 全局静音期间新建音源并播放 | 仍然静音（不能漏音） |
| 静音态下调音量 | `_muted` 变 false、节点音量即时等于目标值 |
| 非静音态上调音量 | 行为与改造前一致（无回归） |
| `applyAudioState()` 顺序 | 断言先 `mute` 后 `volume`（把顺序反过来时用例必须失败） |

抽取契约：从 `js/player_thread.js` 取 `applyAudioState()` 的方法体文本 + `setVolume`/`setMuted`/`toggleMuted` 的方法体，挂到一个最小 Player 壳（stub `sendAudioStateEvent`、`playerSendMessage`）上执行；stub 侧复刻 `Howler.volume/mute`、Howl 构造器的 `_muted`、`playHtml5` 的 `node.muted/volume`、以及**池的获取/释放（不重置 muted）**。

**验收 ②（静态检查）**：全仓库不再出现 `l1Player.unmute` / `l1Player.mute(` / `status.volume` / `status.muted` / `BG_PLAYER:VOLUME` / `BG_PLAYER:MUTE`；`node --check` 与 `eslint .` 通过。

**验收 ③（手测清单）**

1. 静音 → 切下一首 → 取消静音 → 播放：有声音；
2. 静音状态下拖动音量条：立刻有声且音量跟手；
3. 滚轮与快捷键调音量：同样取消静音；
4. 拖动后**立刻刷新**：音量保持（不被旧值覆盖）；
5. 切曲若干次后重启：仍恢复上次播放的曲目（`nowplaying_track_id` 未被音量持久化覆盖）；
6. 静音 → 切歌 → 加载中取消静音：仍应有声（池粘滞兜底）；
7. Console 无异常；MV2 下关掉"关闭时停止播放"走后台播放器后同样成立。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 协议改名后某一端漏改 → 状态不再同步 | 一次性全改 + 静态检查 + 手测 1-3 |
| `applyAudioState()` 顺序被后人调换 → 缺陷 A 复活 | 方法内固定顺序并注释理由（引用 vendor 的函数名与片段） |
| 有人重新给 `new Howl` 加回 `mute:` → 缺陷 B 复活 | 在 `new Howl` 处留注释说明为何不能传 `mute` |
| 音频池粘滞 `node.muted` → 解除静音后仍无声 | `onplay` 里兜底 `applyAudioState()`（验收 ① 第 2 例、手测 6） |
| 持久化回写覆盖 `nowplaying_track_id` | 只读-改-写 `volume` 键，不整对象回写（手测 5） |
| 拖动时每帧写 localStorage | 防抖 400ms |
| 升级前已被固化的缓存 Howl 仍静音 | 存量状态，重建播放列表或重启扩展即消失；不写迁移代码 |
