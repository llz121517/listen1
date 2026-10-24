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
const vm = require('node:vm');
const { loadScripts, globalValue } = require('./player_vm');

const PLAYER_SOURCES = [
  'js/player/playlist_model.js',
  'js/player/media_session.js',
  'js/player/audio_engine.js',
  'js/player/player_core.js',
];

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
  const context = loadScripts(sandbox, PLAYER_SOURCES);
  vm.runInContext('Math.random = () => __nextRandom();', context);
  const Player = globalValue(context, 'PlayerCore');

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
