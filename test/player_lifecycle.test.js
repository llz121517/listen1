/**
 * PlayerCore 的切歌 / 取地址 / 媒体会话生命周期测试。
 * 覆盖 spec §8 的 8 个场景 + URL 缓存复用 + 列表编辑期间取地址。
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

    // 过期 URL 仍然进缓存：再切回 t0 时不需要重新取地址
    player.skip('prev');
    assert.strictEqual(host.requests.length, 2);
    assert.strictEqual(howler._howls[0].options.src[0], 'test://t0.mp3');
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
    assert.strictEqual(
      success[success.length - 1].data.url,
      'test://t1.mp3',
      '旧负载里的 url 字段要保持'
    );
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
  test('pause 后 URL 返回不自动播放，也不留下不播的 Howl', () => {
    const { player, host, howler } = harness.createPlayer(makeTracks(3));

    player.play();
    player.pause();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });

    assert.strictEqual(
      howler._howls.length,
      0,
      '不播放的 Howl 应卸载，避免音频元素/网络连接累积'
    );
    assert.strictEqual(player.playing, false);

    // 地址已进缓存：之后再播会用缓存重建 Howl，不再取地址
    player.play();
    assert.strictEqual(howler._howls.length, 1);
    assert.strictEqual(host.requests.length, 1);
    assert.strictEqual(player.playing, true);
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

    // 真实 Howler 播完后 playing() 为 false，这里同步模拟
    howler._howls[0]._playing = false;
    howler._howls[0].options.onend();

    assert.strictEqual(host.requests.length, requestsBefore);
    assert.strictEqual(player.index, 0);
    assert.strictEqual(howler._howls[0].playing(), true);
  });
});

describe('PlayerCore：独立审查发现的回归用例', () => {
  const playingEvents = (host) =>
    host.sent.filter(
      (msg) =>
        msg.type === 'BG_PLAYER:PLAY_STATE' && msg.data.reason === 'Playing'
    ).length;

  test('播放中再次 play / playById(当前曲目) 不新增 Howl、不重复 Playing 事件', () => {
    const { player, host, howler } = harness.createPlayer(makeTracks(3));

    player.play();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });
    assert.strictEqual(howler._howls.length, 1);
    const howl = howler._howls[0];
    const before = playingEvents(host);
    const playCallsBefore = howl.playCalls;

    player.playById('t0');
    player.play();

    assert.strictEqual(
      howl.playCalls,
      playCallsBefore,
      '正在播放时不应再次调用 Howl.play()（Howler 会新建 sound 造成双声）'
    );
    assert.strictEqual(howler._howls.length, 1);
    assert.strictEqual(playingEvents(host), before);
    assert.strictEqual(player.playing, true);
  });

  test('当前曲目 onplayerror：补发 isPlaying=false、paused，并广播 FAIL_ALL', () => {
    const { player, host, mediaSession, howler } = harness.createPlayer(
      makeTracks(1)
    );

    player.play();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });
    howler._howls[0].options.onplayerror(0, { code: 2 });

    const playStates = host.sent.filter(
      (msg) => msg.type === 'BG_PLAYER:PLAY_STATE'
    );
    assert.strictEqual(
      playStates[playStates.length - 1].data.isPlaying,
      false,
      '失败后 UI 的 isPlaying 不能卡在 true'
    );
    const states = mediaSession.calls.filter(
      (call) => call.type === 'playbackState'
    );
    assert.strictEqual(states[states.length - 1].state, 'paused');
    assert.ok(
      host.sent.some((msg) => msg.type === 'BG_PLAYER:RETRIEVE_URL_FAIL_ALL')
    );
    assert.strictEqual(player.playing, false);
    assert.strictEqual(howler._howls.length, 0);
  });

  test('loadById(未知 id) 保持旧实现的 no-op，不补发 LOAD', () => {
    const { player, host } = harness.createPlayer(makeTracks(3));
    const loads = () =>
      host.sent.filter((msg) => msg.type === 'BG_PLAYER:LOAD').length;
    const before = loads();

    player.loadById('missing-id');

    assert.strictEqual(loads(), before);
    assert.strictEqual(player.index, 0);
  });

  test('删除未在播放的当前曲目后媒体会话切到新的当前曲目', () => {
    const { player, mediaSession } = harness.createPlayer(makeTracks(3), {
      index: 1,
    });

    player.removeAudio(1);

    const setTracks = mediaSession.calls.filter(
      (call) => call.type === 'setTrack'
    );
    assert.ok(setTracks.length >= 1);
    assert.strictEqual(
      setTracks[setTracks.length - 1].id,
      player.currentAudio.id
    );
    const states = mediaSession.calls.filter(
      (call) => call.type === 'playbackState'
    );
    assert.strictEqual(states[states.length - 1].state, 'paused');
  });

  test('删除最后一首正在播放的曲目：清 metadata 并补发 isPlaying=false', () => {
    const { player, host, mediaSession, howler } = harness.createPlayer(
      makeTracks(1)
    );

    player.play();
    resolveUrl(host, 0, { url: 'test://t0.mp3' });
    player.removeAudio(0);

    assert.strictEqual(player.playlist.length, 0);
    assert.ok(
      mediaSession.calls.some((call) => call.type === 'clearTrack'),
      '没有下一首时清空 mediaSession metadata'
    );
    const states = mediaSession.calls.filter(
      (call) => call.type === 'playbackState'
    );
    assert.strictEqual(states[states.length - 1].state, 'none');
    const playStates = host.sent.filter(
      (msg) => msg.type === 'BG_PLAYER:PLAY_STATE'
    );
    assert.strictEqual(playStates[playStates.length - 1].data.isPlaying, false);
    assert.strictEqual(howler._howls.length, 0);
  });

  test('RETRIEVE_URL_FAIL 负载保留 playNow 字段', () => {
    const { player, host } = harness.createPlayer(makeTracks(2));

    player.play();
    resolveUrl(host, 0, null);

    const fails = host.sent.filter(
      (msg) => msg.type === 'BG_PLAYER:RETRIEVE_URL_FAIL'
    );
    assert.strictEqual(fails[fails.length - 1].data.playNow, true);
  });
});
