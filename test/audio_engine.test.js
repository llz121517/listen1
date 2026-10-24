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

  test('unload 幂等：重复卸载不报错、不重复调 howl.unload()', () => {
    const { engine } = loadEngine();
    const howl = engine.load({
      url: 'https://x/a.mp3',
      track: { id: 'a' },
      token: 1,
    });

    engine.unload(howl);
    engine.unload(howl);
    engine.unload();

    assert.deepStrictEqual(
      howl.calls.filter((call) => call === 'unload'),
      ['unload']
    );
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

  test('duration/position/rate 无 Howl 时返回默认值，有 Howl 时转发', () => {
    const { engine } = loadEngine();
    assert.strictEqual(engine.duration(), 0);
    assert.strictEqual(engine.position(), 0);
    assert.strictEqual(engine.rate(), 1);

    const howl = engine.load({
      url: 'https://x/a.mp3',
      track: { id: 'a' },
      token: 1,
    });
    howl._duration = 200;
    howl._pos = 10;

    assert.strictEqual(engine.duration(), 200);
    assert.strictEqual(engine.position(), 10);
    assert.strictEqual(engine.rate(), 1);
  });
});

describe('AudioEngine：音量/静音与定向卸载', () => {
  test('applyAudioState 先 Howler.mute 再 Howler.volume，并补写当前 Howl', () => {
    const { engine, howler } = loadEngine();
    const howl = engine.load({
      url: 'https://x/a.mp3',
      track: { id: 'a' },
      token: 1,
    });

    engine.applyAudioState({ volume: 0.4, muted: true });

    assert.deepStrictEqual(howler.muteCalls, [true]);
    assert.deepStrictEqual(howler.volumeCalls, [0.4]);
    assert.deepStrictEqual(howl.calls, [
      ['mute', true],
      ['volume', 1],
    ]);
  });

  test('applyAudioState 无当前 Howl 时只写 Howler 全局', () => {
    const { engine, howler } = loadEngine();

    engine.applyAudioState({ volume: 0.8, muted: false });

    assert.deepStrictEqual(howler.muteCalls, [false]);
    assert.deepStrictEqual(howler.volumeCalls, [0.8]);
  });

  test('unloadOtherThan 保留指定 Howl，unloadAll 清空且不派发事件', () => {
    const { engine, howler, events } = loadEngine();
    const first = engine.load({
      url: 'https://x/a.mp3',
      track: { id: 'a' },
      token: 1,
    });
    const trackB = { id: 'b' };
    const second = engine.load({
      url: 'https://x/b.mp3',
      track: trackB,
      token: 2,
    });

    engine.unloadOtherThan(second);

    assert.deepStrictEqual(howler._howls, [second]);
    assert.ok(first.calls.includes('unload'), '非保留的 Howl 应被卸载');
    assert.strictEqual(engine.currentHowl, second);
    assert.strictEqual(engine.currentTrack, trackB);

    engine.unloadAll();

    assert.strictEqual(howler._howls.length, 0);
    assert.strictEqual(engine.currentHowl, null);
    assert.strictEqual(engine.currentTrack, null);
    assert.strictEqual(events.length, 0, '卸载期间不应派发事件');
  });
});
