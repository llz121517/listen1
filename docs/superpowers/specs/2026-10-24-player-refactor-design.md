# 播放器子系统重构设计（god class 拆分 + Howl 生命周期重写）

- 日期：2026-10-24
- 状态：已实现（2026-10-24，实施计划见 [plans/2026-10-24-player-refactor.md](../plans/2026-10-24-player-refactor.md)）
- 范围：`js/player_thread.js`、`js/bridge.js`、`js/l1_player.js` 之间的播放器子系统
- 决策前提：保留 front / background / Electron 三套运行时路径，但只对 front（Chrome/Edge MV3）做完整测试；其它平台不专门验证

## 1. 背景

`js/player_thread.js` 里的 `Player` 是一个 god class，同时承担：

- 播放列表增删/排序/当前下标；
- 随机播放的洗牌与走位；
- 播放地址获取（`retrieveMediaUrl` → `MediaService.bootstrapTrack`）；
- Howler 音频栈生命周期（`new Howl`、`Howler.unload()`、事件回调）；
- `navigator.mediaSession` 的 metadata / playbackState / positionState / action handler；
- 向 UI 广播 `BG_PLAYER:*` 消息。

由此产生了本次要修的 bug 与一组竞态：

1. **切歌时系统媒体控件消失再出现**：`skip()` 一开始就 `Howler.unload()` 销毁全部 `<audio>` 元素；新曲的 URL 是异步取的，空窗里没有活跃媒体元素，Windows 媒体控件会撤下；而 `mediaSession.metadata` 只在新的 `onplay` 里写，控件回来时才会换成新曲。
2. **URL 生产/消费竞态**：`retrieveMediaUrl` 的回调不校验「这次请求是否已过期」。快速连切时旧请求晚回来，仍会 `finishLoad` 并播放旧曲。
3. **Howl 事件读全局状态**：`onplay` / `onend` / `onloaderror` 等回调里读的是 `self.currentAudio` / `self.currentHowl`，迟到的旧事件会改当前曲目状态、甚至触发额外跳歌。
4. **空窗期位置状态非法**：`sendFrameUpdate` 在没有当前 Howl 时给 `mediaSession.setPositionState` 传 `duration: 0`。
5. **复用已卸载 Howl**：`skip()` 的全局 `Howler.unload()` 之后，`playlist[i].howl` 仍指向旧对象，`finishLoad` 会复用它们，靠注释里的补丁维持。

## 2. 目标与非目标

### 目标

- 把 god class 拆成职责单一、可独立测试的模块；
- 重写 Howl 生命周期：切歌瞬间旧音频 **pause（保留元素）**，新曲就绪后再**定向卸载**旧 Howl；
- 引入 load session 代际 token，所有异步生产者与 Howl 事件都按代际校验；
- 媒体会话单点写入：**切歌瞬间立即更新 metadata**，播放/暂停/位置状态只在合法时机写；
- 对外行为不变：`window.threadPlayer` 的方法/属性、`window.l1Player`、`BG_PLAYER:*` 消息类型与负载均保持不变。

### 非目标

- 不改 UI 控制器（`js/controller/play.js` 的播放页、歌词、设置）；
- 不改歌词滚动、进度条、随机播放的**行为语义**（只搬家与改名）；
- 不新增播放源、不改进度/缓存策略；
- 不为 Firefox MV2 / Electron 写专项测试或修复其既有缺陷；host 适配保留，但不承诺这两条路径的可用性。

## 3. 模块划分

新增目录 `js/player/`，保持仓库「无构建、全局类」的写法：

| 文件                          | 全局类                   | 职责                                                      | 依赖                                                |
| ----------------------------- | ------------------------ | --------------------------------------------------------- | --------------------------------------------------- |
| `js/player/playlist_model.js` | `PlaylistModel`          | 列表数据、当前下标、随机洗牌与走位                        | 无                                                  |
| `js/player/audio_engine.js`   | `AudioEngine`            | 单曲 Howl 生命周期与事件                                  | Howler                                              |
| `js/player/media_session.js`  | `MediaSessionController` | `navigator.mediaSession` 唯一写入点                       | 无（特性探测）                                      |
| `js/player/player_core.js`    | `PlayerCore`             | 编排：代际、URL 生产/消费、错误、消息广播                 | 以上三者 + host                                     |
| `js/player/player_host.js`    | `createPlayerHost()`     | 运行时适配：消息收发、URL 解析                            | bridge 的 `playerSendMessage` / `addPlayerListener` |
| `js/player_thread.js`         | —                        | bootstrap：建 host + PlayerCore，挂 `window.threadPlayer` | 以上全部                                            |

依赖方向单向：`thread → host → bridge`，`thread → core → {playlist, engine, media_session, host 接口}`；`playlist` / `engine` / `media_session` 互不依赖。

脚本加载：`listen1.html` 在 `js/player_thread.js` 之前按上表顺序插入；`manifest_firefox.json` 的 background scripts 同样补充（保持后台页可用，不做专项验证）。

## 4. 接口

### 4.1 PlaylistModel

```js
class PlaylistModel {
  constructor(list = []);
  // 数据
  get length();
  get index();
  set index(value);
  get current();                 // 当前曲目对象或 undefined
  get tracks();                  // 只读列表视图
  get loopMode();                // 随机走位需要知道当前是否随机模式
  set loopMode(value);
  setList(list, { index });      // 替换列表；随机状态作废
  findIndexById(id);
  insert(track, at);             // 返回新下标；重复曲目返回 -1
  insertByDirection(track, target, direction);
  remove(at);                    // 返回被删曲目，非法下标返回 null
  // 随机播放
  static buildShuffleBag(length);
  static randomRoundLength(length);
  startRandomRound(originIndex);
  resetRandomState();
  nextIndex(direction);          // 'next' | 'prev' | 'random'，返回目标下标
}
```

`buildShuffleBag` / `randomRoundLength` / 走位算法从现有 `Player` 静态方法原样搬入，语义不变。随机内部状态（洗牌袋、锚位、步数、轮长）移入 `PlaylistModel`；现有测试改为读 `player.playlistModel` 上的对应字段（断言语义不变）。

### 4.2 AudioEngine

```js
class AudioEngine {
  constructor({ onEvent });
  get currentHowl();
  get currentTrack();            // 当前 Howl 对应的曲目对象，用于判断 Howl 是否属于当前曲目
  load({ url, track, token });   // 新建 Howl，事件里带 token
  play(); pause(); stop();
  seek(seconds); seekPercent(percent);
  duration(); position(); rate();
  applyAudioState({ volume, muted });  // Howler 全局 + 当前 Howl 节点
  unload(howl = this.currentHowl);     // 卸载指定 Howl（不额外调用 stop()，Howl.unload() 自己会停）
  unloadOtherThan(howl);         // 定向卸载：保留指定 Howl，其余 Howl 全卸
  unloadAll();
}
```

- 事件统一回调 `onEvent({ type, token, howl, track, error })`，`type ∈ loaded | playing | paused | stopped | ended | error`；事件只描述「当前 Howl 发生了什么」，是否采纳由 `PlayerCore` 按代际决定。
- 卸载抑制：`Howl.unload()` 内部会 stop 并派发 `onstop`，若事件回调再触发卸载会自我递归。engine 在卸载某个 Howl 期间抑制它的所有事件（用一个「卸载中」集合），保证 `unload` 幂等、不重入。
- `html5: true`、`volume: 1`、不传 `mute` 等既有约定保持不变。
- 全局音量/静音是**权威状态在 `PlayerCore`**、由它把 `{volume, muted}` 交给 engine 应用；engine 不存状态快照。

### 4.3 MediaSessionController

```js
class MediaSessionController {
  constructor({ onPlay, onPause, onNext, onPrev, onSeek, onSeekForward, onSeekBackward });
  get supported();
  setTrack(track);               // 立即写 metadata；字段/封面缺失时兜底
  clearTrack();                  // metadata 置空（清空播放列表时用）
  setPlaybackState(state);       // 'playing' | 'paused' | 'none'
  setPosition({ duration, position, rate }); // duration > 0 才写
}
```

- action handler 在构造时注册一次，回调进 `PlayerCore`；不支持 `mediaSession` 的环境全部方法退化为 no-op。
- metadata 只在 `setTrack` 里写；`playing/paused` 事件不再写 metadata。

### 4.4 PlayerHost

```js
createPlayerHost({ mode }); // mode: 'front' | 'background'
// 返回：
{
  mode,                                // 可写：setMode() 切换运行时通道时同步改写
  send(type, data),                    // 封装 playerSendMessage（保留现有消息类型）
  resolveUrl(track, callback),         // callback({ url, bitrate, platform } | null)
}
```

- `resolveUrl` 直连 `MediaService.bootstrapTrack`（front、Electron，以及历史上加载了服务层脚本的后台页，与现有行为一致）；
- 环境里没有 `MediaService` 时（Firefox MV2 后台页只加载了引擎脚本）**立即 `callback(null)` 判失败**，不挂起会话：全仓没有任何 `BG_PLAYER:RETRIEVE_URL` 的消费者（现有代码也只构造、从不发送），走消息回传协议只会变成「每次播放等超时再逐首跳」；
- `mode` 是活属性：`PlayerCore.setMode()` 用它切换消息通道，并在模式真正变化时广播一次 `READY`（修掉当前「READY 用顶层 `this.mode`、永远发不出去」的问题）。

### 4.5 PlayerCore

对外接口与现有 `Player` 完全同名同义（`window.threadPlayer` / `l1_player.js` 不动）：

- 数据与查询：`playlist`（只读列表视图）、`index`、`currentAudio`、`currentHowl`、`playing`、`loop_mode`、`muted`、`volume`、`getAudioState()`；
- 播放：`play()`、`pause()`、`playById()`、`loadById()`、`skip(direction)`、`seek()`、`seekTime()`、`setRefreshRate()`、`setMode()`；
- 列表：`insertAudio()`、`insertAudioByDirection()`、`removeAudio()`、`appendAudioList()`、`clearPlaylist()`、`setNewPlaylist()`、`stopAll()`；
- 音量：`setVolume()`、`adjustVolume()`、`setMuted()`、`toggleMuted()`、`applyAudioState()`；
- 广播与内部兼容：`sendFrameUpdate()`、`sendPlayingEvent()`、`sendLoadEvent()`、`sendAudioStateEvent()`、`sendPlaylistEvent()`、`setMediaURI()`、`setAudioDisabled()`。

> 旧的 `retrieveMediaUrl` / `finishLoad` / `startRandomRound` / `resetRandomPlaylist` 是实现细节，不再挂在实例上（全仓无调用方）；`playlist` 是只读 getter，外部不应赋值。若后续要恢复「实例对外面完全一致」，加薄包装即可。

## 5. 切歌时序（load session 代际）

一次切歌 = 一个 load session，`generation` 自增：

1. 计算目标下标；`generation += 1`，本次 token = `generation`；
2. 同步更新 `PlaylistModel.index`；
3. `mediaSession.setTrack(目标曲目)`——**metadata 立刻换**；`setPlaybackState('paused')`；
4. `audioEngine.pause()`——旧音频只暂停，元素与媒体会话保留；
5. 发 `BG_PLAYER:LOAD`；
6. 取地址**优先查缓存**：`_media_uri_list[track.id]` 已有地址时直接用它建新 Howl（仍是新会话），不重复请求 provider；
7. 无缓存才 `host.resolveUrl(track, callback)`（异步，可能乱序），回调一路带着**目标曲目的对象与 id**：
   - 回调若 `token !== 当前 generation`：只把 URL 写入缓存，**不建 Howl、不播放、不改状态**；
   - 按 `trackId` 重新定位下标（等待期间列表可能被插入/拖动）：定位不到（曲目已删）则作废本会话并 `generation += 1`；
   - 当前代成功：`audioEngine.load({ url, track, token })`，然后按 session 的 `playNow` 决定是否 `play()`（用户在等待期间按了暂停则 `playNow=false`）；
   - 当前代失败：标记 disabled、发 `RETRIEVE_URL_FAIL`、`skip('next')`；用「正在前进」标志防重入；
8. 当前代 `playing` 事件：`mediaSession.setPlaybackState('playing')`；`audioEngine.unloadOtherThan(当前 Howl)` 并清空其它曲目的 `howl` 引用（定向卸载，**不调用全局 `Howler.unload()`**）；等待期间按了暂停（`playNow=false`）时，URL 回来只建 Howl 不播放，且立刻把它卸载（地址留在缓存里），不留下不播的音频元素；
9. 当前代 `paused` / `ended` / `error` 才被采纳；非当前代事件全部丢弃。`ended` 按 `loop_mode` 走 next / 随机 / 单曲循环；
10. 新一轮 session 开始时，上一轮的 `playNow`、待处理回调全部作废。

> **状态广播补偿**：旧事件因代际过期被丢弃后，就不会再有 `PLAY_STATE` 通知 UI。因此凡是「暂停/清空/换列表」把当前音频停下的入口，都要自己补发一条 `PLAY_STATE`（`_beginSession` 与 `setNewPlaylist` 发 `isPlaying=false`、`clearPlaylist` 发 `Stopped`、`load()` 发 `Stopped`），否则 `play.js` 的 `isPlaying` 会卡在 true。同理，当前代 Howl 播放失败后（`_handleAudioError` 先卸载 Howl、播放状态已归 false）以及 `skip()` 走 `RETRIEVE_URL_FAIL_ALL` 的两个分支，也要补 `playbackState='paused'` + `isPlaying=false` 的 `PLAY_STATE`。
>
> **`currentHowl` 语义**：取地址窗口内当前曲目还没有自己的 Howl，`currentHowl` 返回 `null`（旧 Howl 虽被保留但不算当前曲目），`seek*` / `sendFrameUpdate` 因此不会误操作上一首。

### 其它入口的一致性

- `loadById` / `load` 是「选择曲目、不播放」：`generation += 1`、更新 index、暂停旧音源、立即 `setTrack` 新曲、发 `LOAD`，**不取 URL**；`play()` / `playById` 才开启取 URL 的 session（`playById` 直接以 `playNow = true` 开 session）；
- 列表编辑（`insertAudio` / `insertAudioByDirection` / `appendAudioList`）只改数据并广播 `PLAYLIST` / `LOAD`，不触碰播放 session；
- `removeAudio`：删的是当前曲目且原本在播时，按新下标以 `playNow = true` 重新开 session；否则只改数据与下标；
- `pause()`：暂停当前 Howl、`playbackState = 'paused'`；若当前 session 还在等 URL，则把 `playNow` 置 false；
- `play()`：若当前曲目已有 Howl 直接播；否则以当前曲目开新 session（`playNow = true`）；
- `clearPlaylist()`：`generation += 1` 作废 pending、`audioEngine.pause()` + 定向卸载、`playbackState = 'none'` 并清空 metadata；
- `setNewPlaylist()`：`generation += 1`、卸载旧列表 Howl、替换列表、从首曲（随机模式则随机首曲）选中并 `setTrack`，**不取 URL、不播放**（现有调用方 `navigation.js` 之后都会紧跟 `l1Player.play()`；`connectPlayer` 恢复上次歌单时则不应自动播放）；
- 帧定时器：`duration > 0` 才调 `mediaSession.setPosition`，并照旧广播 `FRAME_UPDATE`。

## 6. 错误处理

- URL 获取失败（当前代）：`disabled = true`，`RETRIEVE_URL_FAIL`；按现有语义尝试下一首，全部不可用则发 `RETRIEVE_URL_FAIL_ALL`；通过 `_advancing` 标志防止递归/重入；
- Howl `onloaderror` / `onplayerror`（当前代）：发 `PLAY_FAILED`、`disabled = true`、卸载该 Howl 并清引用，再走「失败跳下一首」。**这是本次唯一有意的播放控制行为变化**：旧实现只通知不跳曲；同时清掉该曲目的地址缓存，避免下次命中过期地址。卸载后必须补 `mediaSession.setPlaybackState('paused')` + `PLAY_STATE isPlaying=false`，否则单曲歌单/全部不可播时 UI 会永久停在播放态；
- 非当前代的任何错误：忽略，只做该事件自身的资源清理（若该 Howl 已不是当前，直接卸载；卸载期间抑制该 Howl 的事件，防止自我递归）；
- `setPositionState` / `MediaMetadata` 在 API 不支持或参数不合法时静默跳过，不抛异常。

## 7. 消息与兼容

消息类型与负载保持现有集合不变：`LOAD`、`PLAY_STATE`、`FRAME_UPDATE`、`PLAYLIST`、`AUDIO_STATE`、`RETRIEVE_URL`、`RETRIEVE_URL_SUCCESS`、`RETRIEVE_URL_FAIL`、`RETRIEVE_URL_FAIL_ALL`、`PLAY_FAILED`、`READY`。

- `l1_player.js` 不修改；
- `js/controller/play.js` 不修改；
- `js/bridge.js` 不修改（host 只调用其现有函数）；
- `js/player_thread.js` 变为 bootstrap，`window.threadPlayer` 仍是 `PlayerCore` 实例。

## 8. 测试策略

新增 `test/helpers/player_lifecycle_harness.js`，用 fake 依赖组合 `PlayerCore`（`PlaylistModel` 与 `AudioEngine` 用真实实现，Howler 用 stub）：

- `PlaylistModel` / `AudioEngine` 用真实实现，`AudioEngine` 的 `Howl` 换成一个会被手动触发的 stub（`play()` 同步回调 `onplay`，可直接调 `onpause/onend/onloaderror`）；
- fake `MediaSessionController`：记录 `setTrack/clearTrack/setPlaybackState/setPosition` 调用序列；
- fake host：`resolveUrl` 只把回调排队，测试可手动 resolve 出 URL 或失败，用于乱序场景。

`test/player_lifecycle.test.js` 覆盖：

1. 切歌瞬间：旧音源只 `pause`、不 `unload`；`setTrack` 立即拿到新曲；`playbackState` 为 `paused`；
2. 新曲 `playing` 后才 `unloadOtherThan`，旧 Howl 被定向卸载；
3. 乱序 URL：先发的请求晚回来被丢弃，最终只播最后一代；
4. 过期请求失败不触发跳歌；
5. 旧 Howl 的 `paused/ended/error` 事件不影响当前状态、不额外跳歌；
6. 等待 URL 期间按暂停：`playNow` 作废，URL 返回后不自动播放，也不留下不播的 Howl；
7. `duration = 0` 时不调用 `setPosition`；
8. `clearPlaylist` 作废 pending 请求并置 `playbackState = none`。

独立审查后补充的回归用例（`test/player_lifecycle.test.js` 的「独立审查发现的回归用例」块）：

- 播放中再次 `play()` / `playById(当前曲目)`：不得再次调用 `Howl.play()`（Howler 会为正在播放的 Howl 新建 sound，导致同一首歌双声），也不得重复发 `Playing`；
- 当前代 Howl `onplayerror`：补 `playbackState='paused'` 与 `isPlaying=false`，并广播 `RETRIEVE_URL_FAIL_ALL`；
- `loadById(未知 id)` 保持旧实现的 no-op（不补发 `LOAD`）；
- 删除「当前但未在播放」的曲目后，媒体会话切到新的当前曲目；删除「最后一首正在播放」的曲目后清 metadata、`playbackState='none'` 并补发 `isPlaying=false`；
- `RETRIEVE_URL_SUCCESS` 负载保留 `url`、`RETRIEVE_URL_FAIL` 保留 `playNow`（与旧消息字段一致）。

现有测试迁移：

- `test/helpers/player_harness.js` 改为加载 `js/player/playlist_model.js` + `js/player/player_core.js`（vm 沙箱中组合）；
- `test/player_shuffle.test.js`：断言不变，只把读取随机内部状态的路径改为 `player.playlistModel`；
- `test/netease_provider.test.js`、`test/lyric_translation_switch.test.js`、`test/playlist_filter.test.js` 不受影响。

另加 `test/runtime_paths.test.js`：按 `listen1.html` 真实脚本顺序（bridge + `js/player/*` + `player_thread`）载入 vm 沙箱，只 stub 浏览器重依赖，冒烟三条运行时路径 —— front（Chrome/Edge/Electron 同路）、background（Firefox MV2 后台页无 `MediaService` 时 fail-fast）、Electron 最差环境（无 `chrome.*` / 无 mediaSession）。

## 9. 实施顺序（每步可独立跑测试、独立提交）

1. **PlaylistModel**：搬列表与随机逻辑 + 迁移 shuffle 测试；
2. **MediaSessionController**：实现 + 单测（fake navigator）；
3. **AudioEngine**：实现 + 单测（复用现有 Howler stub 思路）；
4. **PlayerCore + host + bootstrap**：接入、替换 `player_thread.js`、更新 `listen1.html` / `manifest_firefox.json` 脚本列表；新增生命周期测试；
5. **清理**：删除旧代码残渣，`docs/INDEX.md` 的模块表同步，`npm test` / eslint / prettier 全绿。

## 10. 风险与回滚

- 风险最高的是第 4 步（切换实现）。旧的 `player_thread.js` 在第 4 步前保持可用，切换作为一个独立提交，出问题可整提交回滚；
- 现有随机播放测试在第一步就可能暴露搬迁错误，提前拦住；
- 不保证 Firefox / Electron 可用性：host 抽象保留，但只做代码审查，不写专项测试。

## 11. 验收标准

- [ ] 播放中用系统媒体控件切歌，控件不消失、标题立即更新为新曲；
- [ ] 快速连续切歌只播放最后选中的曲目，不会串歌；
- [ ] 切歌后旧音频元素在新曲开始播放后即被卸载，不累积；
- [ ] 暂停/恢复、进度上报、随机播放行为与当前一致；
- [ ] `npm test` 全绿；eslint / prettier 干净；
- [ ] `js/controller/play.js`、`js/l1_player.js`、`js/bridge.js` 零改动（除脚本加载清单）。
