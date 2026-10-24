/**
 * createPlayerHost 单测：MediaService 直连分支（front/Electron）与
 * 无 MediaService 时立即判失败的分支（Firefox MV2 后台页没有服务层脚本）。
 */
/* global structuredClone */
const { describe, test } = require('node:test');
const assert = require('node:assert');
const { loadScripts, globalValue } = require('./helpers/player_vm');

// vm 沙箱里创建的对象原型来自另一个 realm，deepStrictEqual 会因原型不同失败，
// 这里克隆回当前 realm 再比较。
const plain = (value) => structuredClone(value);

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

    assert.deepStrictEqual(plain(sent), [
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
