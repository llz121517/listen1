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
      this.playCalls = 0;
      howler._howls.push(this);
    }

    playing() {
      return this._playing;
    }

    play() {
      this._playing = true;
      this.playCalls += 1;
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
      // 复刻 Howler：stop() 无条件派发 onstop
      if (typeof this.options.onstop === 'function') {
        this.options.onstop(this.id);
      }
    }

    unload() {
      this.unloaded = true;
      this._playing = false;
      // 复刻 Howler：Howl.unload() 内部先 stop，所以也会无条件派发 onstop
      if (typeof this.options.onstop === 'function') {
        this.options.onstop(this.id);
      }
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
