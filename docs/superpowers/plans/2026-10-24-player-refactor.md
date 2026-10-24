# 播放器子系统重构实施计划（god class 拆分 + Howl 生命周期重写）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `js/player_thread.js` 里的 god class 拆成 `PlaylistModel` / `AudioEngine` / `MediaSessionController` / `PlayerCore` / `createPlayerHost` 五个模块，重写 Howl 生命周期（切歌瞬间旧音频只暂停、新曲开播后再定向卸载、load session 代际校验），使系统媒体控件在切歌时不再消失、快速连切不再串歌。

**Architecture:** 依赖方向单向：`player_thread.js`（bootstrap）→ `createPlayerHost()`（运行时适配：消息通道 / 取播放地址）与 `PlayerCore`（编排：代际、URL 生产/消费、错误、广播）→ `PlaylistModel`（纯数据 + 随机走位）/ `AudioEngine`（单曲 Howl 生命周期）/ `MediaSessionController`（`navigator.mediaSession` 唯一写入点）。三个叶子模块互不依赖，`PlayerCore` 是唯一持有播放状态机的地方。

**Tech Stack:** 无构建、全局类、`<script>` 顺序加载（浏览器扩展）；Howler.js（`html5: true`）；AngularJS 控制器与门面零改动；`node:test` + `vm` 沙箱回归测试；eslint 7（airbnb-base + prettier）+ prettier 2。

**Spec:** `docs/superpowers/specs/2026-10-24-player-refactor-design.md`（本计划的依据；两者冲突时以本计划的「与 spec 的差异」一节为准）

## Global Constraints

- **不要提交 git**：仓库约定（`docs/CONVENTIONS.md` §9）只有用户明确要求时才 `git commit`/`git push`。每个任务结束只做「测试 + lint + prettier」，把改动留在工作区。
- **不改这些文件**：`js/controller/play.js`、`js/l1_player.js`、`js/bridge.js`（除 `listen1.html` / `manifest_firefox.json` 的脚本清单外，Task 6 才动清单）。它们的公开契约必须继续成立：`window.threadPlayer` 的方法/属性名不变、`BG_PLAYER:*` 消息类型与负载不变。
- **对外行为不变**：播放列表增删/排序/随机走位/循环模式/音量静音/进度上报语义与现状一致；只有「切歌瞬间的媒体会话与音频元素生命周期」按新设计变化。
- **只在 `front` 运行时做完整测试（Chrome/Edge MV3）**；Firefox MV2 后台页与 Electron 只保证代码路径搭好、不改既有缺陷。
- **无构建、全局类**：新文件放 `js/player/`，文件内类/函数声明在顶层（跨 `<script>` 共享全局），需要跨文件引用的全局写 `/* global X Y */` 注释；只在本文件声明、供其它脚本使用的类加 `// eslint-disable-next-line no-unused-vars`（仓库既有写法，见 `js/provider/xiami.js` 顶部）。
- **ESLint 规则**：所有新文件顶部按需加 `/* eslint-disable no-underscore-dangle */`（新模块普遍用 `_foo` 私有字段，与 `js/player_thread.js` 现有写法一致）。禁止 `for...of` / `continue` / `++`；空 `catch` 块内必须写注释。
- **本机命令执行方式（重要）**：本机 PowerShell 管道会破坏 node 的 stdio（报 `ResourceUnavailable` / `拒绝访问`）。所有 node/npm 命令都必须用 `cmd /c "… > 输出文件 2>&1"` 落盘，再 `Get-Content` 读文件：
  - 测试：`cmd /c "npm test > test_out.txt 2>&1"` → `Get-Content test_out.txt`
  - 单文件测试：`cmd /c "node --test --test-isolation=none test/xxx.test.js > test_out.txt 2>&1"`
  - lint：`cmd /c "node node_modules\eslint\bin\eslint.js 目标文件 > lint_out.txt 2>&1"`
  - 格式化：`cmd /c "node node_modules\prettier\bin-prettier.js --write 目标文件 > prettier_out.txt 2>&1"`
  - 不要用 `npx`（本机 `npx.ps1` 起不来，会报 StandardOutputEncoding 错误）。临时输出文件用完删掉，不要留进工作区。
- **Node 版本**：`node --test` 需要 ≥ 22.8，本机为 v24，可直接用。
- **文档纪律**：`docs/` 下不写代码行号，定位用搜索串（`CONVENTIONS.md` §1）；CHANGELOG 一条 bullet 一句话、日期小节 `## YYYY-MM-DD`、Added/Changed/Fixed 分组。

## 与 spec 的差异（实现以本计划为准，spec 已同步更新）

1. `AudioEngine` 事件在 spec 列表外补 `stopped`（Howler 的 `onstop` 事件目前会发 `PLAY_STATE` reason=`Stopped`，对外行为保持不变），事件额外携带 `error`（`onloaderror` / `onplayerror` 的第二个参数）；engine 增加 `get currentTrack()`（当前 Howl 对应的曲目对象，供 `PlayerCore` 判断 Howl 是否属于当前曲目）与「卸载期间抑制该 Howl 事件」的防递归机制（`unload` 幂等、不重入）。
2. `createPlayerHost()` 不实现消息回传分支：环境里没有 `MediaService` 时立即 `callback(null)` 判失败（全仓没有 `BG_PLAYER:RETRIEVE_URL` 的消费者），不引入超时挂起。
3. `PlayerCore.setMode(mode)` 在模式真正变化时广播一次 `BG_PLAYER:READY`（现在这条消息因顶层 `this.mode` 恒为 `undefined` 而永远发不出去，见 `docs/INDEX.md` §12 第 5 条）。
4. `setNewPlaylist()` **不自动播放**：只替换列表、选中首曲（随机模式随机首曲）、`setTrack` + 发 `PLAY_STATE`(false) + `LOAD`；播放由调用方 `l1Player.play()` 启动（`navigation.js` 两处调用都紧跟 `play()`，`connectPlayer` 恢复歌单时不能自动播放）。
5. **URL 缓存优先**：`_media_uri_list` 缓存 `{url, bitrate, platform}`，`_startSession()` 命中缓存时直接建新 Howl（仍是新会话、新 Howl），不重复请求 provider，且不得把已有 bitrate/platform 覆盖成 `undefined`。
6. Howl `onloaderror`/`onplayerror`（当前代）按 spec §6 跳过下一首（旧实现只通知不跳），并清掉该曲目的地址缓存——这是本次唯一有意的播放控制行为变化。

## 文件结构（Task 划分依据）

| 文件                                                                                                                    | 动作                  | 职责                                                                                            | 任务 |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------- | ---- |
| `js/player/playlist_model.js`                                                                                           | 新建                  | 列表数据、当前下标、随机洗牌袋与走位（纯函数，无全局依赖）                                      | 1    |
| `js/player/media_session.js`                                                                                            | 新建                  | `navigator.mediaSession` 唯一写入点（特性探测，不支持时全 no-op）                               | 2    |
| `js/player/audio_engine.js`                                                                                             | 新建                  | 单曲 Howl 生命周期与事件（只依赖 `Howl`/`Howler` 全局）                                         | 3    |
| `js/player/player_host.js`                                                                                              | 新建                  | 运行时适配：`send`（消息通道）+ `resolveUrl`（MediaService 直连；无 MediaService 时立即判失败） | 4    |
| `js/player/player_core.js`                                                                                              | 新建                  | 编排：代际 token、URL 生产/消费、媒体会话单点写入、错误跳曲、广播                               | 5    |
| `js/player_thread.js`                                                                                                   | 重写为 bootstrap      | 建 host + PlayerCore，挂 `window.threadPlayer`                                                  | 6    |
| `listen1.html`                                                                                                          | 改脚本清单            | `js/player/*.js` 按依赖顺序插在 `js/player_thread.js` 前                                        | 6    |
| `manifest_firefox.json`                                                                                                 | 改 background.scripts | 同上（后台页可用性不做专项测试）                                                                | 6    |
| `test/helpers/player_vm.js`                                                                                             | 新建                  | 共享的 vm 沙箱加载器（Task 1 创建，2/3/5 复用）                                                 | 0    |
| `test/playlist_model.test.js` / `test/media_session.test.js` / `test/audio_engine.test.js` / `test/player_host.test.js` | 新建                  | 叶子模块单测                                                                                    | 1-4  |
| `test/helpers/player_lifecycle_harness.js` / `test/player_lifecycle.test.js`                                            | 新建                  | `PlayerCore` 生命周期场景测试（真实 model/engine + stub Howl + fake host/mediaSession）         | 5    |
| `test/runtime_paths.test.js`                                                                                            | 新建                  | 三套运行时（front / background / Electron 最差环境）按真实脚本顺序加载的冒烟测试                | 6    |
| `test/helpers/player_harness.js`                                                                                        | 重写                  | 载入新模块组合出 `PlayerCore`（替代现在只载 `player_thread.js` 的做法）                         | 6    |
| `test/player_shuffle.test.js`                                                                                           | 小改                  | 随机内部状态的读取路径从 `player._random_*` 改到 `player.playlistModel._random_*`，断言不变     | 6    |
| `docs/INDEX.md` / `CHANGELOG.md` / spec 状态                                                                            | 改                    | 模块索引、启动顺序、已知问题、变更记录                                                          | 7    |

---

### Task 0: 共享测试加载器

**Owner:** Lead（派发 teammates 前先完成，其它任务都依赖它）

**Files:**

- Create: `test/helpers/player_vm.js`

**Interfaces:**

- Produces:

  - `loadScripts(sandbox, files)` → 返回 vm context。`sandbox` 是被补全局的对象（会在 context 里变成全局对象）；`files` 是相对仓库根的路径数组（如 `'js/player/playlist_model.js'`），按顺序执行。
  - `globalValue(context, expression)` → 在 context 里求表达式，用于取回 `class Foo` 这类不挂在全局对象上的词法绑定（如 `globalValue(context, 'PlaylistModel')`）。
  - `ROOT` 常量（仓库根绝对路径）。

- [ ] **Step 1: 写加载器**

```js
/**
 * 共享 vm 沙箱加载器：被测文件是浏览器脚本（无 import/export，依赖全局），
 * 这里只负责「同一个 context 里按顺序跑多个脚本」和「取回顶层 class 绑定」。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

/**
 * @param {object} sandbox 需要补的浏览器全局（会被 context 化）
 * @param {string[]} files 相对仓库根的脚本路径，按顺序执行
 */
function loadScripts(sandbox, files) {
  const context = vm.createContext(sandbox);
  files.forEach((file) => {
    const full = path.join(ROOT, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), context, {
      filename: full,
    });
  });
  return context;
}

/** 在 context 里求一个表达式（用于取回顶层 class / 函数绑定） */
function globalValue(context, expression) {
  return vm.runInContext(expression, context);
}

module.exports = { ROOT, loadScripts, globalValue };
```

- [ ] **Step 2: lint**

Run: `cmd /c "node node_modules\eslint\bin\eslint.js test\helpers\player_vm.js > lint_out.txt 2>&1"`
Expected: 无输出（空文件）。

---

### Task 1: PlaylistModel

**Owner:** `model-dev` teammate

**Files:**

- Create: `js/player/playlist_model.js`
- Test: `test/playlist_model.test.js`
- 依赖: 无（只依赖 Task 0 的 `test/helpers/player_vm.js`）

**Interfaces:**

- Produces（后续任务按这些名字/签名使用）：

  - `class PlaylistModel`：`constructor(list = [])`、`get length()`、`get index()`/`set index(value)`、`get current()`、`get tracks()`、`get loopMode()`/`set loopMode(value)`、`setList(list, { index } = {})`、`findIndexById(id)`、`static array_move(arr, oldIndex, newIndex)`、`insert(track, at)`（返回新下标；重复 id 返回 `-1`）、`insertByDirection(track, target, direction)`（返回新下标；无法定位返回 `-1`）、`remove(at)`（返回被删曲目；非法下标返回 `null`）、`static buildShuffleBag(l)`、`static randomRoundLength(l)`、`startRandomRound(originIndex)`、`resetRandomState()`、`nextIndex(direction)`。
  - 内部字段（测试直接读，沿用现有 shuffle 测试的做法）：`_tracks`、`_index`、`_loopMode`、`_random_playlist`、`_random_anchor`、`_random_steps`、`_random_len`。

- [ ] **Step 1: 写失败测试**

创建 `test/playlist_model.test.js`：

```js
/**
 * PlaylistModel 的行为测试：列表增删/下标维护、顺序走位、随机洗牌袋子。
 * 算法本身是从 js/player_thread.js 原样搬来的，断言口径与 test/player_shuffle.test.js 一致。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert');
const { loadScripts, globalValue } = require('./helpers/player_vm');

function createModel(tracks, options = {}) {
  const { index = 0, loopMode = 0 } = options;
  const context = loadScripts({}, ['js/player/playlist_model.js']);
  const PlaylistModel = globalValue(context, 'PlaylistModel');
  const model = new PlaylistModel();
  model.setList(
    tracks.map((track) => ({ ...track })),
    { index }
  );
  model.loopMode = loopMode;
  return model;
}

const makeTracks = (count, prefix = 't') =>
  Array.from({ length: count }, (_v, i) => ({ id: `${prefix}${i}` }));

describe('PlaylistModel：列表与下标', () => {
  test('setList 拷贝列表并按 index 定位，越界退回 0，空列表为 -1', () => {
    const sandbox = {};
    const context = loadScripts(sandbox, ['js/player/playlist_model.js']);
    const PlaylistModel = globalValue(context, 'PlaylistModel');
    const model = new PlaylistModel();

    model.setList(makeTracks(3), { index: 2 });
    assert.strictEqual(model.length, 3);
    assert.strictEqual(model.index, 2);
    assert.strictEqual(model.current.id, 't2');

    model.setList(makeTracks(3), { index: 99 });
    assert.strictEqual(model.index, 0);

    model.setList([], {});
    assert.strictEqual(model.length, 0);
    assert.strictEqual(model.index, -1);
    assert.strictEqual(model.current, undefined);
  });

  test('insert 去重、返回新下标、插到当前曲目前面不换当前曲目', () => {
    const model = createModel(makeTracks(3), { index: 2 });
    const insertedIndex = model.insert({ id: 'x', title: 'x' }, 1);

    assert.strictEqual(insertedIndex, 1);
    assert.strictEqual(model.length, 4);
    assert.strictEqual(model.tracks[1].id, 'x');
    assert.strictEqual(model.current.id, 't2');
    assert.strictEqual(model.insert({ id: 't0' }, 0), -1);
    assert.strictEqual(model.length, 4);
  });

  test('insertByDirection 把曲目挪到目标之前/之后，并保住当前曲目', () => {
    const model = createModel(makeTracks(4), { index: 0 });
    model.insertByDirection({ id: 't3' }, { id: 't0' }, 'top');
    assert.deepStrictEqual(
      model.tracks.map((track) => track.id),
      ['t3', 't0', 't1', 't2']
    );
    assert.strictEqual(model.current.id, 't0');
    assert.strictEqual(model.index, 1);

    model.insertByDirection({ id: 't3' }, { id: 't2' }, 'bottom');
    assert.deepStrictEqual(
      model.tracks.map((track) => track.id),
      ['t0', 't1', 't3', 't2']
    );
    assert.strictEqual(model.current.id, 't0');
    assert.strictEqual(model.index, 0);
  });

  test('remove 返回被删曲目，当前曲目被删时下标就近收敛', () => {
    const model = createModel(makeTracks(3), { index: 2 });
    const removed = model.remove(2);

    assert.strictEqual(removed.id, 't2');
    assert.strictEqual(model.length, 2);
    assert.strictEqual(model.index, 1);
    assert.strictEqual(model.remove(99), null);
  });
});

describe('PlaylistModel：随机走位', () => {
  test('洗牌袋长度 2l，前半是排列、后半是逆映射', () => {
    const sandbox = {};
    const context = loadScripts(sandbox, ['js/player/playlist_model.js']);
    const PlaylistModel = globalValue(context, 'PlaylistModel');

    [1, 2, 5].forEach((l) => {
      const bag = PlaylistModel.buildShuffleBag(l);
      assert.strictEqual(bag.length, l * 2);
      const order = bag.slice(0, l);
      assert.deepStrictEqual(
        order.slice().sort((a, b) => a - b),
        Array.from({ length: l }, (_v, i) => i)
      );
      order.forEach((trackIndex, position) => {
        assert.strictEqual(bag[l + trackIndex], position);
      });
    });
  });

  test('轮长落在 [ceil(l/2), l]', () => {
    const sandbox = {};
    const context = loadScripts(sandbox, ['js/player/playlist_model.js']);
    const PlaylistModel = globalValue(context, 'PlaylistModel');

    for (let trial = 0; trial < 50; trial += 1) {
      [2, 5, 8].forEach((l) => {
        const length = PlaylistModel.randomRoundLength(l);
        assert.ok(Number.isInteger(length));
        assert.ok(length >= Math.max(1, Math.ceil(l / 2)) && length <= l);
      });
    }
  });

  test('顺序模式循环走位，prev 反向；空列表返回原下标', () => {
    const model = createModel(makeTracks(4), { index: 0, loopMode: 0 });
    const visited = [];
    for (let i = 0; i < 5; i += 1) {
      model.index = model.nextIndex('next');
      visited.push(model.index);
    }
    assert.deepStrictEqual(visited, [1, 2, 3, 0, 1]);

    model.index = 0;
    assert.strictEqual(model.nextIndex('prev'), 3);

    const empty = createModel([], { index: -1, loopMode: 0 });
    assert.strictEqual(empty.nextIndex('next'), -1);
  });

  test('随机模式：相邻不重复、能走遍全部曲目、prev 后 next 回到原曲', () => {
    const model = createModel(makeTracks(6), { index: 0, loopMode: 2 });
    const visited = new Set([0]);
    let previous = 0;
    for (let i = 0; i < 2000; i += 1) {
      model.index = model.nextIndex('next');
      assert.notStrictEqual(model.index, previous);
      visited.add(model.index);
      previous = model.index;
    }
    assert.strictEqual(visited.size, 6);

    for (let i = 0; i < 200; i += 1) {
      model.index = model.nextIndex('next');
      const current = model.index;
      model.index = model.nextIndex('prev');
      model.index = model.nextIndex('next');
      assert.strictEqual(model.index, current);
    }
  });

  test('歌单与模式变化会作废洗牌袋', () => {
    const model = createModel(makeTracks(5), { index: 0, loopMode: 2 });
    model.index = model.nextIndex('next');
    assert.ok(model._random_playlist.length > 0);

    model.insert({ id: 'new' }, 0);
    assert.strictEqual(model._random_playlist.length, 0);

    model.index = model.nextIndex('next');
    assert.ok(model._random_playlist.length > 0);
    model.loopMode = 0;
    assert.strictEqual(model._random_playlist.length, 0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cmd /c "node --test --test-isolation=none test/playlist_model.test.js > test_out.txt 2>&1"`
Expected: FAIL（`js/player/playlist_model.js` 不存在，`ENOENT`）。

- [ ] **Step 3: 实现 `js/player/playlist_model.js`**

```js
/* eslint-disable no-underscore-dangle */
// eslint-disable-next-line no-unused-vars
class PlaylistModel {
  constructor(list = []) {
    this._tracks = [];
    this._index = -1;
    this._loopMode = 0;
    this.resetRandomState();
    if (Array.isArray(list) && list.length > 0) {
      this.setList(list);
    }
  }

  get length() {
    return this._tracks.length;
  }

  get index() {
    return this._index;
  }

  set index(value) {
    this._index = value;
  }

  get current() {
    return this._tracks[this._index];
  }

  get tracks() {
    return this._tracks;
  }

  get loopMode() {
    return this._loopMode;
  }

  set loopMode(value) {
    if (value === this._loopMode) return;
    this._loopMode = value;
    // 换播放模式后旧洗牌顺序作废：切进随机要重新洗牌，切出去也不必留着
    this.resetRandomState();
  }

  findIndexById(id) {
    return this._tracks.findIndex((track) => track.id === id);
  }

  /**
   * 替换整个列表；随机状态作废。
   * @param {Array} list 曲目数组
   * @param {{index?: Number}} [options] 目标下标；越界/缺省时退回 0
   */
  setList(list, options = {}) {
    this._tracks = Array.isArray(list) ? list.slice() : [];
    this.resetRandomState();
    const { index } = options;
    if (this._tracks.length === 0) {
      this._index = -1;
    } else if (
      typeof index === 'number' &&
      index >= 0 &&
      index < this._tracks.length
    ) {
      this._index = index;
    } else {
      this._index = 0;
    }
    return this._tracks;
  }

  static array_move(arr, oldIndex, newIndex) {
    // https://stackoverflow.com/questions/5306680/move-an-array-element-from-one-array-position-to-another
    if (newIndex >= arr.length) {
      let k = newIndex - arr.length + 1;
      while (k > 0) {
        k -= 1;
        arr.push(undefined);
      }
    }
    arr.splice(newIndex, 0, arr.splice(oldIndex, 1)[0]);
    return arr;
  }

  /**
   * 插入曲目（按 id 去重）；插到当前曲目之前时按 id 找回当前下标。
   * @returns {Number} 新下标；重复曲目返回 -1
   */
  insert(track, at) {
    if (!track || this.findIndexById(track.id) >= 0) return -1;
    const originTrack = this.current;
    let insertedIndex;
    if (typeof at === 'number' && at >= 0 && at < this._tracks.length) {
      this._tracks.splice(at, 0, track);
      insertedIndex = at;
    } else {
      this._tracks.push(track);
      insertedIndex = this._tracks.length - 1;
    }
    const originIndex = originTrack ? this.findIndexById(originTrack.id) : -1;
    if (originIndex >= 0) {
      this._index = originIndex;
    }
    this.resetRandomState();
    return insertedIndex;
  }

  /**
   * 把已在列表里的曲目挪到目标曲目之前（top）或之后（bottom）。
   * @returns {Number} 新下标；定位失败返回 -1
   */
  insertByDirection(track, target, direction) {
    const trackIndex = this.findIndexById(track && track.id);
    const insertIndex = this.findIndexById(target && target.id);
    if (trackIndex < 0 || insertIndex < 0 || trackIndex === insertIndex) {
      return -1;
    }
    const originTrack = this.current;
    const targetIndex =
      insertIndex > trackIndex ? insertIndex - 1 : insertIndex;
    const offset = direction === 'top' ? 0 : 1;
    this._tracks = PlaylistModel.array_move(
      this._tracks,
      trackIndex,
      targetIndex + offset
    );
    const originIndex = originTrack ? this.findIndexById(originTrack.id) : -1;
    if (originIndex >= 0) {
      this._index = originIndex;
    }
    this.resetRandomState();
    return targetIndex + offset;
  }

  /**
   * 删除曲目：当前曲目被删时下标就近收敛（旧实现语义）。
   * @returns {Object|null} 被删曲目；非法下标返回 null
   */
  remove(at) {
    if (!this._tracks[at]) return null;
    const removed = this._tracks[at];
    const currentId = this.current ? this.current.id : undefined;
    this._tracks.splice(at, 1);
    this.resetRandomState();
    if (this._tracks.length === 0) {
      this._index = -1;
      return removed;
    }
    const foundIndex =
      currentId === undefined ? -1 : this.findIndexById(currentId);
    if (foundIndex >= 0) {
      this._index = foundIndex;
    } else {
      this._index = at >= this._tracks.length ? this._tracks.length - 1 : at;
    }
    return removed;
  }

  /**
   * 随机播放的洗牌袋：长度 2l，前半是本轮播放顺序（值为曲目下标），
   * 后半是逆映射（[l + 下标] = 它在本轮里的位置），走位靠它 O(1) 计算。
   * 用标准 Fisher–Yates（j ∈ [0, i]）保证 l! 种顺序等概率；少取一项（j ∈ [0, i-1]，
   * 即"不和自己交换"）会让可达顺序退化成 (l-1)! 种，短歌单下随机播放会变成固定循环。
   */
  static buildShuffleBag(l) {
    const order = Array.from({ length: l }, (_v, i) => i);
    for (let i = l - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const swap = order[i];
      order[i] = order[j];
      order[j] = swap;
    }
    const bag = order.concat(new Array(l).fill(0));
    order.forEach((trackIndex, position) => {
      bag[l + trackIndex] = position;
    });
    return bag;
  }

  /**
   * 本轮长度：半随机 —— 至少半张表，至多整张表。
   * 轮长不满 l 时"刚播完的那首"天然落在本轮之外（它就在锚位上），
   * 于是既不会跨轮连播同一首，轮末那首也不会被同一首长期占住。
   */
  static randomRoundLength(l) {
    const minLength = Math.max(1, Math.ceil(l / 2));
    return minLength + Math.floor(Math.random() * (l - minLength + 1));
  }

  /**
   * 开一轮新的随机播放：重洗，并把当前曲目放在锚位（本轮从锚位之后开始走）。
   * @param {Number} originIndex 当前曲目下标；不在范围内表示没有正在播的曲目
   */
  startRandomRound(originIndex) {
    const l = this._tracks.length;
    const bag = PlaylistModel.buildShuffleBag(l);
    const originInRange = originIndex >= 0 && originIndex < l;
    this._random_playlist = bag;
    this._random_anchor = originInRange ? bag[l + originIndex] : l - 1;
    this._random_steps = 0;
    this._random_len = PlaylistModel.randomRoundLength(l);
  }

  /** 丢掉随机播放状态：下一次随机走位会重新洗牌。 */
  resetRandomState() {
    this._random_playlist = [];
    this._random_anchor = -1;
    this._random_steps = 0;
    this._random_len = 0;
  }

  /**
   * 计算方向上的目标下标（不修改 this.index）。
   * @param {'next'|'prev'|'random'} direction
   * @returns {Number} 目标下标；空列表时返回原下标
   */
  nextIndex(direction) {
    const idx = this._index;
    const l = this._tracks.length;
    // 空歌单：没有可走位的位置
    if (l === 0) return idx;

    const indexInRange = idx >= 0 && idx < l;
    const randomMode = this._loopMode === 2 || direction === 'random';

    if (!randomMode) {
      if (this._random_playlist.length !== 0) {
        this.resetRandomState();
      }
      if (!indexInRange) return direction === 'prev' ? l - 1 : 0;
      return direction === 'prev' ? (idx - 1 + l) % l : (idx + 1) % l;
    }

    if (!indexInRange) {
      // 没有正在播的曲目：开一轮新的，从新顺序的头 / 尾进入
      this.startRandomRound(-1);
      this._random_steps = direction === 'prev' ? 0 : 1;
      return this._random_playlist[direction === 'prev' ? l - 1 : 0];
    }

    const bagMissing = this._random_playlist.length / 2 !== l;
    if (
      bagMissing ||
      (direction !== 'prev' && this._random_steps >= this._random_len)
    ) {
      // 没洗过牌 / 歌单变了 / 本轮已播完：换一轮新顺序
      this.startRandomRound(idx);
    }

    if (direction === 'prev') {
      this._random_steps = Math.max(this._random_steps - 1, -1);
    } else {
      this._random_steps += 1;
    }
    const position = (this._random_anchor + this._random_steps + l) % l;

    return this._random_playlist[position];
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cmd /c "node --test --test-isolation=none test/playlist_model.test.js > test_out.txt 2>&1"` → Expected: 全部 pass。
Run: `cmd /c "npm test > test_out.txt 2>&1"` → Expected: `npm test` 的 glob `test/**/*.test.js` 会包含新文件，因此「原有 30 个 + 新增用例」全 pass；若失败先判断是新测试还是新实现的问题。

- [ ] **Step 5: lint + 格式化**

```powershell
cmd /c "node node_modules\prettier\bin-prettier.js --write js\player\playlist_model.js test\playlist_model.test.js test\helpers\player_vm.js > prettier_out.txt 2>&1"
cmd /c "node node_modules\eslint\bin\eslint.js js\player\playlist_model.js test\playlist_model.test.js > lint_out.txt 2>&1"
```

Expected: lint 输出为空；格式化后重跑 Step 4 的测试仍全 pass。

---

### Task 2: MediaSessionController

**Owner:** `session-dev` teammate

**Files:**

- Create: `js/player/media_session.js`
- Test: `test/media_session.test.js`
- 依赖: Task 0（`player_vm.js`）；不依赖其它模块

**Interfaces:**

- Produces:

  - `class MediaSessionController`：`constructor({ onPlay, onPause, onNext, onPrev, onSeek, onSeekForward, onSeekBackward } = {})`（缺省的回调不注册）、`get supported()`、`setTrack(track)`、`clearTrack()`、`setPlaybackState(state)`、`setPosition({ duration, position, rate })`。
  - 行为约定：`setTrack` 是唯一写 `metadata` 的地方（`clearTrack` 置空）；`setPosition` 只在 `duration > 0` 时写且不抛异常；不支持 `mediaSession` 时全部方法为 no-op；每个 action handler 注册都包在 try/catch 里（浏览器可能不支持个别 action）。

- [ ] **Step 1: 写失败测试**

创建 `test/media_session.test.js`：

```js
/**
 * MediaSessionController 单测：action handler 注册、metadata 写入、位置状态守卫。
 * navigator.mediaSession 用 stub 代替，MediaMetadata 用记录构造参数的假类。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert');
const { loadScripts, globalValue } = require('./helpers/player_vm');

function createSessionStub() {
  return {
    metadata: 'untouched',
    playbackState: 'none',
    handlers: {},
    positionStates: [],
    setActionHandler(action, handler) {
      this.handlers[action] = handler;
    },
    setPositionState(state) {
      this.positionStates.push(state);
    },
  };
}

function loadController(mediaSession) {
  const sandbox = {
    navigator: mediaSession ? { mediaSession } : {},
    MediaMetadata: class {
      constructor(init) {
        this.init = init;
      }
    },
  };
  const context = loadScripts(sandbox, ['js/player/media_session.js']);
  return globalValue(context, 'MediaSessionController');
}

describe('MediaSessionController：能力探测与 action handler', () => {
  test('没有 mediaSession 时 supported 为 false 且所有方法不抛异常', () => {
    const Controller = loadController(null);
    const controller = new Controller({ onPlay: () => {} });

    assert.strictEqual(controller.supported, false);
    assert.doesNotThrow(() => {
      controller.setTrack({ id: 'a', title: 'a', artist: 'b' });
      controller.clearTrack();
      controller.setPlaybackState('playing');
      controller.setPosition({ duration: 10, position: 1, rate: 1 });
    });
  });

  test('注册 7 个 action handler，且回调能收到 details', () => {
    const mediaSession = createSessionStub();
    const received = [];
    const Controller = loadController(mediaSession);
    const controller = new Controller({
      onPlay: () => received.push('play'),
      onPause: () => received.push('pause'),
      onNext: () => received.push('next'),
      onPrev: () => received.push('prev'),
      onSeek: (details) => received.push(['seek', details.seekTime]),
      onSeekForward: (details) => received.push(['fwd', details.seekOffset]),
      onSeekBackward: (details) => received.push(['back', details.seekOffset]),
    });

    assert.strictEqual(controller.supported, true);
    assert.deepStrictEqual(Object.keys(mediaSession.handlers).sort(), [
      'nexttrack',
      'pause',
      'play',
      'previoustrack',
      'seekbackward',
      'seekforward',
      'seekto',
    ]);

    mediaSession.handlers.play();
    mediaSession.handlers.pause();
    mediaSession.handlers.nexttrack();
    mediaSession.handlers.previoustrack();
    mediaSession.handlers.seekto({ seekTime: 12 });
    mediaSession.handlers.seekforward({ seekOffset: 15 });
    mediaSession.handlers.seekbackward({ seekOffset: 5 });

    assert.deepStrictEqual(received, [
      'play',
      'pause',
      'next',
      'prev',
      ['seek', 12],
      ['fwd', 15],
      ['back', 5],
    ]);
  });

  test('未提供的回调不注册对应 action', () => {
    const mediaSession = createSessionStub();
    const Controller = loadController(mediaSession);
    new Controller({ onPlay: () => {} }); // eslint-disable-line no-new

    assert.deepStrictEqual(Object.keys(mediaSession.handlers), ['play']);
  });
});

describe('MediaSessionController：媒体信息与状态', () => {
  test('setTrack 写 metadata（含 100 字补白的 album 与封面），clearTrack 置空', () => {
    const mediaSession = createSessionStub();
    const Controller = loadController(mediaSession);
    const controller = new Controller({});

    controller.setTrack({
      id: 'ne1',
      title: '标题',
      artist: '歌手',
      album: '专辑',
      img_url: 'https://x/cover.jpg',
    });

    assert.strictEqual(mediaSession.metadata.init.title, '标题');
    assert.strictEqual(mediaSession.metadata.init.artist, '歌手');
    assert.strictEqual(
      mediaSession.metadata.init.album.startsWith('Listen 1  •  专辑'),
      true
    );
    assert.ok(
      mediaSession.metadata.init.album.length >= 'Listen 1  •  '.length + 100
    );
    assert.deepStrictEqual(mediaSession.metadata.init.artwork, [
      { src: 'https://x/cover.jpg', sizes: '500x500' },
    ]);

    controller.setTrack({ id: 'ne2', title: 't2', artist: 'a2' });
    assert.deepStrictEqual(mediaSession.metadata.init.artwork, []);
    assert.strictEqual(
      mediaSession.metadata.init.album.startsWith('Listen 1  •  <???>'),
      true
    );

    controller.clearTrack();
    assert.strictEqual(mediaSession.metadata, null);
  });

  test('setPlaybackState 透传；setPosition 只在 duration > 0 时写并夹住 position', () => {
    const mediaSession = createSessionStub();
    const Controller = loadController(mediaSession);
    const controller = new Controller({});

    controller.setPlaybackState('playing');
    assert.strictEqual(mediaSession.playbackState, 'playing');

    controller.setPosition({ duration: 0, position: 5, rate: 1 });
    controller.setPosition({ duration: undefined, position: 5, rate: 1 });
    controller.setPosition({ duration: -1, position: 5, rate: 1 });
    assert.strictEqual(mediaSession.positionStates.length, 0);

    controller.setPosition({ duration: 30, position: 999, rate: 2 });
    controller.setPosition({ duration: 30, position: -5, rate: 0 });
    assert.deepStrictEqual(mediaSession.positionStates, [
      { duration: 30, playbackRate: 2, position: 30 },
      { duration: 30, playbackRate: 1, position: 0 },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（`js/player/media_session.js` 不存在）；命令同 Task 1 Step 2，换成该测试文件。

- [ ] **Step 3: 实现 `js/player/media_session.js`**

```js
/* eslint-disable no-underscore-dangle */
/* global MediaMetadata */
// eslint-disable-next-line no-unused-vars
class MediaSessionController {
  constructor(handlers = {}) {
    this._handlers = handlers;
    this._mediaSession =
      typeof navigator !== 'undefined' && 'mediaSession' in navigator
        ? navigator.mediaSession
        : null;
    if (this._mediaSession) {
      this._registerActionHandlers();
    }
  }

  get supported() {
    return this._mediaSession !== null;
  }

  _setActionHandler(action, handler) {
    try {
      this._mediaSession.setActionHandler(action, handler);
    } catch (err) {
      // 个别浏览器不支持某些 action：静默跳过，不影响其它按钮
    }
  }

  _registerActionHandlers() {
    const {
      onPlay,
      onPause,
      onNext,
      onPrev,
      onSeek,
      onSeekForward,
      onSeekBackward,
    } = this._handlers;
    if (onPlay) this._setActionHandler('play', () => onPlay());
    if (onPause) this._setActionHandler('pause', () => onPause());
    if (onNext) this._setActionHandler('nexttrack', () => onNext());
    if (onPrev) this._setActionHandler('previoustrack', () => onPrev());
    if (onSeek) this._setActionHandler('seekto', (details) => onSeek(details));
    if (onSeekForward) {
      this._setActionHandler('seekforward', (details) =>
        onSeekForward(details)
      );
    }
    if (onSeekBackward) {
      this._setActionHandler('seekbackward', (details) =>
        onSeekBackward(details)
      );
    }
  }

  setTrack(track) {
    if (!this._mediaSession || !track) return;
    const artwork = track.img_url
      ? [{ src: track.img_url, sizes: '500x500' }]
      : [];
    const metadata = {
      title: track.title,
      artist: track.artist,
      album: `Listen 1  •  ${(track.album || '<???>').padEnd(100)}`,
      artwork,
    };
    try {
      this._mediaSession.metadata = new MediaMetadata(metadata);
    } catch (err) {
      // 环境没有 MediaMetadata 或参数不合法：保持原 metadata
    }
  }

  clearTrack() {
    if (!this._mediaSession) return;
    try {
      this._mediaSession.metadata = null;
    } catch (err) {
      // 某些实现不允许置空：忽略
    }
  }

  setPlaybackState(state) {
    if (!this._mediaSession) return;
    try {
      this._mediaSession.playbackState = state;
    } catch (err) {
      // playbackState 不可写：忽略
    }
  }

  setPosition({ duration, position, rate } = {}) {
    if (
      !this._mediaSession ||
      typeof this._mediaSession.setPositionState !== 'function'
    ) {
      return;
    }
    // duration 为 0 / 非法时写位置状态会抛 NotSupportedError，直接跳过
    if (typeof duration !== 'number' || !(duration > 0)) return;
    const safePosition = Math.min(
      Math.max(typeof position === 'number' ? position : 0, 0),
      duration
    );
    const playbackRate = typeof rate === 'number' && rate > 0 ? rate : 1;
    try {
      this._mediaSession.setPositionState({
        duration,
        playbackRate,
        position: safePosition,
      });
    } catch (err) {
      // 参数不合法 / 不支持：忽略
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**（该文件 + `npm test`）。

- [ ] **Step 5: lint + 格式化**（命令同上，目标换成 `js/player/media_session.js` 与测试文件）。

---

### Task 3: AudioEngine

**Owner:** `engine-dev` teammate

**Files:**

- Create: `js/player/audio_engine.js`
- Test: `test/audio_engine.test.js`
- 依赖: Task 0；只依赖 `Howl` / `Howler` 全局

**Interfaces:**

- Produces:

  - `class AudioEngine`：`constructor({ onEvent } = {})`、`get currentHowl()`、`get currentTrack()`（当前 Howl 对应的曲目对象）、`load({ url, track, token })` → 返回新建的 Howl、`play()`、`pause()`、`stop()`、`seek(seconds)`、`seekPercent(percent)`、`duration()`、`position()`、`rate()`、`applyAudioState({ volume, muted })`、`unload(howl = this.currentHowl)`（不额外调用 `howl.stop()`；`Howl.unload()` 内部会停）、`unloadOtherThan(keepHowl)` / `unloadAll()`（保留）。
  - 卸载某个 Howl 期间 engine 抑制它的所有事件（`_unloading` 集合）：`Howl.unload()` 内部会 stop 并派发 `onstop`，事件回调若再次触发卸载会自我递归，抑制后 `unload` 幂等、不重入。
  - 事件：`onEvent({ type, token, howl, track, error })`，`type ∈ 'loaded' | 'playing' | 'paused' | 'stopped' | 'ended' | 'error'`；`token` 是 `load()` 时传入的原值（engine 不判断代际，交给 `PlayerCore`）。
  - Howl 选项必须与现状一致：`format: 'mp3'`（绕过 Howl 的扩展名检查，issue #1200）、`volume: 1`、**不要传 `mute`**（会永久静音，详见现有 `js/player_thread.js` 里 `finishLoad` 的注释）、`html5: true`。
  - `applyAudioState` 顺序固定：先 `Howler.mute` 后 `Howler.volume`；再对当前 Howl 补一次 `howl.mute(muted)` / `howl.volume(groupVolume)` 是防 html5 node 被复用时 muted/volume 未复位（Howler 的 OR 语义）。

- [ ] **Step 1: 写失败测试**

创建 `test/audio_engine.test.js`：

```js
/**
 * AudioEngine 单测：Howl 构造参数、事件上报、定向卸载、音量/静音应用。
 * Howler / Howl 用最小 stub，语义覆盖被测代码用到的那部分。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert');
const { loadScripts, globalValue } = require('./helpers/player_vm');

function createHowlerStub() {
  return {
    _howls: [],
    muteCalls: [],
    volumeCalls: [],
    unload() {
      this._howls.slice().forEach((howl) => howl.unload());
    },
    mute(muted) {
      this.muteCalls.push(muted);
    },
    volume(vol) {
      this.volumeCalls.push(vol);
    },
  };
}

function createHowlStubClass(howler) {
  return class Howl {
    constructor(options = {}) {
      this.options = options;
      this.node = { volume: 1, muted: false };
      this.calls = [];
      this._playing = false;
      this._duration = 0;
      this._pos = 0;
      howler._howls.push(this);
    }

    playing() {
      return this._playing;
    }

    play() {
      this.calls.push('play');
      this._playing = true;
      return 1;
    }

    pause() {
      this.calls.push('pause');
      this._playing = false;
    }

    stop() {
      this.calls.push('stop');
      this._playing = false;
    }

    unload() {
      this.calls.push('unload');
      // 复刻 Howler：Howl.unload() 内部先 stop（无条件派发 onstop），再把节点从 _howls 摘除
      if (typeof this.options.onstop === 'function')
        this.options.onstop(this.id);
      const index = howler._howls.indexOf(this);
      if (index >= 0) howler._howls.splice(index, 1);
    }

    volume(vol) {
      if (typeof vol === 'number') {
        this.calls.push(['volume', vol]);
        return this;
      }
      return 1;
    }

    mute(muted) {
      this.calls.push(['mute', muted]);
    }

    duration() {
      return this._duration;
    }

    seek(seconds) {
      if (typeof seconds === 'number') {
        this.calls.push(['seek', seconds]);
        this._pos = seconds;
        return this;
      }
      return this._pos;
    }

    rate() {
      return 1;
    }
  };
}

function loadEngine() {
  const howler = createHowlerStub();
  const Howl = createHowlStubClass(howler);
  const events = [];
  const sandbox = { Howler: howler, Howl, console };
  const context = loadScripts(sandbox, ['js/player/audio_engine.js']);
  const AudioEngine = globalValue(context, 'AudioEngine');
  const engine = new AudioEngine({
    onEvent: (event) => events.push(event),
  });
  return { engine, howler, Howl, events };
}

describe('AudioEngine：Howl 构造与事件', () => {
  test('load 用既有约定建 Howl，并把 token/track 带进事件', () => {
    const { engine, howler, events } = loadEngine();
    const track = { id: 'ne1', title: 't' };

    const howl = engine.load({ url: 'https://x/a.mp3', track, token: 7 });

    assert.strictEqual(engine.currentHowl, howl);
    assert.strictEqual(engine.currentTrack, track);
    assert.strictEqual(howler._howls.length, 1);
    assert.strictEqual(howl.options.src[0], 'https://x/a.mp3');
    assert.strictEqual(howl.options.format, 'mp3');
    assert.strictEqual(howl.options.volume, 1);
    assert.strictEqual(howl.options.html5, true);
    assert.strictEqual('mute' in howl.options, false);

    howl.options.onplay();
    howl.options.onpause();
    howl.options.onstop();
    howl.options.onend();
    howl.options.onload();
    howl.options.onloaderror(1, { code: 4 });

    assert.deepStrictEqual(
      events.map((event) => event.type),
      ['playing', 'paused', 'stopped', 'ended', 'loaded', 'error']
    );
    events.forEach((event) => {
      assert.strictEqual(event.token, 7);
      assert.deepStrictEqual(event.track, track);
    });
    assert.deepStrictEqual(events[events.length - 1].error, { code: 4 });
  });

  test('unload 期间抑制该 Howl 的事件，不会自我递归', () => {
    const { engine, howler, events } = loadEngine();
    const track = { id: 'ne1' };
    const howl = engine.load({ url: 'https://x/a.mp3', track, token: 1 });
    const eventsBefore = events.length;

    engine.unload(howl);

    assert.strictEqual(events.length, eventsBefore, '卸载期间不应派发事件');
    assert.strictEqual(engine.currentHowl, null);
    assert.strictEqual(engine.currentTrack, null);
    assert.strictEqual(howler._howls.length, 0);
  });

  test('play/pause/stop/seek 只作用于当前 Howl，无 Howl 时安全 no-op', () => {
    const { engine } = loadEngine();
    assert.doesNotThrow(() => {
      engine.play();
      engine.pause();
      engine.stop();
      engine.seek(1);
      engine.seekPercent(0.5);
    });

    const howl = engine.load({
      url: 'https://x/a.mp3',
      track: { id: 'a' },
      token: 1,
    });
    howl._duration = 100;
    engine.play();
    engine.pause();
    engine.stop();
    engine.seek(12);
    engine.seekPercent(0.25);

    assert.deepStrictEqual(howl.calls, [
      'play',
      'pause',
      'stop',
      ['seek', 12],
      ['seek', 25],
    ]);
    assert.strictEqual(howl._pos, 25);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `js/player/audio_engine.js`**

```js
/* eslint-disable no-underscore-dangle */
/* global Howl Howler */
// eslint-disable-next-line no-unused-vars
class AudioEngine {
  constructor({ onEvent } = {}) {
    this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this._howl = null;
    this._track = null;
    this._howls = [];
    this._unloading = new Set();
  }

  get currentHowl() {
    return this._howl;
  }

  get currentTrack() {
    return this._track;
  }

  /**
   * 所有 Howl 事件的唯一出口：正在卸载的 Howl 的 stop 事件会被抑制，
   * 避免事件回调（PlayerCore 里可能再次 unload）把 unload 递归回去。
   */
  _emit(event) {
    if (event.howl && this._unloading.has(event.howl)) return;
    this._onEvent(event);
  }

  /**
   * 为一次 load session 新建 Howl。事件里的 token 由调用方传入，
   * 采纳与否由 PlayerCore 按代际判断。
   */
  load({ url, track, token }) {
    const self = this;
    const howl = new Howl({
      src: [url],
      format: 'mp3', // bypass Howl checking url extension, issue #1200
      volume: 1,
      // 这里**不要**传 mute：Howler 会把该选项存成"这个音源自己的 _muted"，而全局
      // mute(false) 只把 node.muted 恢复成 sound._muted、永不重写 node.volume，于是
      // 全局静音期间新建的音源会被永久静音（只有重建 Howl 才恢复）。全局静音由
      // applyAudioState() 经 Howler.mute() 统一施加。
      html5: true, // Force to HTML5 so that the audio can stream in (best for large files).
      onplay() {
        self._emit({ type: 'playing', token, track, howl });
      },
      onload() {
        self._emit({ type: 'loaded', token, track, howl });
      },
      onpause() {
        self._emit({ type: 'paused', token, track, howl });
      },
      onstop() {
        self._emit({ type: 'stopped', token, track, howl });
      },
      onend() {
        self._emit({ type: 'ended', token, track, howl });
      },
      onloaderror(id, error) {
        self._emit({ type: 'error', token, track, howl, error });
      },
      onplayerror(id, error) {
        self._emit({ type: 'error', token, track, howl, error });
      },
    });
    this._howls.push(howl);
    this._howl = howl;
    this._track = track;
    return howl;
  }

  play() {
    if (this._howl) this._howl.play();
  }

  pause() {
    if (this._howl) this._howl.pause();
  }

  stop() {
    if (this._howl) this._howl.stop();
  }

  seek(seconds) {
    if (this._howl) this._howl.seek(seconds);
  }

  seekPercent(percent) {
    if (!this._howl) return;
    const duration = this._howl.duration();
    if (!(duration > 0)) return;
    this._howl.seek(duration * percent);
  }

  duration() {
    return this._howl ? this._howl.duration() : 0;
  }

  position() {
    return this._howl ? this._howl.seek() : 0;
  }

  rate() {
    return this._howl ? this._howl.rate() : 1;
  }

  /**
   * 唯一写 Howler 音量/静音的地方。顺序不能反：Howler.volume() 在全局 _muted 为真时
   * 直接 return、不更新任何节点，而全局 _muted 只在 Howler.mute() 里被改写。
   * 再对当前 Howl 补一次 mute/volume：html5 node 会被 Howler 复用，复用时 muted/volume
   * 没有复位（Howler 的 OR 语义），所以每次开播都要把权威状态再写一遍。
   */
  applyAudioState({ volume, muted }) {
    Howler.mute(muted);
    Howler.volume(volume);
    const { currentHowl } = this;
    if (currentHowl) {
      const groupVolume = currentHowl.volume(); // 应用里恒为 1（new Howl({ volume: 1 })）
      currentHowl.mute(muted);
      currentHowl.volume(groupVolume);
    }
  }

  unload(howl = this._howl) {
    if (!howl) return;
    const index = this._howls.indexOf(howl);
    if (index < 0) return;
    this._howls.splice(index, 1);
    if (this._howl === howl) {
      this._howl = null;
      this._track = null;
    }
    // Howl.unload() 内部会 stop 并派发 onstop：这段期间抑制该 Howl 的事件，防止事件回调再次触发卸载而递归
    this._unloading.add(howl);
    try {
      howl.unload();
    } finally {
      this._unloading.delete(howl);
    }
  }

  /** 定向卸载：保留指定 Howl，其余全部卸载（不调 Howler.unload()）。 */
  unloadOtherThan(keepHowl) {
    this._howls.slice().forEach((howl) => {
      if (howl !== keepHowl) this.unload(howl);
    });
    this._howl = keepHowl || null;
    if (!keepHowl) this._track = null;
  }

  unloadAll() {
    this._howls.slice().forEach((howl) => this.unload(howl));
    this._howl = null;
    this._track = null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**（含 `npm test` 全绿）。

- [ ] **Step 5: lint + 格式化**（目标换成 `js/player/audio_engine.js` 与测试文件）。

---

### Task 4: player_host

**Owner:** `session-dev` teammate（与 Task 2 同人，文件互不重叠）

**Files:**

- Create: `js/player/player_host.js`
- Test: `test/player_host.test.js`
- 依赖: Task 0；运行期依赖 `bridge.js` 的 `playerSendMessage` 与 `loweb.js` 的 `MediaService`

**Interfaces:**

- Produces: 全局函数 `createPlayerHost({ mode = 'background' } = {})` → `{ mode（可写）, send(type, data?), resolveUrl(track, callback) }`。

  - `send(type, data)`：`data === undefined` 时发 `{ type }`，否则 `{ type, data }`；内部调用 `playerSendMessage(host.mode, message)`（若该全局不存在则丢弃）。
  - `resolveUrl(track, callback)`：`callback({ url, bitrate, platform } | null)`。
    - `MediaService.bootstrapTrack` 存在时**直连**（front / Electron / 加载了服务层的后台页），传给它的曲目已去掉 `howl`；
    - 否则（后台页没有服务层脚本，Firefox MV2）立即 `callback(null)` 判失败：全仓没有 `BG_PLAYER:RETRIEVE_URL` 的消费者，走消息回传只会变成每次播放等超时再逐首跳。
  - 回调只可能被调用一次（成功/失败分支各一次，不注册消息监听、不引入超时挂起）。

- [ ] **Step 1: 写失败测试**

创建 `test/player_host.test.js`：

```js
/**
 * createPlayerHost 单测：MediaService 直连分支（front/Electron）与
 * 无 MediaService 时立即判失败的分支（Firefox MV2 后台页没有服务层脚本）。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert');
const { loadScripts, globalValue } = require('./helpers/player_vm');

function loadHostClass(sandbox) {
  const context = loadScripts(sandbox, ['js/player/player_host.js']);
  return globalValue(context, 'createPlayerHost');
}

function baseSandbox(extra = {}) {
  const sent = [];
  return {
    sandbox: {
      playerSendMessage: (mode, message) => sent.push({ mode, message }),
      ...extra,
    },
    sent,
  };
}

describe('createPlayerHost：MediaService 直连', () => {
  test('成功/失败各只回调一次，传给 MediaService 的 track 已去掉 howl', () => {
    const calls = [];
    const { sandbox, sent } = baseSandbox({
      MediaService: {
        bootstrapTrack(track, success, failure) {
          calls.push(track);
          if (track.id === 'ok') {
            success({
              url: 'https://x/ok.mp3',
              bitrate: 128,
              platform: 'test',
            });
          } else {
            failure({});
          }
        },
      },
    });
    const createPlayerHost = loadHostClass(sandbox);
    const host = createPlayerHost({ mode: 'front' });

    let resolved = 'unset';
    host.resolveUrl({ id: 'ok', title: 't', howl: { fake: true } }, (info) => {
      resolved = info;
    });
    assert.deepStrictEqual(resolved, {
      url: 'https://x/ok.mp3',
      bitrate: 128,
      platform: 'test',
    });
    assert.strictEqual(calls[0].howl, undefined);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(sent.length, 0);

    let failed = 'unset';
    host.resolveUrl({ id: 'bad' }, (info) => {
      failed = info;
    });
    assert.strictEqual(failed, null);
    assert.strictEqual(calls.length, 2);
  });

  test('send 封装 {type} / {type,data} 形状，mode 可改写后发给新通道', () => {
    const { sandbox, sent } = baseSandbox({
      MediaService: { bootstrapTrack() {} },
    });
    const createPlayerHost = loadHostClass(sandbox);
    const host = createPlayerHost({ mode: 'front' });

    host.send('BG_PLAYER:READY');
    host.send('BG_PLAYER:FRAME_UPDATE', { pos: 1 });
    host.mode = 'background';
    host.send('BG_PLAYER:PLAY_STATE', { isPlaying: true });

    assert.deepStrictEqual(sent, [
      { mode: 'front', message: { type: 'BG_PLAYER:READY' } },
      {
        mode: 'front',
        message: { type: 'BG_PLAYER:FRAME_UPDATE', data: { pos: 1 } },
      },
      {
        mode: 'background',
        message: { type: 'BG_PLAYER:PLAY_STATE', data: { isPlaying: true } },
      },
    ]);
  });
});

describe('createPlayerHost：没有 MediaService', () => {
  test('同步 callback(null)，不抛异常、不发消息', () => {
    const { sandbox, sent } = baseSandbox();
    const createPlayerHost = loadHostClass(sandbox);
    const host = createPlayerHost({ mode: 'background' });

    const results = [];
    assert.doesNotThrow(() => {
      host.resolveUrl({ id: 'a', howl: { fake: true } }, (info) => {
        results.push(info);
      });
    });
    assert.deepStrictEqual(results, [null]);
    assert.strictEqual(sent.length, 0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `js/player/player_host.js`**

```js
/* global playerSendMessage MediaService */

function pruneTrack(track) {
  return { ...track, howl: undefined };
}

// eslint-disable-next-line no-unused-vars
function createPlayerHost({ mode = 'background' } = {}) {
  const host = {
    mode,
    send(type, data) {
      const message = data === undefined ? { type } : { type, data };
      if (typeof playerSendMessage === 'function') {
        playerSendMessage(host.mode, message);
      }
    },
    resolveUrl(track, callback) {
      if (
        typeof MediaService !== 'undefined' &&
        MediaService &&
        typeof MediaService.bootstrapTrack === 'function'
      ) {
        MediaService.bootstrapTrack(
          pruneTrack(track),
          (bootinfo) => callback(bootinfo || null),
          () => callback(null)
        );
        return;
      }
      // 后台页没有服务层脚本（Firefox MV2）：没有地址可解析，立即判失败。
      // 全仓没有 BG_PLAYER:RETRIEVE_URL 的消费者，走消息回传只会变成每次播放等超时再逐首跳。
      callback(null);
    },
  };
  return host;
}
```

- [ ] **Step 4: 跑测试确认通过**（含 `npm test` 全绿）。

- [ ] **Step 5: lint + 格式化**（目标换成 `js/player/player_host.js` 与测试文件）。

---

### Task 5: PlayerCore + 生命周期测试 harness

**Owner:** Lead

**Files:**

- Create: `js/player/player_core.js`
- Create: `test/helpers/player_lifecycle_harness.js`
- Test: `test/player_lifecycle.test.js`
- 依赖: Task 1（PlaylistModel）、Task 2（MediaSessionController）、Task 3（AudioEngine）、Task 4（player_host 的接口约定；测试里用 fake host）

**Interfaces:**

- Consumes: 上述四个模块的全局类/函数（按 Task 1-4 的签名）。
- Produces: `class PlayerCore`，对外方法与属性与现有 `Player` 同名同义（`js/l1_player.js` 直接使用）：`playlist`、`index`、`currentAudio`、`currentHowl`、`playing`、`loop_mode`、`muted`、`volume`、`playlistModel`、`getAudioState()`、`setMode()`、`setRefreshRate()`、`play()`、`pause()`、`playById()`、`load()`、`loadById()`、`skip()`、`seek()`、`seekTime()`、`seekBy()`、`insertAudio()`、`insertAudioByDirection()`、`removeAudio()`、`appendAudioList()`、`clearPlaylist()`、`setNewPlaylist()`、`stopAll()`、`setVolume()`、`adjustVolume()`、`setMuted()`、`toggleMuted()`、`applyAudioState()`、`setMediaURI()`、`setAudioDisabled()`、`sendFrameUpdate()`、`sendPlayingEvent()`、`sendLoadEvent()`、`sendAudioStateEvent()`、`sendPlaylistEvent()`。
- 构造签名：`new PlayerCore({ host, engine, mediaSession, playlistModel } = {})`——四个依赖都可注入（`engine` / `mediaSession` / `playlistModel` 缺省时用真实实现），供测试替换。

**关键时序（必须逐条实现）**：

1. `_beginSession(index, playNow)`：`generation += 1` 拿 token → session 记 `{ token, index, trackId, playNow, pending }` → 更新 `playlistModel.index` → `mediaSession.setTrack(新曲目)`（metadata 立即换）+ `setPlaybackState('paused')` → `engine.pause()`（旧音频只暂停）→ `sendPlayingEvent('Paused')`（旧 `pause`/`stop` 事件会因代际过期被丢弃，UI 的 `isPlaying` 必须由这里补发）→ `sendLoadEvent()`。
2. `_startSession(index, playNow)`：命中 `_media_uri_list[track.id]` 缓存 → `_finishLoad(token, { url, bitrate: track.bitrate, platform: track.platform }, track)`；否则 `host.resolveUrl(track, cb)`，回调一律带着 `track` 对象。
3. `_handleUrlResult(token, track, bootinfo)`：token 过期 → 只缓存 URL（若有），其它什么都不做；失败 → `_handleUrlFailure(token, track)`；成功 → `_finishLoad(token, bootinfo, track)`。
4. `_finishLoad(token, bootinfo, track)`：按 `session.trackId` 用 `findIndexById` 重新定位下标；定位不到（等待期间曲目被删）→ `generation += 1`、清 session、直接返回；`track.bitrate` / `track.platform` 只在 `bootinfo` 里不是 `undefined` 时赋值（缓存重放不能把它们抹掉）；`setMediaURI`、`setAudioDisabled(false, index)`、`engine.load({ url, track, token })`、`track.howl = howl`、广播 `RETRIEVE_URL_SUCCESS`、`session.pending = false`，最后 `session.playNow` 为真才 `engine.play()`。
5. `_handleAudioEvent({ type, token, howl, track, error })`：token 非当前代 → 只清理（若 howl 不是 `engine.currentHowl` 就 `engine.unload(howl)`），其余全部丢弃；当前代 `playing` → `applyAudioState()`、`track.disabled = false`、`playedFrom = Math.round(Date.now()/1000)`、`setPlaybackState('playing')`、`_unloadOthers(howl)`、`sendPlayingEvent('Playing')`。
6. `_advanceAfterFailure()`：`_advancing` 标志 + `_skipPending` 循环，防止同步失败回调造成深度递归；最终没有任何可播曲目时发 `RETRIEVE_URL_FAIL_ALL`。
7. `_unloadOthers(keepHowl)`：`engine.unloadOtherThan(keepHowl)`，并把其它曲目的 `track.howl` 清成 `null`。
8. `skip(direction)`：空列表 → `engine.pause()` + 发 `RETRIEVE_URL_FAIL_ALL` + `sendLoadEvent()`；否则反复 `model.index = model.nextIndex(direction)` 跳过 `disabled` 曲目（每次推进都重新算，随机模式语义依赖这一步），全部 disabled → `engine.pause()` + `RETRIEVE_URL_FAIL_ALL` + `sendLoadEvent()`；可播 → `_startSession(model.index, true)`。
9. `pause()`：pending session 的 `playNow = false`；有当前 Howl 就 `engine.pause()`；没有时只把 `mediaSession` 状态置 `paused`。
10. `play(idx)`：已有「当前 Howl 且地址有缓存」的同一曲目 → 直接 `engine.play()`；否则 `_startSession(index, true)`。
11. `load(idx)` / `loadById(id)`：只选曲不取地址——`generation += 1`、清 `_session`、更新下标、`setTrack` + `setPlaybackState('paused')`、`engine.pause()`、`sendPlayingEvent('Stopped')`（旧实现靠 unload 的 stop 事件通知 UI）、`sendLoadEvent()`。
12. `clearPlaylist()`：`generation += 1`、清 `_session`、`stopAll()` + `engine.unloadAll()`、`playlistModel.setList([])`、`mediaSession.clearTrack()` + `setPlaybackState('none')`、`sendPlayingEvent('Stopped')`、发 `PLAYLIST` + `LOAD`。
13. `setNewPlaylist(list)`：空列表只发 `PLAYLIST`；否则 `generation += 1`、清 `_session`、`stopAll()` + `engine.unloadAll()`、替换列表（随机模式选随机首曲）、`setTrack` + `setPlaybackState('paused')` + `sendPlayingEvent('Stopped')`、发 `LOAD` + `PLAYLIST`（**不取地址、不播放**）。
14. `removeAudio(idx)`：动列表前，若 `this._session` 的目标正是被删曲目（`model.tracks[idx].id === session.trackId`）→ `generation += 1`、清 `_session`（作废 pending，否则 URL 回来会串歌）；删的是当前曲目 → `engine.pause()` + `engine.unload()` 并清 `howl`；原本在播 → `play()` 重开 session；最后发 `PLAYLIST` + `LOAD`。删除其它曲目时靠 `trackId` 重新定位即可，不必作废会话。
15. `currentHowl` / 帧上报：`currentHowl` getter = `engine.currentHowl`，但若 `engine.currentTrack !== currentAudio` 则返回 `null`（取地址窗口里旧 Howl 不算当前曲目，`seek*`/`sendFrameUpdate` 不会误操作上一首）；`sendFrameUpdate()` 里 `duration > 0` 才调 `mediaSession.setPosition({ duration, position, rate })`（controller 里保留双保险），并照旧广播 `FRAME_UPDATE`；`setRefreshRate()` 定时器只在 `playing` 时发。

- [ ] **Step 1: 写生命周期 harness**

创建 `test/helpers/player_lifecycle_harness.js`：

```js
/**
 * PlayerCore 生命周期测试 harness：
 * - PlaylistModel / MediaSessionController 用真实实现；
 * - AudioEngine 用真实实现，Howl 换成可手动触发事件的 stub；
 * - host / mediaSession 用记录调用的 fake，URL 回调排队由测试手动 resolve。
 */
const { loadScripts, globalValue } = require('./player_vm');

function createHowlerStub() {
  return {
    _howls: [],
    muted: false,
    volumeValue: 1,
    unmuteCalls: 0,
    unload() {
      this._howls.slice().forEach((howl) => howl.unload());
    },
    mute(muted) {
      this.muted = !!muted;
      this.unmuteCalls += 1;
    },
    volume(vol) {
      this.volumeValue = vol;
      return vol;
    },
  };
}

function createHowlStubClass(howler) {
  return class Howl {
    constructor(options = {}) {
      this.options = options;
      this.node = { volume: 1, muted: false };
      this._playing = false;
      this._duration = 100;
      this._pos = 0;
      this.unloaded = false;
      howler._howls.push(this);
    }

    playing() {
      return this._playing;
    }

    play() {
      this._playing = true;
      if (typeof this.options.onplay === 'function')
        this.options.onplay(this.id);
      return 1;
    }

    pause() {
      const wasPlaying = this._playing;
      this._playing = false;
      if (wasPlaying && typeof this.options.onpause === 'function') {
        this.options.onpause(this.id);
      }
    }

    stop() {
      this._playing = false;
      // 复刻 Howler：stop() 无条件派发 onstop
      if (typeof this.options.onstop === 'function')
        this.options.onstop(this.id);
    }

    unload() {
      this.unloaded = true;
      this._playing = false;
      // 复刻 Howler：Howl.unload() 内部先 stop，所以也会无条件派发 onstop
      if (typeof this.options.onstop === 'function')
        this.options.onstop(this.id);
      const index = howler._howls.indexOf(this);
      if (index >= 0) howler._howls.splice(index, 1);
    }

    volume(vol) {
      if (typeof vol === 'number') {
        this.node.volume = vol;
        return this;
      }
      return this.node.volume;
    }

    mute(muted) {
      this.node.muted = !!muted;
    }

    duration() {
      return this._duration;
    }

    seek(seconds) {
      if (typeof seconds === 'number') {
        this._pos = seconds;
        return this;
      }
      return this._pos;
    }

    rate() {
      return 1;
    }
  };
}

function createFakeHost() {
  const sent = [];
  const requests = [];
  return {
    sent,
    requests,
    mode: 'front',
    send(type, data) {
      sent.push(data === undefined ? { type } : { type, data });
    },
    resolveUrl(track, callback) {
      requests.push({ track, callback });
    },
  };
}

function createFakeMediaSession() {
  const calls = [];
  return {
    calls,
    supported: true,
    setTrack(track) {
      calls.push({ type: 'setTrack', id: track && track.id });
    },
    clearTrack() {
      calls.push({ type: 'clearTrack' });
    },
    setPlaybackState(state) {
      calls.push({ type: 'playbackState', state });
    },
    setPosition(position) {
      calls.push({ type: 'position', position });
    },
  };
}

const makeTracks = (count, prefix = 't') =>
  Array.from({ length: count }, (_v, i) => ({
    id: `${prefix}${i}`,
    title: `${prefix}${i}`,
    artist: 'artist',
    album: 'album',
    source: 'test',
  }));

function createLifecycleHarness() {
  const howler = createHowlerStub();
  const Howl = createHowlStubClass(howler);
  const sandbox = {
    Howler: howler,
    Howl,
    MediaMetadata: class {},
    navigator: {},
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  };
  const context = loadScripts(sandbox, [
    'js/player/playlist_model.js',
    'js/player/media_session.js',
    'js/player/audio_engine.js',
    'js/player/player_core.js',
  ]);
  const PlayerCore = globalValue(context, 'PlayerCore');

  const createPlayer = (tracks = makeTracks(3), options = {}) => {
    // 隔离用例：不继承上一个用例留下的 Howl 列表，否则 _howls[0] / length 断言会错位
    howler._howls.length = 0;
    const { index = 0, loopMode = 0 } = options;
    const host = createFakeHost();
    const mediaSession = createFakeMediaSession();
    const player = new PlayerCore({ host, mediaSession });
    player.mode = 'front';
    player.playlistModel.setList(
      tracks.map((track) => ({ ...track, disabled: false, howl: null })),
      { index }
    );
    player.loop_mode = loopMode;
    return { player, host, mediaSession, howler };
  };

  return { createPlayer, makeTracks, PlayerCore };
}

module.exports = { createLifecycleHarness, makeTracks };
```

- [ ] **Step 2: 写失败的生命周期测试**

创建 `test/player_lifecycle.test.js`：

```js
/**
 * PlayerCore 的切歌 / 取地址 / 媒体会话生命周期测试。
 * 覆盖 spec §8 的 8 个场景 + URL 缓存复用。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  createLifecycleHarness,
  makeTracks,
} = require('./helpers/player_lifecycle_harness');

const harness = createLifecycleHarness();

function resolveUrl(host, requestIndex, payload) {
  host.requests[requestIndex].callback(payload);
}

describe('PlayerCore：切歌瞬间（场景 1、2）', () => {
  test('旧音频只暂停不卸载，metadata 立即换成新曲、playbackState 先是 paused', () => {
    const { player, host, mediaSession, howler } = harness.createPlayer(
      makeTracks(3)
    );

    player.play();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });
    const oldHowl = howler._howls[0];
    assert.strictEqual(oldHowl.playing(), true);

    player.skip('next');

    assert.strictEqual(player.index, 1);
    assert.strictEqual(oldHowl.playing(), false, '旧音频应被暂停');
    assert.strictEqual(oldHowl.unloaded, false, '切歌瞬间不应卸载旧 Howl');
    assert.ok(
      mediaSession.calls.some(
        (call) => call.type === 'setTrack' && call.id === 't1'
      ),
      'metadata 应立即切到新曲'
    );
    assert.ok(
      mediaSession.calls.some(
        (call) => call.type === 'playbackState' && call.state === 'paused'
      )
    );
  });

  test('新曲开播后定向卸载旧 Howl，不留全局 unload', () => {
    const { player, host, howler } = harness.createPlayer(makeTracks(3));

    player.play();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });
    const oldHowl = howler._howls[0];

    player.skip('next');
    resolveUrl(host, 1, { url: 'test://t1.mp3' });

    assert.strictEqual(howler._howls.length, 1);
    assert.strictEqual(howler._howls[0].options.src[0], 'test://t1.mp3');
    assert.strictEqual(oldHowl.unloaded, true);
  });

  test('切歌与清空会补发 isPlaying=false 的 PLAY_STATE', () => {
    const { player, host } = harness.createPlayer(makeTracks(3));

    player.play();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });
    player.skip('next');

    assert.ok(
      host.sent.some(
        (msg) =>
          msg.type === 'BG_PLAYER:PLAY_STATE' && msg.data.isPlaying === false
      )
    );

    player.clearPlaylist();

    assert.ok(
      host.sent.some(
        (msg) =>
          msg.type === 'BG_PLAYER:PLAY_STATE' &&
          msg.data.isPlaying === false &&
          msg.data.reason === 'Stopped'
      )
    );
  });
});

describe('PlayerCore：URL 生产/消费竞态（场景 3、4）', () => {
  test('乱序返回时只播最后一代，过期 URL 只进缓存', () => {
    const { player, host, howler } = harness.createPlayer(makeTracks(3));

    player.play();
    player.skip('next');
    assert.strictEqual(host.requests.length, 2);

    resolveUrl(host, 1, { url: 'test://t1.mp3' });
    assert.strictEqual(howler._howls.length, 1);
    assert.strictEqual(howler._howls[0].options.src[0], 'test://t1.mp3');
    assert.strictEqual(player.index, 1);

    resolveUrl(host, 0, { url: 'test://t0.mp3' });

    assert.strictEqual(howler._howls.length, 1, '过期 URL 不应再建 Howl');
    assert.strictEqual(player.index, 1);
    assert.strictEqual(player.playlistModel.tracks[0].howl, null);
  });

  test('过期请求失败不触发跳歌', () => {
    const { player, host } = harness.createPlayer(makeTracks(3));

    player.play();
    player.skip('next');
    resolveUrl(host, 1, { url: 'test://t1.mp3' });
    const requestsBefore = host.requests.length;
    const sentBefore = host.sent.length;

    resolveUrl(host, 0, null);

    assert.strictEqual(player.index, 1);
    assert.strictEqual(host.requests.length, requestsBefore);
    assert.strictEqual(
      host.sent.length,
      sentBefore,
      '过期失败不应广播任何消息'
    );
  });

  test('取地址期间列表插入不影响加载目标', () => {
    const { player, host, howler } = harness.createPlayer(makeTracks(3), {
      index: 1,
    });

    player.play();
    player.insertAudio({ id: 'x' }, 0);
    resolveUrl(host, 0, { url: 'test://t1.mp3' });

    assert.strictEqual(player.playlistModel.current.id, 't1');
    assert.strictEqual(howler._howls[0].options.src[0], 'test://t1.mp3');
    const success = host.sent.filter(
      (msg) => msg.type === 'BG_PLAYER:RETRIEVE_URL_SUCCESS'
    );
    assert.strictEqual(success[success.length - 1].data.id, 't1');
  });
});

describe('PlayerCore：过期 Howl 事件（场景 5）', () => {
  test('旧 Howl 的 paused / ended / error 事件不影响当前状态、不额外跳歌', () => {
    const { player, host, howler } = harness.createPlayer(makeTracks(3));

    player.play();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });
    const oldHowl = howler._howls[0];

    player.skip('next');
    resolveUrl(host, 1, { url: 'test://t1.mp3' });
    const sentBefore = host.sent.length;

    oldHowl.options.onpause();
    oldHowl.options.onend();
    oldHowl.options.onloaderror(0, { code: 4 });
    oldHowl.options.onplayerror(0, { code: 4 });

    assert.strictEqual(player.index, 1);
    assert.strictEqual(host.sent.length, sentBefore);
    assert.strictEqual(howler._howls.length, 1);
  });
});

describe('PlayerCore：等待取地址期间暂停（场景 6）', () => {
  test('pause 后 URL 返回只加载不自动播放', () => {
    const { player, host, howler } = harness.createPlayer(makeTracks(3));

    player.play();
    player.pause();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });

    assert.strictEqual(howler._howls.length, 1);
    assert.strictEqual(howler._howls[0].playing(), false);
  });
});

describe('PlayerCore：位置状态守卫（场景 7）', () => {
  test('duration = 0 时不写 setPosition，duration > 0 时写入', () => {
    const { player, host, mediaSession, howler } = harness.createPlayer(
      makeTracks(3)
    );

    player.play();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });
    howler._howls[0]._duration = 0;
    player.sendFrameUpdate();
    assert.strictEqual(
      mediaSession.calls.filter((call) => call.type === 'position').length,
      0
    );

    howler._howls[0]._duration = 180;
    howler._howls[0]._pos = 12;
    player.sendFrameUpdate();
    const positions = mediaSession.calls.filter(
      (call) => call.type === 'position'
    );
    assert.strictEqual(positions.length, 1);
    assert.strictEqual(positions[0].position.duration, 180);
    assert.strictEqual(positions[0].position.position, 12);
  });
});

describe('PlayerCore：清空与替换播放列表（场景 8、缓存复用）', () => {
  test('连续切歌与清空播放列表不会因 stop 事件递归', () => {
    const { player, host, howler } = harness.createPlayer(makeTracks(3));

    assert.doesNotThrow(() => {
      player.play();
      resolveUrl(host, 0, { url: 'test://t0.mp3' });
      for (let i = 0; i < 3; i += 1) {
        const before = host.requests.length;
        player.skip('next');
        if (host.requests.length > before) {
          host.requests[host.requests.length - 1].callback({
            url: `test://${player.playlistModel.current.id}.mp3`,
          });
        }
      }
      player.clearPlaylist();
    });
    assert.strictEqual(howler._howls.length, 0);
  });

  test('clearPlaylist 作废 pending 请求、清 metadata、playbackState = none', () => {
    const { player, host, mediaSession, howler } = harness.createPlayer(
      makeTracks(3)
    );

    player.play();
    player.clearPlaylist();

    assert.strictEqual(player.playlistModel.length, 0);
    assert.strictEqual(player.playlistModel.index, -1);
    assert.ok(
      mediaSession.calls.some(
        (call) => call.type === 'playbackState' && call.state === 'none'
      )
    );
    assert.ok(mediaSession.calls.some((call) => call.type === 'clearTrack'));

    resolveUrl(host, 0, { url: 'test://t0.mp3' });
    assert.strictEqual(howler._howls.length, 0, '过期的 URL 不应再建 Howl');
  });

  test('切回已缓存地址的曲目不再重复取地址', () => {
    const { player, host, howler } = harness.createPlayer(makeTracks(3));

    player.play();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });
    player.skip('next');
    resolveUrl(host, 1, { url: 'test://t1.mp3' });

    player.skip('prev');

    assert.strictEqual(host.requests.length, 2, '缓存命中不应新增取地址请求');
    // 缓存命中仍然新建 Howl（新会话）；上一首 Howl 在新曲开播后被定向卸载，只剩当前这一个
    assert.strictEqual(howler._howls.length, 1);
    assert.strictEqual(howler._howls[0].options.src[0], 'test://t0.mp3');
    assert.strictEqual(howler._howls[0].playing(), true);
  });

  test('缓存重放保留 bitrate/platform', () => {
    const { player, host } = harness.createPlayer(makeTracks(3));

    player.play();
    resolveUrl(host, 0, {
      url: 'test://t0.mp3',
      bitrate: 128,
      platform: 'kuwo',
    });
    player.skip('next');
    player.skip('prev');

    assert.strictEqual(player.playlistModel.tracks[0].bitrate, 128);
    assert.strictEqual(player.playlistModel.tracks[0].platform, 'kuwo');
  });

  test('取地址期间删除目标曲目：URL 回来被丢弃', () => {
    const { player, host, howler } = harness.createPlayer(makeTracks(3));

    player.playById('t1');
    player.removeAudio(1);
    resolveUrl(host, 0, { url: 'test://t1.mp3' });

    assert.strictEqual(howler._howls.length, 0, '作废的 URL 不应再建 Howl');
    assert.strictEqual(player.playing, false);
  });

  test('setNewPlaylist 只选中首曲、不取地址不播放', () => {
    const { player, host } = harness.createPlayer(makeTracks(3));

    player.setNewPlaylist(makeTracks(2, 'n'));

    assert.strictEqual(player.playlistModel.length, 2);
    assert.strictEqual(player.index, 0);
    assert.strictEqual(host.requests.length, 0);
    assert.strictEqual(player.playing, false);
  });

  test('URL 失败会标记 disabled 并跳到下一首；全部不可播发 FAIL_ALL', () => {
    const { player, host } = harness.createPlayer(makeTracks(2));

    player.play();
    resolveUrl(host, 0, null);
    assert.strictEqual(player.playlistModel.tracks[0].disabled, true);
    resolveUrl(host, 1, null);

    assert.ok(
      host.sent.some((msg) => msg.type === 'BG_PLAYER:RETRIEVE_URL_FAIL_ALL')
    );
  });

  test('loop_mode = 1 时 ended 重播当前曲目（不新增取地址）', () => {
    const { player, host, howler } = harness.createPlayer(makeTracks(3), {
      loopMode: 1,
    });

    player.play();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });
    const requestsBefore = host.requests.length;

    howler._howls[0].options.onend();

    assert.strictEqual(host.requests.length, requestsBefore);
    assert.strictEqual(player.index, 0);
    assert.strictEqual(howler._howls[0].playing(), true);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**（`js/player/player_core.js` 不存在）。

- [ ] **Step 4: 实现 `js/player/player_core.js`**

```js
/* eslint-disable no-underscore-dangle */
/* global AudioEngine MediaSessionController PlaylistModel */

/**
 * 播放器编排层：播放列表、随机走位、取地址会话（代际 token）、
 * 音频引擎事件与媒体会话。对外接口与旧 Player 同名同义。
 */
// eslint-disable-next-line no-unused-vars
class PlayerCore {
  constructor({ host, engine, mediaSession, playlistModel } = {}) {
    this._host = host;
    this._generation = 0;
    this._session = null;
    this._media_uri_list = {};
    this._loop_mode = 0;
    this._volume = 1;
    this._muted = false;
    this._advancing = false;
    this._skipPending = false;
    this.playedFrom = 0;
    this.mode = 'background';
    this.skipTime = 15;
    this.refreshTimer = null;

    this.playlistModel = playlistModel || new PlaylistModel();
    this._engine =
      engine ||
      new AudioEngine({
        onEvent: (event) => this._handleAudioEvent(event),
      });
    this._mediaSession =
      mediaSession ||
      new MediaSessionController({
        onPlay: () => this.play(),
        onPause: () => this.pause(),
        onNext: () => {
          this.skip('next');
          this.sendFrameUpdate();
        },
        onPrev: () => {
          this.skip('prev');
          this.sendFrameUpdate();
        },
        onSeek: (details) => {
          this.seekTime(details.seekTime);
          this.sendFrameUpdate();
        },
        onSeekForward: (details) => {
          this.seekBy(details.seekOffset || this.skipTime);
          this.sendFrameUpdate();
        },
        onSeekBackward: (details) => {
          this.seekBy(-(details.seekOffset || this.skipTime));
          this.sendFrameUpdate();
        },
      });
  }

  // ---- 数据与查询 ----

  get playlist() {
    return this.playlistModel.tracks;
  }

  get index() {
    return this.playlistModel.index;
  }

  set index(value) {
    this.playlistModel.index = value;
  }

  get currentAudio() {
    return this.playlistModel.current;
  }

  get currentHowl() {
    const howl = this._engine.currentHowl;
    // 取地址窗口里 engine 的当前 Howl 还是上一首：只有它对应的曲目就是当前曲目才算当前，
    // 否则 seek* / sendFrameUpdate 会误操作上一首
    if (!howl || this._engine.currentTrack !== this.currentAudio) return null;
    return howl;
  }

  get playing() {
    const { currentHowl } = this;
    return currentHowl ? currentHowl.playing() : false;
  }

  get muted() {
    return this._muted;
  }

  get volume() {
    return this._volume;
  }

  get loop_mode() {
    return this._loop_mode;
  }

  set loop_mode(input) {
    const LOOP_MODE = {
      all: 0,
      one: 1,
      shuffle: 2,
    };
    let myMode = 0;
    if (typeof input === 'string') {
      myMode = LOOP_MODE[input];
    } else {
      myMode = input;
    }
    if (!Object.values(LOOP_MODE).includes(myMode)) return;
    if (myMode === this._loop_mode) return;
    this._loop_mode = myMode;
    // 同步给列表模型：随机走位要用；换模式本身会作废旧洗牌顺序
    this.playlistModel.loopMode = myMode;
  }

  getAudioState() {
    return {
      volume: Math.round(this._volume * 100),
      muted: this._muted,
    };
  }

  // ---- 运行时 ----

  setMode(newMode) {
    if (this.mode === newMode) return;
    this.mode = newMode;
    if (this._host) {
      this._host.mode = newMode;
      // READY 在模式确定后才发得出去（旧实现用顶层 this.mode，永远发不出）
      this._host.send('BG_PLAYER:READY');
    }
  }

  setRefreshRate(rate = 10) {
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      if (this.playing) {
        this.sendFrameUpdate();
      }
    }, 1000 / rate);
  }

  // ---- load session ----

  _beginSession(index, playNow) {
    const track = this.playlistModel.tracks[index];
    if (!track) return null;
    this._generation += 1;
    const token = this._generation;
    this._session = {
      token,
      index,
      trackId: track.id,
      playNow: !!playNow,
      pending: true,
    };
    this.playlistModel.index = index;
    // 切歌瞬间就把媒体会话切到新曲目：系统控件不会因等待取地址而消失或不更新
    this._mediaSession.setTrack(track);
    this._mediaSession.setPlaybackState('paused');
    // 旧音频只暂停、保留元素与媒体会话，等新曲真正开播后再定向卸载
    this._engine.pause();
    // 旧 Howl 的 pause/stop 事件会因代际过期被丢弃，UI 的 isPlaying 必须由这里补发
    this.sendPlayingEvent('Paused');
    this.sendLoadEvent();
    return token;
  }

  _startSession(index, playNow) {
    const track = this.playlistModel.tracks[index];
    if (!track) return;
    const token = this._beginSession(index, playNow);
    if (token === null) return;
    const cached = this._media_uri_list[track.id];
    if (cached && cached.url) {
      // 缓存命中：仍是新会话、新 Howl，只是不再向 provider 重复取地址；
      // 已有 bitrate/platform 由 track 带过去，不会被抹成 undefined
      this._finishLoad(
        token,
        {
          url: cached.url,
          bitrate: track.bitrate,
          platform: track.platform,
        },
        track
      );
      return;
    }
    this._host.resolveUrl(track, (bootinfo) => {
      this._handleUrlResult(token, track, bootinfo);
    });
  }

  _finishLoad(token, bootinfo, track) {
    const session = this._session;
    if (!session || session.token !== token) return;
    // 等待取地址期间列表可能增删：按 trackId 重新定位，不能用 session.index
    const index = this.playlistModel.findIndexById(session.trackId);
    if (index < 0) {
      // 目标曲目已被删除：作废这一代，迟到的 URL 不会再串到别的曲目上
      this._generation += 1;
      this._session = null;
      return;
    }
    this.playlistModel.index = index;
    // 缓存重放时 bootinfo.bitrate / platform 可能缺失：只在有值时覆盖，不能抹掉已有值
    if (bootinfo.bitrate !== undefined) track.bitrate = bootinfo.bitrate;
    if (bootinfo.platform !== undefined) track.platform = bootinfo.platform;
    this.setMediaURI(
      {
        url: bootinfo.url,
        bitrate: track.bitrate,
        platform: track.platform,
      },
      track.id
    );
    this.setAudioDisabled(false, index);
    const howl = this._engine.load({ url: bootinfo.url, track, token });
    track.howl = howl;
    this._host.send('BG_PLAYER:RETRIEVE_URL_SUCCESS', {
      ...track,
      howl: undefined,
      index,
      playNow: session.playNow,
    });
    session.pending = false;
    if (session.playNow) {
      this._engine.play();
    }
  }

  _handleUrlResult(token, track, bootinfo) {
    const session = this._session;
    if (!session || session.token !== token) {
      // 过期会话：只缓存地址，不建 Howl、不播放、不改状态
      if (bootinfo && bootinfo.url) {
        this.setMediaURI({ url: bootinfo.url }, track.id);
      }
      return;
    }
    if (!bootinfo || !bootinfo.url) {
      this._handleUrlFailure(token, track);
      return;
    }
    this._finishLoad(token, bootinfo, track);
  }

  _handleUrlFailure(token, track) {
    const session = this._session;
    if (!session || session.token !== token) return;
    this._session = null;
    const index = this.playlistModel.findIndexById(track.id);
    if (index >= 0) this.setAudioDisabled(true, index);
    this._host.send('BG_PLAYER:RETRIEVE_URL_FAIL', {
      ...track,
      howl: undefined,
      index,
    });
    this._advanceAfterFailure();
  }

  /**
   * URL 失败后跳到下一首。同步回调（测试 / 本地缓存）会让 skip 递归回到这里，
   * 用 _advancing + _skipPending 摊平成循环，避免调用栈随曲目数增长。
   */
  _advanceAfterFailure() {
    if (this._advancing) {
      this._skipPending = true;
      return;
    }
    this._advancing = true;
    try {
      let pending = true;
      while (pending) {
        this._skipPending = false;
        this.skip('next');
        pending = this._skipPending;
      }
    } finally {
      this._advancing = false;
    }
  }

  _handleEnded() {
    switch (this._loop_mode) {
      case 2:
        this.skip('random');
        break;
      case 1:
        this.play();
        break;
      case 0:
      default:
        this.skip('next');
        break;
    }
  }

  _unloadOthers(keepHowl) {
    this._engine.unloadOtherThan(keepHowl);
    this.playlistModel.tracks.forEach((track) => {
      if (track.howl && track.howl !== keepHowl) {
        track.howl = null;
      }
    });
  }

  _handleAudioEvent({ type, token, howl, track, error }) {
    if (!token || token !== this._generation) {
      // 过期代际的事件：只清理这个已被弃用的 Howl，其余一概不采纳
      if (howl && howl !== this._engine.currentHowl) {
        this._engine.unload(howl);
      }
      return;
    }
    switch (type) {
      case 'playing': {
        // 兜底：Howler 的 HTML5 音频池释放节点时不重置 muted，play 分支又会把旧的
        // node.muted 一起 OR 进去；这里（playHtml5 写完 muted/volume 之后）重放一次
        // 权威状态，把节点的 muted 与 volume 纠正过来。
        this.applyAudioState();
        if (track) track.disabled = false;
        // Date.now() 返回毫秒时间戳，转成秒供 Last.fm scrobble 用
        this.playedFrom = Math.round(Date.now() / 1000);
        this._mediaSession.setPlaybackState('playing');
        this._unloadOthers(howl);
        this.sendPlayingEvent('Playing');
        break;
      }
      case 'loaded': {
        if (track) track.disabled = false;
        this.sendPlayingEvent('Loaded');
        break;
      }
      case 'paused': {
        this._mediaSession.setPlaybackState('paused');
        this.sendPlayingEvent('Paused');
        break;
      }
      case 'stopped': {
        this.sendPlayingEvent('Stopped');
        break;
      }
      case 'ended': {
        this._handleEnded();
        this.sendPlayingEvent('Ended');
        break;
      }
      case 'error': {
        this._handleAudioError(track, howl, error);
        break;
      }
      default:
        break;
    }
  }

  _handleAudioError(track, howl, error) {
    this._host.send('BG_PLAYER:PLAY_FAILED', error);
    if (track) track.disabled = true;
    this.sendPlayingEvent('err');
    this._engine.unload(howl);
    if (track) {
      track.howl = null;
      // 清掉地址缓存：这个地址已经播不了，下次不能再命中
      delete this._media_uri_list[track.id];
    }
    const index = track ? this.playlistModel.findIndexById(track.id) : -1;
    if (index >= 0) this.setAudioDisabled(true, index);
    this._session = null;
    this._advanceAfterFailure();
  }

  // ---- 播放控制 ----

  play(idx) {
    const model = this.playlistModel;
    if (model.length === 0) return;
    let index = typeof idx === 'number' ? idx : model.index;
    if (index < 0) index = model.index;
    if (!model.tracks[index]) index = 0;
    const track = model.tracks[index];
    const howl = this.currentHowl;
    // 当前曲目已经加载好、只是暂停：直接接着播（不重开 session、不重复取地址）
    if (
      index === model.index &&
      this._media_uri_list[track.id] &&
      howl &&
      track.howl === howl
    ) {
      this.sendLoadEvent();
      this._engine.play();
      return;
    }
    this._startSession(index, true);
  }

  playById(id) {
    const index = this.playlistModel.findIndexById(id);
    this.play(index < 0 ? undefined : index);
  }

  load(idx) {
    const model = this.playlistModel;
    if (model.length === 0) return;
    let index = typeof idx === 'number' ? idx : model.index;
    if (index < 0) return;
    if (!model.tracks[index]) index = 0;
    const track = model.tracks[index];
    // 只选曲、不取地址：作废等待中的会话
    this._generation += 1;
    this._session = null;
    model.index = index;
    this._mediaSession.setTrack(track);
    this._mediaSession.setPlaybackState('paused');
    this._engine.pause();
    // 旧实现靠卸载 Howl 的 stop 事件通知 UI；现在 stop 事件会因代际过期被丢弃，必须自己补发
    this.sendPlayingEvent('Stopped');
    this.sendLoadEvent();
  }

  loadById(id) {
    const index = this.playlistModel.findIndexById(id);
    this.load(index < 0 ? undefined : index);
  }

  pause() {
    if (this._session && this._session.pending) {
      // 等待取地址期间按了暂停：URL 回来后不要自动播放
      this._session.playNow = false;
    }
    const { currentHowl } = this;
    if (!currentHowl) {
      if (this._mediaSession.supported) {
        this._mediaSession.setPlaybackState('paused');
      }
      return;
    }
    this._engine.pause();
  }

  skip(direction) {
    const model = this.playlistModel;
    if (model.length === 0) {
      this._engine.pause();
      this._host.send('BG_PLAYER:RETRIEVE_URL_FAIL_ALL');
      this.sendLoadEvent();
      return;
    }
    model.index = model.nextIndex(direction);
    let tryCount = 0;
    while (tryCount < model.length && this._isDisabled(model.index)) {
      model.index = model.nextIndex(direction);
      tryCount += 1;
    }
    if (tryCount >= model.length) {
      this._engine.pause();
      this._host.send('BG_PLAYER:RETRIEVE_URL_FAIL_ALL');
      this.sendLoadEvent();
      return;
    }
    this._startSession(model.index, true);
  }

  _isDisabled(index) {
    const track = this.playlistModel.tracks[index];
    return !track || track.disabled;
  }

  stopAll() {
    this.playlistModel.tracks.forEach((track) => {
      if (track.howl) {
        track.howl.stop();
      }
    });
  }

  seek(per) {
    const { currentHowl } = this;
    if (!currentHowl) return;
    const duration = currentHowl.duration();
    if (!(duration > 0)) return;
    this._engine.seek(duration * per);
  }

  seekTime(seconds) {
    if (!this.currentHowl) return;
    this._engine.seek(seconds);
  }

  seekBy(delta) {
    const { currentHowl } = this;
    if (!currentHowl) return;
    const duration = currentHowl.duration();
    const target = currentHowl.seek() + delta;
    const position =
      duration > 0
        ? Math.min(Math.max(target, 0), duration)
        : Math.max(target, 0);
    this._engine.seek(position);
  }

  // ---- 播放列表编辑 ----

  insertAudio(audio, idx) {
    const insertedIndex = this.playlistModel.insert(
      {
        ...audio,
        disabled: false, // avoid first time load block
        howl: null,
      },
      idx
    );
    if (insertedIndex < 0) return -1;
    this.sendPlaylistEvent();
    this.sendLoadEvent();
    return insertedIndex;
  }

  insertAudioByDirection(audio, toAudio, direction) {
    const insertedIndex = this.playlistModel.insertByDirection(
      audio,
      toAudio,
      direction
    );
    if (insertedIndex < 0) return -1;
    this.sendPlaylistEvent();
    this.sendLoadEvent();
    return insertedIndex;
  }

  removeAudio(idx) {
    const model = this.playlistModel;
    if (!model.tracks[idx]) return;
    const target = model.tracks[idx];
    // 动列表前先作废指向被删曲目的 pending 会话，否则 URL 回来会串到别的曲目上
    if (this._session && this._session.trackId === target.id) {
      this._generation += 1;
      this._session = null;
    }
    const wasPlaying = this.playing;
    const currentId = this.currentAudio ? this.currentAudio.id : undefined;
    const removed = model.remove(idx);
    if (!removed) return;
    const currentRemoved = removed.id === currentId;
    if (currentRemoved) {
      this._engine.pause();
      this._engine.unload();
      removed.howl = null;
    }
    if (currentRemoved && wasPlaying) {
      this.play();
    }
    this.sendPlaylistEvent();
    this.sendLoadEvent();
  }

  appendAudioList(list) {
    if (!Array.isArray(list)) return;
    list.forEach((audio) => {
      this.insertAudio(audio);
    });
  }

  clearPlaylist() {
    // 清掉等待中的取地址会话
    this._generation += 1;
    this._session = null;
    this.stopAll();
    this._engine.unloadAll();
    this.playlistModel.setList([]);
    this._mediaSession.clearTrack();
    this._mediaSession.setPlaybackState('none');
    // 被作废的 stop 事件不会再通知 UI，isPlaying=false 必须由这里补发
    this.sendPlayingEvent('Stopped');
    this.sendPlaylistEvent();
    this.sendLoadEvent();
  }

  setNewPlaylist(list) {
    if (Array.isArray(list) && list.length > 0) {
      // 作废等待中的取地址会话，并卸掉旧列表的 Howl
      this._generation += 1;
      this._session = null;
      this.stopAll();
      this._engine.unloadAll();
      const tracks = list.map((audio) => ({ ...audio, howl: null }));
      // 随机模式从随机的第一首开始；顺序模式仍从第 0 首开始
      const startIndex =
        this._loop_mode === 2 ? Math.floor(Math.random() * tracks.length) : 0;
      this.playlistModel.setList(tracks, { index: startIndex });
      const startTrack = this.playlistModel.tracks[startIndex];
      this._mediaSession.setTrack(startTrack);
      this._mediaSession.setPlaybackState('paused');
      // 旧音频的 stop 事件已随代际作废：isPlaying=false 由这里补发；本方法不取地址、不播放
      this.sendPlayingEvent('Stopped');
      this.sendLoadEvent();
    }
    this.sendPlaylistEvent();
  }

  // ---- 音量 / 静音 ----

  applyAudioState() {
    this._engine.applyAudioState({
      volume: this._volume,
      muted: this._muted,
    });
  }

  setVolume(pct) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) {
      return;
    }
    this._volume = Math.min(Math.max(pct, 0), 100) / 100;
    this._muted = false;
    this.applyAudioState();
    this.sendAudioStateEvent();
  }

  adjustVolume(increase) {
    this.setVolume(this.getAudioState().volume + (increase ? 10 : -10));
  }

  setMuted(muted) {
    this._muted = !!muted;
    this.applyAudioState();
    this.sendAudioStateEvent();
  }

  toggleMuted() {
    this.setMuted(!this._muted);
  }

  // ---- 广播 / 兼容入口 ----

  /**
   * 缓存播放地址。`_media_uri_list[track.id] = { url, bitrate, platform }`：
   * 缓存重放时要用后者补齐 track 上的字段，所以缺省时保留旧值、绝不写 undefined。
   */
  setMediaURI(uri, url) {
    if (!url || !uri) return;
    const cached = this._media_uri_list[url] || {};
    if (typeof uri === 'string') {
      // 兼容旧调用：只给地址
      this._media_uri_list[url] = {
        url: uri,
        bitrate: cached.bitrate,
        platform: cached.platform,
      };
      return;
    }
    this._media_uri_list[url] = {
      url: uri.url,
      bitrate: uri.bitrate !== undefined ? uri.bitrate : cached.bitrate,
      platform: uri.platform !== undefined ? uri.platform : cached.platform,
    };
  }

  setAudioDisabled(disabled, idx) {
    if (this.playlistModel.tracks[idx]) {
      this.playlistModel.tracks[idx].disabled = disabled;
    }
  }

  sendFrameUpdate() {
    const howl = this.currentHowl;
    const duration = howl ? howl.duration() : 0;
    const pos = howl ? howl.seek() : 0;
    const rate = howl ? howl.rate() : 1;
    // duration 为 0 / 非法时 setPositionState 会抛 NotSupportedError：这里先守一层（controller 里还有一层）
    if (duration > 0) {
      this._mediaSession.setPosition({ duration, position: pos, rate });
    }
    this._host.send('BG_PLAYER:FRAME_UPDATE', {
      id: this.currentAudio ? this.currentAudio.id : 0,
      duration,
      pos,
      playedFrom: this.playedFrom,
      playing: this.playing,
    });
  }

  sendPlayingEvent(reason = 'UNKNOWN') {
    this._host.send('BG_PLAYER:PLAY_STATE', {
      isPlaying: this.playing,
      reason,
    });
  }

  sendLoadEvent() {
    this._host.send('BG_PLAYER:LOAD', {
      currentPlaying: {
        ...this.currentAudio,
        howl: undefined,
      },
      playlist: {
        index: this.index,
        length: this.playlist.length,
      },
    });
  }

  sendAudioStateEvent() {
    this._host.send('BG_PLAYER:AUDIO_STATE', this.getAudioState());
  }

  sendPlaylistEvent() {
    this._host.send(
      'BG_PLAYER:PLAYLIST',
      this.playlist.map((audio) => ({ ...audio, howl: undefined }))
    );
  }
}
```

- [ ] **Step 5: 跑测试确认通过并修断言（如果有偏差）**

Run: `cmd /c "node --test --test-isolation=none test/player_lifecycle.test.js > test_out.txt 2>&1"` → Expected: 全 pass。
若断言失败，**先判断是测试预期写错还是实现错**：实现必须遵守上面「关键时序」15 条与 Step 2 的断言口径（例如缓存命中后 `howler._howls.length === 1`）；确实与实现语义冲突时才改测试，并在测试注释里写清原因。

- [ ] **Step 6: lint + 格式化 + 全量测试**

```powershell
cmd /c "node node_modules\prettier\bin-prettier.js --write js\player\player_core.js test\helpers\player_lifecycle_harness.js test\player_lifecycle.test.js > prettier_out.txt 2>&1"
cmd /c "node node_modules\eslint\bin\eslint.js js\player\player_core.js test\helpers\player_lifecycle_harness.js test\player_lifecycle.test.js > lint_out.txt 2>&1"
cmd /c "npm test > test_out.txt 2>&1"
```

---

### Task 6: bootstrap 替换 + 脚本清单 + 旧测试迁到新模块

**Owner:** Lead

**Files:**

- Modify: `js/player_thread.js`（整体重写为 bootstrap）
- Modify: `listen1.html`（脚本清单）
- Modify: `manifest_firefox.json`（background.scripts）
- Create: `test/runtime_paths.test.js`（三套运行时冒烟测试，见 Step 6）
- Modify: `test/helpers/player_harness.js`（改为载入新模块）
- Modify: `test/player_shuffle.test.js`（内部状态读取路径）

**Interfaces:**

- Consumes: Task 1-5 全部模块。
- Produces: `window.threadPlayer` 仍是 `PlayerCore` 实例；`player_thread.js` 不再是唯一实现文件，只做组装。

- [ ] **Step 1: 把 `js/player_thread.js` 整体替换为 bootstrap**

```js
/* global createPlayerHost PlayerCore */
{
  // 播放器单例：host 收敛运行时差异（消息通道 / 取地址），core 负责播放状态机。
  // 模式在 play.js 里通过 setMode() 确定（此前不知道自己是 front 还是 background，
  // 旧实现的 READY 顶层广播因此永远发不出去）。
  const threadPlayer = new PlayerCore({
    host: createPlayerHost({ mode: 'background' }),
  });
  threadPlayer.setRefreshRate();
  window.threadPlayer = threadPlayer;
}
```

- [ ] **Step 2: 更新 `listen1.html` 脚本清单**

在 `<script type="text/javascript" src="js/player_thread.js"></script>` **之前**依次插入（保持依赖顺序）：

```html
<script type="text/javascript" src="js/player/playlist_model.js"></script>
<script type="text/javascript" src="js/player/audio_engine.js"></script>
<script type="text/javascript" src="js/player/media_session.js"></script>
<script type="text/javascript" src="js/player/player_host.js"></script>
<script type="text/javascript" src="js/player/player_core.js"></script>
```

- [ ] **Step 3: 更新 `manifest_firefox.json` 的 `background.scripts`**

在 `"js/player_thread.js"` 之前插入同样五个路径（顺序同上）。注意 JSON 逗号。

- [ ] **Step 4: 重写 `test/helpers/player_harness.js`**

保持对 `test/player_shuffle.test.js` 的导出接口不变：`loadPlayerHarness()` → `{ createPlayer, makeTracks, messages, setRandom, Player }`。

```js
/**
 * 测试 harness：把新的播放器模块载入一个带 stub 的 vm 沙箱，组合出真实的 PlayerCore。
 *
 * 依赖的浏览器全局：
 *   - Howler / Howl：复刻被测代码用到的那部分语义（_howls 列表、unload 摘除自己、
 *     node 音量、play() 同步触发 onplay）；
 *   - MediaMetadata / navigator = {}：跳过 mediaSession 分支；
 *   - setInterval 空实现：不留下定时器。
 * PlayerCore 的 host 用 fake：resolveUrl 走一个同步的 MediaService 假实现。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const PLAYER_SOURCES = [
  'js/player/playlist_model.js',
  'js/player/media_session.js',
  'js/player/audio_engine.js',
  'js/player/player_core.js',
].map((file) => path.join(ROOT, file));

function createHowler() {
  return {
    _howls: [],
    usingWebAudio: false,
    _volume: 1,
    _muted: false,
    unload() {
      // 真实 Howler：逐个 Howl.unload()，而 Howl.unload() 会把自己从 _howls 摘掉
      this._howls.slice().forEach((howl) => howl.unload());
    },
    mute(muted) {
      this._muted = !!muted;
    },
    volume(vol) {
      if (typeof vol === 'number') {
        this._volume = vol;
      }
      return this._volume;
    },
    stop() {},
  };
}

function createHowlClass(howler) {
  return class Howl {
    constructor(options = {}) {
      this.options = options;
      this.node = { volume: 1, muted: false };
      this._playing = false;
      howler._howls.push(this);
    }

    playing() {
      return this._playing;
    }

    play() {
      this._playing = true;
      if (typeof this.options.onplay === 'function') {
        this.options.onplay(this.id);
      }
      return 1;
    }

    pause() {
      const wasPlaying = this._playing;
      this._playing = false;
      if (wasPlaying && typeof this.options.onpause === 'function') {
        this.options.onpause(this.id);
      }
    }

    stop() {
      this._playing = false;
    }

    unload() {
      const index = howler._howls.indexOf(this);
      if (index >= 0) {
        howler._howls.splice(index, 1);
      }
    }

    volume() {
      return 1;
    }

    mute() {}

    duration() {
      return 0;
    }

    seek() {
      return 0;
    }

    rate() {
      return 1;
    }
  };
}

function loadPlayerHarness() {
  const howler = createHowler();
  const Howl = createHowlClass(howler);
  const messages = [];
  let randomSource = Math.random;

  const sandbox = {
    Howler: howler,
    Howl,
    MediaMetadata: class {},
    navigator: {},
    setInterval: () => 0,
    clearInterval: () => {},
    __nextRandom: () => randomSource(),
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext('Math.random = () => __nextRandom();', context);
  PLAYER_SOURCES.forEach((sourcePath) => {
    vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, {
      filename: sourcePath,
    });
  });
  const Player = vm.runInContext('PlayerCore', context);

  const createPlayer = (tracks, options = {}) => {
    howler._howls.length = 0;
    const { loopMode = 0, index = 0 } = options;
    const host = {
      mode: 'front',
      send(type, data) {
        messages.push(data === undefined ? { type } : { type, data });
      },
      resolveUrl(track, callback) {
        callback({
          url: `test://${track.id}.mp3`,
          bitrate: 128,
          platform: track.source || 'test',
        });
      },
    };
    const player = new Player({ host });
    player.mode = 'front';
    player.playlistModel.setList(
      tracks.map((track) => ({
        ...track,
        disabled: false,
        howl: null,
      })),
      { index }
    );
    if (typeof index === 'number') {
      // setList 会把越界下标夹成 0；显式写回，保住 shuffle 测试里 index: -1 的越界用例
      player.playlistModel.index = index;
    }
    player.loop_mode = loopMode;
    return player;
  };

  const setRandom = (fn) => {
    randomSource = fn;
  };

  const makeTracks = (count, prefix = 't') =>
    Array.from({ length: count }, (_v, i) => ({
      id: `${prefix}${i}`,
      title: `${prefix}${i}`,
      artist: 'artist',
      source: 'test',
    }));

  return { createPlayer, makeTracks, messages, setRandom, Player };
}

module.exports = { loadPlayerHarness };
```

- [ ] **Step 5: 改 `test/player_shuffle.test.js` 的内部状态路径**

只改三处读取，断言语义一律不动：

- 「随机播放的半随机轮长」用例里 `const { _random_len: roundLength } = player;` → `const { _random_len: roundLength } = player.playlistModel;`
- 同一用例里 `if (player._random_steps === 1) {` → `if (player.playlistModel._random_steps === 1) {`
- 若有其它 `player._random_*` 直接访问，同样改成 `player.playlistModel._random_*`。

自查：`Select-String -Path test\player_shuffle.test.js -Pattern '_random'` → 命中的行都必须带 `playlistModel`。

其余断言（`player.index`、`player.playlist`、`player.setNewPlaylist`、`player.skip`、`player.loop_mode`、`player.insertAudio`）不动。

- [ ] **Step 6: 三套运行时冒烟测试（新增 `test/runtime_paths.test.js`）**

用 vm 沙箱按 `listen1.html` 的真实脚本顺序加载 `bridge.js` + `js/player/*` + `player_thread.js`，只 stub 浏览器重依赖（Howler/Howl/mediaSession/chrome.runtime/MediaService），覆盖三条路径：

1. **front**（Chrome/Edge MV3；Electron 同路）：`setMode('front')` → `setNewPlaylist` → `playById`，断言 `READY/LOAD/PLAYLIST` 广播、`isPlaying=true`、`mediaSession.metadata` 为新曲、`sendFrameUpdate` 写入 `positionState`、`pause/skip/clearPlaylist` 正常；
2. **background**（Firefox MV2 后台页，无 `MediaService`/无 `chrome` 页面环境但有 `chrome.runtime`）：`playById` 走 fail-fast 分支，断言出现 `RETRIEVE_URL_FAIL` 与 `RETRIEVE_URL_FAIL_ALL`、不抛异常、不永久挂起；
3. **Electron 最差环境**（front 且无 `chrome.*`、无 mediaSession）：能加载、能播放、`setVolume/setMuted` 的 `getAudioState()` 正确。

这三条只做集成冒烟（细节逻辑在各自单测里），用于保证「按真实加载顺序组装起来不会崩、主链路能走通」。

- [ ] **Step 7: 跑全量测试**

Run: `cmd /c "npm test > test_out.txt 2>&1"` → Expected: 全部 pass（原有 30 个 + 各模块单测 + 生命周期用例 + 三套运行时冒烟）。

- [ ] **Step 8: lint + 格式化**

```powershell
cmd /c "node node_modules\prettier\bin-prettier.js --write js\player_thread.js test\helpers\player_harness.js test\player_shuffle.test.js test\runtime_paths.test.js > prettier_out.txt 2>&1"
cmd /c "node node_modules\eslint\bin\eslint.js . > lint_out.txt 2>&1"
```

---

### Task 7: 文档、CHANGELOG 与整体验收

**Owner:** Lead

**Files:**

- Modify: `docs/INDEX.md`（模块索引、启动顺序、运行时链路、已知问题、速查表）
- Modify: `CHANGELOG.md`（`## 2026-10-24` 小节补条目）
- Modify: `docs/superpowers/specs/2026-10-24-player-refactor-design.md`（状态行）
- Modify: `docs/superpowers/plans/2026-10-24-player-refactor.md`（勾掉步骤；可选）

**Interfaces:** 无代码接口；只改文档。

- [ ] **Step 1: `docs/INDEX.md`**

1. §2 目录结构里在 `js/` 下补 `player/` 分组（5 个新文件 + 一行说明），并把 `player_thread.js` 的描述改成「bootstrap：组装 host + PlayerCore」。
2. §4 启动顺序表：在 `player_thread.js` 那一行前补一行「`js/player/*.js`：列表模型 / 音频引擎 / 媒体会话 / 运行时适配 / 编排，按依赖顺序加载（必须先于 `player_thread.js`）」。**不要写行号**，用相对位置描述。
3. §6.2 服务层表格：`js/player_thread.js` 那行拆分改写为 5 行（`player/playlist_model.js`、`player/audio_engine.js`、`player/media_session.js`、`player/player_host.js`、`player/player_core.js` + 保留 bootstrap 行），「关键符号」列填对应类名与核心方法；删除已经搬走的 god class 描述。
4. §12 已知问题第 5 条（READY 消息丢失）改为「已修复」口径：`PlayerCore.setMode()` 在模式确定后广播 `READY`，不再依赖顶层 `this.mode`。
5. §13 速查表把「改播放逻辑（切歌/循环/随机）」一行改指 `js/player/player_core.js` / `js/player/playlist_model.js`（编排与随机走位），不再指向 `player_thread.js`。
6. §5.1「播放一首歌」与 §5.2「进度 / 歌词 / 状态回传」两段调用链改写到 `js/player/*`：入口写 `js/player/player_core.js` 的 `play()` → `_startSession()` → `_finishLoad()`（`new Howl` 在 `js/player/audio_engine.js`）；删除旧 `Player.play → retrieveMediaUrl/finishLoad` 的描述与其中的 `player_thread.js:xxx` 行号。

- [ ] **Step 2: `CHANGELOG.md`**

在 `## 2026-10-24` 的 `### Changed` 与 `### Fixed` 下各补条目（一条一句话，中文，与既有风格一致）：

- Changed：`播放器子系统拆分为列表模型 / 音频引擎 / 媒体会话 / 运行时适配 / 编排五个模块，player_thread.js 缩为组装入口`；
- Changed：`切歌改为旧音源只暂停、新曲开播后再定向卸载旧 Howl，不再整栈 Howl.unload()`；
- Fixed：`系统媒体控件在切歌瞬间消失再出现：metadata 现在随切歌立即更新，不再等新的 onplay`；
- Fixed：`快速连续切歌时过期地址请求可能让旧曲目晚到抢播：取地址与 Howl 事件按 load 代际校验`；
- Fixed：`切歌空窗期给 mediaSession.setPositionState 传 duration 0 的非法参数`；
- Fixed：`READY 消息始终发不出去（顶层 this.mode 为 undefined），改由 setMode() 在模式确定后广播`。

- [ ] **Step 3: spec 状态行**

`- 状态：待评审` → `- 状态：已实现（2026-10-24，见 docs/superpowers/plans/2026-10-24-player-refactor.md）`。

- [ ] **Step 4: 最终验证（逐条执行、贴结果）**

```powershell
cmd /c "npm test > test_out.txt 2>&1"
cmd /c "node node_modules\eslint\bin\eslint.js . > lint_out.txt 2>&1"
cmd /c "node node_modules\prettier\bin-prettier.js --check js\player js\player_thread.js test docs\INDEX.md docs\superpowers > prettier_out.txt 2>&1"
git status --short
git diff --stat
```

Expected：

- `npm test` 0 fail；
- eslint 无输出；
- prettier `--check` 通过（若 `--check` 对 `docs/superpowers` 目录报未格式化，允许对该目录忽略，只要新增/修改文件过 prettier）；
- `git status` 里只有本计划预期的文件（`js/player/`、`js/player_thread.js`、`listen1.html`、`manifest_firefox.json`、`test/` 新增与修改、`docs/INDEX.md`、`CHANGELOG.md`、spec、plan），且**没有提交**。

- [ ] **Step 5: 静态自查（不写代码，逐条回答）**

- `js/controller/play.js`、`js/l1_player.js`、`js/bridge.js` 是否零改动？（`git status --short` 核对）
- `window.threadPlayer` 的方法/属性是否覆盖 `docs/superpowers/specs/2026-10-24-player-refactor-design.md` §4.5 的完整清单？（逐个 grep 方法名）
- 新文件是否都在 `listen1.html` 与 `manifest_firefox.json` 的脚本清单里？（grep 路径）
- 有没有残留的 `Howler.unload()` 调用（除了 stub / 测试）？（`grep -rn "Howler.unload" js/`）
- 旧实现描述是否清干净？（`Select-String -Path js, docs -Pattern 'retrieveMediaUrl|finishLoad|startRandomRound'` 不得命中旧实现描述；`finishLoad` 若在新代码里作为私有方法名保留可例外，但文档不得再描述「旧 finishLoad」）
- 有没有代码注释里出现行号？（`grep -rn ":[0-9]\{2,\}" js/player/ docs/` 抽查，文档/注释禁止行号）

---

## 自审记录（写计划时已核对）

- **Spec 覆盖**：spec §3 模块表 → Task 1-5；§4 接口 → 各 Task 的 Interfaces；§5 切歌时序 → Task 5 的「关键时序」15 条 + 生命周期测试；§6 错误处理 → Task 5 `_handleUrlFailure` / `_handleAudioError`（当前代 Howl 错误跳下一首并清地址缓存）/ `_advanceAfterFailure`；§7 消息兼容 → Task 5 广播方法 + Task 6 清单 + Task 7 自查；§8 测试策略 → Task 1-5 测试与 harness；§9 顺序 → 任务顺序即实施顺序；§11 验收 → Task 7 Step 4-5。另有四点已同步纳入 spec 并被本计划覆盖：session 按 `trackId` 重新定位（等待期间列表增删）、AudioEngine 卸载期间抑制该 Howl 的事件（防 `unload` 递归）、暂停/清空/换列表/`load()` 的 `PLAY_STATE` 补偿、`_media_uri_list` 缓存 `{url, bitrate, platform}` 且不被 `undefined` 覆盖。
- **类型一致性**：`PlaylistModel.nextIndex/insert/insertByDirection/remove` 的返回值约定在 Task 1 Interfaces 与 Task 5 使用处一致；`AudioEngine.load({url, track, token})`、`get currentHowl()` / `get currentTrack()`、`unload(howl)`（默认 `this.currentHowl`，不额外调 `stop()`）、`unloadOtherThan(keep)`、`applyAudioState({volume, muted})` 在 Task 3 与 Task 5 一致；`PlayerCore.currentHowl` getter 用 `engine.currentTrack === currentAudio` 判定 Howl 归属；`setMediaURI` 的缓存对象形状 `{url, bitrate, platform}` 在 Task 5 的 `_startSession` / `_finishLoad` / `_handleUrlResult` 三处一致；`MediaSessionController` 的 `setPosition({duration, position, rate})` 在 Task 2 与 Task 5 一致；`createPlayerHost` 的 `mode/send/resolveUrl` 在 Task 4 与 Task 6 bootstrap 一致。
- **无占位**：每个代码步骤都给了完整实现/测试；唯一允许实现的自由是 Task 5 Step 5 里「测试预期按实现修正」的边界，已写清只允许改既有行为预期、不允许改关键时序。

---

## 实施后独立审查与修复（2026-10-24）

三套运行时接线完成后交独立 subagent 审查（不看实现过程、只对最终工作树），结论 `REQUEST CHANGES`。已全部处理并补回归测试：

- **BLOCKER**：`play()` 的「复用当前 Howl」分支在正在播放时仍调 `Howl.play()`，Howler 会为正在播放的 Howl 新建 sound（双声、pause/resume 后继续叠加）。修复：复用分支只在 `!this.playing` 时调 `_engine.play()`；`test/player_lifecycle.test.js` 用 `playCalls` 计数器断言「播放中再次 play / playById(当前) 不再调 Howl.play()」。
- **MAJOR**：当前代 Howl `onplayerror` 在 unload 前发 `PLAY_STATE`（此时 `playing` 仍 true），卸载后未补 false；单曲歌单/全部不可播时 UI `isPlaying` 卡 true。修复：`_handleAudioError` unload 后补 `playbackState='paused'` + `PLAY_STATE Stopped`；`skip()` 两个 FAIL_ALL 分支同样补 paused + false。
- **MINOR（负载契约）**：`RETRIEVE_URL_SUCCESS` 恢复 `url`、`RETRIEVE_URL_FAIL` 恢复 `playNow`，与旧消息字段一致（并有测试）。
- **MINOR（语义对齐）**：`loadById(未知 id)` 恢复旧实现 no-op；删除「当前但未在播放」曲目后 `setTrack(新当前曲目)`，删除「最后一首在播」曲目后 `clearTrack()` + `playbackState='none'` + `PLAY_STATE false`。
- **MINOR（资源）**：等待取地址期间按了暂停（`playNow=false`）时 URL 返回只缓存地址并卸载临时 Howl，不再留下不播的音频元素。
- **MINOR（对外面）**：旧 `retrieveMediaUrl` / `finishLoad` / `startRandomRound` / `resetRandomPlaylist` 不再挂实例（全仓无调用方），已在 spec §4.5 注明；`playlist` 为只读 getter。
- **MINOR（文档）**：`docs/INDEX.md` §4 启动顺序改为纯顺序表（去掉已失真的行号并补 player 模块）、§5.1 时序图按 `_beginSession`/`_startSession` 实际顺序重画、§11 补测试脚本与 MV2 后台脚本清单、§12 更新测试现状并注明 Firefox MV2 后台播放仍不可用。
- 最终验证：`npm test` **81 pass / 0 fail**；`eslint .` 无输出；新增/修改文件 prettier `--check` 通过。审查未要求提交，工作树保持未提交状态。
