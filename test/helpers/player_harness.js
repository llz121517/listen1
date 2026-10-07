/**
 * 测试 harness：把真实的 js/player_thread.js 载进一个带 stub 的 vm 沙箱。
 *
 * 被测文件是浏览器脚本（无 import/export，依赖 Howler / MediaService / window 等全局），
 * 所以这里不做任何源码改写，只补它需要的全局：
 *   - Howler / Howl：复刻被测代码用到的那部分语义（_howls 列表、unload 摘除自己、node 音量）
 *   - MediaService.bootstrapTrack：同步回调一个假 URL（让 play() 走到 finishLoad）
 *   - playerSendMessage：记录广播，供断言消息用
 *   - navigator = {}：跳过 mediaSession 分支；setInterval 空实现：不留下定时器
 *
 * Player 类没有导出，但实例挂在 window.threadPlayer 上，用 .constructor 取回类即可。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLAYER_SOURCE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'js',
  'player_thread.js'
);

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
      howler._howls.push(this);
    }

    playing() {
      return false;
    }

    play() {
      return 1;
    }

    pause() {}

    stop() {}

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

/**
 * 载入被测文件，返回可复用的工厂。
 * @returns {{ createPlayer: Function, messages: Array, setRandom: Function }}
 */
function loadPlayerHarness() {
  const howler = createHowler();
  const Howl = createHowlClass(howler);
  const messages = [];

  let randomSource = Math.random;

  const sandbox = {
    Howler: howler,
    Howl,
    MediaService: {
      bootstrapTrack(track, onSuccess) {
        onSuccess({
          url: `test://${track.id}.mp3`,
          bitrate: 128,
          platform: track.source || 'test',
        });
      },
    },
    MediaMetadata: class {},
    navigator: {},
    setInterval: () => 0,
    clearInterval: () => {},
    playerSendMessage: (mode, message) => {
      messages.push(message);
    },
    __nextRandom: () => randomSource(),
    console,
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext('Math.random = () => __nextRandom();', context);
  vm.runInContext(fs.readFileSync(PLAYER_SOURCE_PATH, 'utf8'), context, {
    filename: PLAYER_SOURCE_PATH,
  });

  const Player = sandbox.window.threadPlayer.constructor;

  /**
   * @param {Array} tracks 曲目（至少要有 id）
   * @param {{loopMode?: Number, index?: Number}} [options] loopMode: 0 顺序 / 1 单曲循环 / 2 随机
   */
  const createPlayer = (tracks, options = {}) => {
    const { loopMode = 0, index = 0 } = options;
    const player = new Player();
    player.mode = 'front';
    player.playlist = tracks.map((track) => ({
      ...track,
      disabled: false,
      howl: null,
    }));
    player.index = index;
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
