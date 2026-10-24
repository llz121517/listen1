/**
 * MediaSessionController 单测：action handler 注册、metadata 写入、位置状态守卫。
 * navigator.mediaSession 用 stub 代替，MediaMetadata 用记录构造参数的假类。
 */
/* global structuredClone */
const { describe, test } = require('node:test');
const assert = require('node:assert');
const { loadScripts, globalValue } = require('./helpers/player_vm');

// vm 沙箱里创建的对象原型来自另一个 realm，deepStrictEqual 会因原型不同失败，
// 这里克隆回当前 realm 再比较。
const plain = (value) => structuredClone(value);

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
    assert.deepStrictEqual(plain(mediaSession.metadata.init.artwork), [
      { src: 'https://x/cover.jpg', sizes: '500x500' },
    ]);

    controller.setTrack({ id: 'ne2', title: 't2', artist: 'a2' });
    assert.deepStrictEqual(plain(mediaSession.metadata.init.artwork), []);
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
    assert.deepStrictEqual(plain(mediaSession.positionStates), [
      { duration: 30, playbackRate: 2, position: 30 },
      { duration: 30, playbackRate: 1, position: 0 },
    ]);
  });
});
