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
      ['t0', 't1', 't2', 't3']
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
      // bag 来自 vm 沙箱，跨 realm；展开到本 realm 再比较，原型才一致
      assert.deepStrictEqual(
        [...order].sort((a, b) => a - b),
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
