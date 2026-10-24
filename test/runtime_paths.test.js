/**
 * 三套运行时的加载与播放链路冒烟测试。
 *
 * 用 vm 沙箱按 `listen1.html` 的脚本顺序加载真实的 bridge.js + js/player/* + player_thread.js，
 * 只 stub 浏览器侧的重依赖（Howler / Howl / mediaSession / chrome.runtime / MediaService）：
 *   - front（Chrome/Edge MV3；Electron 同路）：MediaService 直连 + mediaSession 写入 + 消息广播；
 *   - background（Firefox MV2 后台页）：没有服务层脚本，取地址必须 fail-fast，不能挂起或抛异常；
 *   - Electron 最差环境：没有 chrome.*、没有 mediaSession，仍要能加载与播放。
 * 这三个路径的细节逻辑各有单测；这里只保证「按真实加载顺序组装起来不会崩、主链路能走通」。
 */
/* eslint-disable no-param-reassign */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const SCRIPT_ORDER = [
  'js/bridge.js',
  'js/player/playlist_model.js',
  'js/player/audio_engine.js',
  'js/player/media_session.js',
  'js/player/player_host.js',
  'js/player/player_core.js',
  'js/player_thread.js',
];

function createHowler() {
  return {
    _howls: [],
    _muted: false,
    _volume: 1,
    unload() {
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
      this.playingState = false;
      this.durationValue = 100;
      this.positionValue = 0;
      howler._howls.push(this);
    }

    playing() {
      return this.playingState;
    }

    play() {
      this.playingState = true;
      if (typeof this.options.onplay === 'function') {
        this.options.onplay(this.id);
      }
      return 1;
    }

    pause() {
      const wasPlaying = this.playingState;
      this.playingState = false;
      if (wasPlaying && typeof this.options.onpause === 'function') {
        this.options.onpause(this.id);
      }
    }

    stop() {
      this.playingState = false;
      if (typeof this.options.onstop === 'function') {
        this.options.onstop(this.id);
      }
    }

    unload() {
      this.playingState = false;
      // 复刻 Howler：Howl.unload() 内部会 stop 并派发 onstop
      if (typeof this.options.onstop === 'function') {
        this.options.onstop(this.id);
      }
      const index = howler._howls.indexOf(this);
      if (index >= 0) {
        howler._howls.splice(index, 1);
      }
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
      return this.durationValue;
    }

    seek(seconds) {
      if (typeof seconds === 'number') {
        this.positionValue = seconds;
        return this;
      }
      return this.positionValue;
    }

    rate() {
      return 1;
    }
  };
}

function createMediaSessionStub() {
  return {
    metadata: null,
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

/**
 * 按 listen1.html 的顺序把真实脚本载进一个带最小浏览器全局的沙箱。
 * @param {{ mediaSession?: boolean, chrome?: boolean }} options
 */
function loadRuntime(options = {}) {
  const { mediaSession = false, chrome: withChrome = false } = options;
  const howler = createHowler();
  const Howl = createHowlClass(howler);
  const frontMessages = [];
  const sentMessages = [];
  const mediaSessionStub = mediaSession ? createMediaSessionStub() : null;
  const chrome = withChrome
    ? {
        runtime: {
          sendMessage(message) {
            sentMessages.push(message);
          },
          onMessage: { addListener() {} },
        },
      }
    : undefined;
  const sandbox = {
    Howler: howler,
    Howl,
    MediaMetadata: class {
      constructor(init) {
        this.init = init;
      }
    },
    navigator: mediaSessionStub ? { mediaSession: mediaSessionStub } : {},
    setInterval: () => 0,
    clearInterval: () => {},
    isElectron: () => false,
    getLocalStorageValue: (key, fallback) => fallback,
    chrome,
    __frontPush: (msg) => frontMessages.push(msg),
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  SCRIPT_ORDER.forEach((file) => {
    const full = path.join(ROOT, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
  });
  // chrome 不存在时 bridge 只用 frontPlayerListener 派发，这里相当于 play.js 注册监听
  vm.runInContext(
    'addPlayerListener("front", (msg) => __frontPush(msg));',
    context
  );
  return {
    sandbox,
    context,
    howler,
    mediaSessionStub,
    frontMessages,
    sentMessages,
  };
}

/** 模拟 loweb.js 在 player_thread.js 之后加载 */
function attachMediaService(runtime) {
  runtime.sandbox.MediaService = {
    bootstrapTrack(track, success) {
      success({
        url: `test://${track.id}.mp3`,
        bitrate: 128,
        platform: 'test',
      });
    },
  };
}

function messageTypes(messages) {
  return messages.map((msg) => msg.type);
}

describe('三套运行时的加载与播放链路', () => {
  test('front：READY/LOAD/PLAYLIST/playing 广播、metadata、进度上报与常规操作', () => {
    const runtime = loadRuntime({ mediaSession: true });
    const { sandbox, context, mediaSessionStub, frontMessages } = runtime;
    assert.ok(sandbox.threadPlayer, 'bootstrap 后应挂 window.threadPlayer');

    attachMediaService(runtime);
    vm.runInContext('window.threadPlayer.setMode("front")', context);
    vm.runInContext(
      `window.threadPlayer.setNewPlaylist([
        { id: 'a', title: 'A', artist: 'artist-a' },
        { id: 'b', title: 'B', artist: 'artist-b' }
      ])`,
      context
    );
    vm.runInContext('window.threadPlayer.playById("a")', context);

    const types = messageTypes(frontMessages);
    assert.ok(types.includes('BG_PLAYER:READY'));
    assert.ok(types.includes('BG_PLAYER:LOAD'));
    assert.ok(types.includes('BG_PLAYER:PLAYLIST'));
    assert.ok(
      frontMessages.some(
        (msg) =>
          msg.type === 'BG_PLAYER:PLAY_STATE' && msg.data.isPlaying === true
      ),
      '播放中应有 isPlaying=true 的 PLAY_STATE'
    );
    assert.strictEqual(sandbox.threadPlayer.playlist.length, 2);
    assert.strictEqual(sandbox.threadPlayer.playing, true);
    assert.strictEqual(mediaSessionStub.metadata.init.title, 'A');
    assert.strictEqual(mediaSessionStub.playbackState, 'playing');

    vm.runInContext('window.threadPlayer.sendFrameUpdate()', context);
    assert.strictEqual(mediaSessionStub.positionStates.length, 1);
    assert.strictEqual(mediaSessionStub.positionStates[0].duration, 100);
    assert.ok(messageTypes(frontMessages).includes('BG_PLAYER:FRAME_UPDATE'));

    vm.runInContext('window.threadPlayer.pause()', context);
    assert.strictEqual(sandbox.threadPlayer.playing, false);

    vm.runInContext('window.threadPlayer.skip("next")', context);
    assert.strictEqual(sandbox.threadPlayer.index, 1);

    vm.runInContext('window.threadPlayer.clearPlaylist()', context);
    assert.strictEqual(sandbox.threadPlayer.playlist.length, 0);
    assert.strictEqual(mediaSessionStub.metadata, null);
  });

  test('background：没有 MediaService 时取地址 fail-fast，不挂起也不抛异常', () => {
    const runtime = loadRuntime({ chrome: true });
    const { sandbox, context, sentMessages } = runtime;
    assert.ok(sandbox.threadPlayer);

    vm.runInContext(
      `window.threadPlayer.setNewPlaylist([{ id: 'a', title: 'A', artist: 'a' }])`,
      context
    );
    assert.doesNotThrow(() => {
      vm.runInContext('window.threadPlayer.playById("a")', context);
    });
    vm.runInContext('window.threadPlayer.skip("next")', context);
    vm.runInContext('window.threadPlayer.clearPlaylist()', context);

    const types = messageTypes(sentMessages);
    assert.ok(
      types.includes('BG_PLAYER:RETRIEVE_URL_FAIL'),
      '后台页无法取地址时应广播失败'
    );
    assert.ok(
      types.includes('BG_PLAYER:RETRIEVE_URL_FAIL_ALL'),
      '无可用曲目时应广播 FAIL_ALL，而不是永久等待'
    );
    assert.strictEqual(sandbox.threadPlayer.playlist.length, 0);
  });

  test('Electron（front 且无 chrome.* / 无 mediaSession）：能加载、能播放、音量状态可用', () => {
    const runtime = loadRuntime();
    const { sandbox, context } = runtime;
    attachMediaService(runtime);

    vm.runInContext('window.threadPlayer.setMode("front")', context);
    vm.runInContext(
      `window.threadPlayer.setNewPlaylist([{ id: 'a', title: 'A', artist: 'a' }])`,
      context
    );
    assert.doesNotThrow(() => {
      vm.runInContext('window.threadPlayer.playById("a")', context);
    });
    assert.strictEqual(sandbox.threadPlayer.playing, true);

    vm.runInContext('window.threadPlayer.setVolume(65)', context);
    assert.strictEqual(sandbox.threadPlayer.getAudioState().volume, 65);
    vm.runInContext('window.threadPlayer.setMuted(true)', context);
    assert.strictEqual(sandbox.threadPlayer.getAudioState().muted, true);
  });
});
