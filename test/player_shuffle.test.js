/**
 * 随机播放（shuffle）的行为测试。
 *
 * 被测对象是真实的 js/player_thread.js（经 test/helpers/player_harness.js 载入），
 * 断言只走公开入口：skip() / setNewPlaylist() / insertAudio() / loop_mode。
 * 仅"轮长/轮内进度"这一类内部调度参数直接读 _random_len / _random_steps。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert');
const { loadPlayerHarness } = require('./helpers/player_harness');

const harness = loadPlayerHarness();

/** 连续走 n 步，返回每次落到的曲目下标 */
function runSteps(player, steps, direction = 'next') {
  const visited = [];
  for (let i = 0; i < steps; i += 1) {
    player.skip(direction);
    visited.push(player.index);
  }
  return visited;
}

function collectTransitions(visited, from) {
  const pairs = new Set();
  let prev = from;
  visited.forEach((cur) => {
    pairs.add(`${prev}->${cur}`);
    prev = cur;
  });
  return pairs;
}

describe('随机播放的洗牌质量', () => {
  [2, 3, 4].forEach((length) => {
    test(`${length} 首时能出现全部 ${
      length * (length - 1)
    } 种相邻转移（不是固定循环）`, () => {
      const player = harness.createPlayer(harness.makeTracks(length), {
        loopMode: 2,
        index: 0,
      });

      const transitions = collectTransitions(runSteps(player, 4000), 0);

      assert.strictEqual(
        transitions.size,
        length * (length - 1),
        `相邻转移只出现了 ${[...transitions].sort().join(',')}`
      );
    });
  });

  test('6 首时长程出现次数均匀（每个转移都可复现的前提下不出现偏置）', () => {
    const length = 6;
    const steps = 12000;
    const player = harness.createPlayer(harness.makeTracks(length), {
      loopMode: 2,
      index: 0,
    });

    const counts = new Array(length).fill(0);
    runSteps(player, steps).forEach((index) => {
      counts[index] += 1;
    });

    const expected = steps / length;
    counts.forEach((count, index) => {
      assert.ok(
        Math.abs(count - expected) < expected * 0.15,
        `第 ${index} 首出现 ${count} 次，偏离期望 ${expected} 过多`
      );
    });
  });
});

describe('随机播放的半随机轮长', () => {
  test('每轮长度落在 [⌈l/2⌉, l] 且轮内不重复', () => {
    const length = 8;
    const minLength = Math.ceil(length / 2);
    const player = harness.createPlayer(harness.makeTracks(length), {
      loopMode: 2,
      index: 0,
    });

    const lengths = new Set();
    let playedInRound = new Set();

    for (let i = 0; i < 4000; i += 1) {
      player.skip('next');
      const { _random_len: roundLength } = player;

      assert.ok(
        Number.isInteger(roundLength) &&
          roundLength >= minLength &&
          roundLength <= length,
        `轮长应为 ${minLength}..${length} 的整数，实际 ${roundLength}`
      );

      // steps 回到 1 表示刚开新一轮（正向走位里它只递增）
      if (player._random_steps === 1) {
        playedInRound = new Set();
      }
      assert.ok(
        !playedInRound.has(player.index),
        `同一轮里重复播放了下标 ${player.index}`
      );
      playedInRound.add(player.index);

      lengths.add(roundLength);
    }

    assert.ok(
      lengths.size > 1,
      `轮长应当半随机，实际只出现 ${[...lengths].sort().join('/')}`
    );
  });

  test('相邻两首不重复', () => {
    const player = harness.createPlayer(harness.makeTracks(6), {
      loopMode: 2,
      index: 0,
    });

    let previous = 0;
    runSteps(player, 4000).forEach((index) => {
      assert.notStrictEqual(index, previous, '随机播放不应连续播放同一首');
      previous = index;
    });
  });

  test('prev 之后再 next 回到原来那首', () => {
    const player = harness.createPlayer(harness.makeTracks(7), {
      loopMode: 2,
      index: 0,
    });

    for (let i = 0; i < 300; i += 1) {
      player.skip('next');
      const current = player.index;
      player.skip('prev');
      player.skip('next');
      assert.strictEqual(player.index, current);
    }
  });
});

describe('随机序列的失效与重建', () => {
  test('随机模式下 setNewPlaylist 从随机一首开始', () => {
    const length = 5;
    const starts = new Set();

    for (let i = 0; i < 200; i += 1) {
      const player = harness.createPlayer([], { loopMode: 2 });
      player.setNewPlaylist(harness.makeTracks(length));
      starts.add(player.index);
    }

    assert.deepStrictEqual(
      [...starts].sort((a, b) => a - b),
      Array.from({ length }, (_v, i) => i),
      `随机模式下的起始曲只覆盖了下标 ${[...starts].sort().join(',')}`
    );
  });

  test('顺序模式下 setNewPlaylist 仍从第 0 首开始', () => {
    const player = harness.createPlayer([], { loopMode: 0 });
    player.setNewPlaylist(harness.makeTracks(5));
    assert.strictEqual(player.index, 0);
  });

  test('顺序↔随机来回切换会重新洗牌，且不换掉当前曲目', () => {
    const length = 6;
    const trials = 120;
    let unchanged = 0;

    for (let i = 0; i < trials; i += 1) {
      const player = harness.createPlayer(harness.makeTracks(length), {
        loopMode: 2,
        index: 0,
      });
      const before = runSteps(player, length);
      const current = player.index;

      player.loop_mode = 0;
      player.loop_mode = 2;

      assert.strictEqual(player.index, current, '切换播放模式不应更换当前曲目');

      if (runSteps(player, length).join(',') === before.join(',')) {
        unchanged += 1;
      }
    }

    assert.ok(
      unchanged < trials * 0.3,
      `切回随机后仍沿用旧顺序的次数过多：${unchanged}/${trials}`
    );
  });

  test('同长度换歌单后随机顺序重新洗过（不沿用旧袋子）', () => {
    const length = 6;
    const trials = 120;
    let unchanged = 0;

    for (let i = 0; i < trials; i += 1) {
      const player = harness.createPlayer(harness.makeTracks(length, 'a'), {
        loopMode: 2,
        index: 0,
      });
      const before = runSteps(player, length);
      // setNewPlaylist 在随机模式下会随机选起始曲；这里把下标对齐到同一位置，
      // 单独隔离"袋子有没有重建"这一个变量
      const position = player.index;

      player.setNewPlaylist(harness.makeTracks(length, 'b'));
      player.index = position;

      if (runSteps(player, length).join(',') === before.join(',')) {
        unchanged += 1;
      }
    }

    assert.ok(
      unchanged < trials * 0.3,
      `换歌单后仍沿用旧顺序的次数过多：${unchanged}/${trials}`
    );
  });
});

describe('非随机模式与边界', () => {
  test('顺序模式仍是循环的上一首/下一首', () => {
    const player = harness.createPlayer(harness.makeTracks(4), {
      loopMode: 0,
      index: 0,
    });

    assert.deepStrictEqual(runSteps(player, 5), [1, 2, 3, 0, 1]);
    player.skip('prev');
    assert.strictEqual(player.index, 0);
    player.skip('prev');
    assert.strictEqual(player.index, 3);
  });

  test('空歌单与越界下标下 skip 不抛异常', () => {
    const empty = harness.createPlayer([], { loopMode: 2, index: -1 });
    assert.doesNotThrow(() => empty.skip('next'));
    assert.doesNotThrow(() => empty.skip('prev'));

    const player = harness.createPlayer(harness.makeTracks(4), {
      loopMode: 2,
      index: -1,
    });
    assert.doesNotThrow(() => player.skip('next'));
    assert.ok(
      player.index >= 0 && player.index < 4,
      `落点下标应在 [0, 4) 内，实际 ${player.index}`
    );
  });

  test('insertAudio 带下标时插入曲目本身、生效于 0 且保住当前曲目', () => {
    const player = harness.createPlayer(harness.makeTracks(3), {
      loopMode: 0,
      index: 2,
    });
    const moving = { id: 'x', title: 'x', artist: 'a', source: 'test' };

    player.insertAudio(moving, 1);

    assert.strictEqual(player.playlist.length, 4);
    assert.ok(
      !Array.isArray(player.playlist[1]),
      '插入的必须是曲目对象，而不是被包了一层的数组'
    );
    assert.strictEqual(player.playlist[1].id, 'x');
    assert.strictEqual(
      player.playlist[player.index].id,
      't2',
      '插入到当前曲目之前时，当前曲目不应被换掉'
    );

    player.insertAudio({ id: 'y', title: 'y', artist: 'a', source: 'test' }, 0);
    assert.strictEqual(player.playlist[0].id, 'y', 'idx 为 0 时应插到最前');

    const lengthBefore = player.playlist.length;
    player.insertAudio(
      { id: 't0', title: 't0', artist: 'a', source: 'test' },
      0
    );
    assert.strictEqual(
      player.playlist.length,
      lengthBefore,
      '重复曲目应被忽略'
    );
  });
});
