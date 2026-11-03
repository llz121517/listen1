/* eslint-disable no-underscore-dangle */
// eslint-disable-next-line no-unused-vars
class PlaylistModel {
  constructor(list = []) {
    this._tracks = [];
    this._index = -1;
    this._loopMode = 0;
    this.resetRandomState();
    if (Array.isArray(list) && list.length > 0) {
      this.setList(list);
    }
  }

  get length() {
    return this._tracks.length;
  }

  get index() {
    return this._index;
  }

  set index(value) {
    this._index = value;
  }

  get current() {
    return this._tracks[this._index];
  }

  get tracks() {
    return this._tracks;
  }

  get loopMode() {
    return this._loopMode;
  }

  set loopMode(value) {
    if (value === this._loopMode) return;
    this._loopMode = value;
    // 换播放模式后旧洗牌顺序作废：切进随机要重新洗牌，切出去也不必留着
    this.resetRandomState();
  }

  findIndexById(id) {
    return this._tracks.findIndex((track) => track.id === id);
  }

  /**
   * 替换整个列表；随机状态作废。
   * @param {Array} list 曲目数组
   * @param {{index?: Number}} [options] 目标下标；越界/缺省时退回 0
   */
  setList(list, options = {}) {
    this._tracks = Array.isArray(list) ? list.slice() : [];
    this.resetRandomState();
    const { index } = options;
    if (this._tracks.length === 0) {
      this._index = -1;
    } else if (
      typeof index === 'number' &&
      index >= 0 &&
      index < this._tracks.length
    ) {
      this._index = index;
    } else {
      this._index = 0;
    }
    return this._tracks;
  }

  static array_move(arr, oldIndex, newIndex) {
    // https://stackoverflow.com/questions/5306680/move-an-array-element-from-one-array-position-to-another
    if (newIndex >= arr.length) {
      let k = newIndex - arr.length + 1;
      while (k > 0) {
        k -= 1;
        arr.push(undefined);
      }
    }
    arr.splice(newIndex, 0, arr.splice(oldIndex, 1)[0]);
    return arr;
  }

  /**
   * 插入曲目（按 id 去重）；插到当前曲目之前时按 id 找回当前下标。
   * @returns {Number} 新下标；重复曲目返回 -1
   */
  insert(track, at) {
    if (!track || this.findIndexById(track.id) >= 0) return -1;
    const originTrack = this.current;
    let insertedIndex;
    if (typeof at === 'number' && at >= 0 && at < this._tracks.length) {
      this._tracks.splice(at, 0, track);
      insertedIndex = at;
    } else {
      this._tracks.push(track);
      insertedIndex = this._tracks.length - 1;
    }
    const originIndex = originTrack ? this.findIndexById(originTrack.id) : -1;
    if (originIndex >= 0) {
      this._index = originIndex;
    }
    this.resetRandomState();
    return insertedIndex;
  }

  /**
   * 把已在列表里的曲目挪到目标曲目之前（top）或之后（bottom）。
   * @returns {Number} 新下标；定位失败返回 -1
   */
  insertByDirection(track, target, direction) {
    const trackIndex = this.findIndexById(track && track.id);
    const insertIndex = this.findIndexById(target && target.id);
    if (trackIndex < 0 || insertIndex < 0 || trackIndex === insertIndex) {
      return -1;
    }
    const originTrack = this.current;
    const targetIndex =
      insertIndex > trackIndex ? insertIndex - 1 : insertIndex;
    const offset = direction === 'top' ? 0 : 1;
    this._tracks = PlaylistModel.array_move(
      this._tracks,
      trackIndex,
      targetIndex + offset
    );
    const originIndex = originTrack ? this.findIndexById(originTrack.id) : -1;
    if (originIndex >= 0) {
      this._index = originIndex;
    }
    this.resetRandomState();
    return targetIndex + offset;
  }

  /**
   * 删除曲目：当前曲目被删时下标就近收敛（旧实现语义）。
   * @returns {Object|null} 被删曲目；非法下标返回 null
   */
  remove(at) {
    if (!this._tracks[at]) return null;
    const removed = this._tracks[at];
    const currentId = this.current ? this.current.id : undefined;
    this._tracks.splice(at, 1);
    this.resetRandomState();
    if (this._tracks.length === 0) {
      this._index = -1;
      return removed;
    }
    const foundIndex =
      currentId === undefined ? -1 : this.findIndexById(currentId);
    if (foundIndex >= 0) {
      this._index = foundIndex;
    } else {
      this._index = at >= this._tracks.length ? this._tracks.length - 1 : at;
    }
    return removed;
  }

  /**
   * 随机播放的洗牌袋：长度 2l，前半是本轮播放顺序（值为曲目下标），
   * 后半是逆映射（[l + 下标] = 它在本轮里的位置），走位靠它 O(1) 计算。
   * 用标准 Fisher–Yates（j ∈ [0, i]）保证 l! 种顺序等概率；少取一项（j ∈ [0, i-1]，
   * 即"不和自己交换"）会让可达顺序退化成 (l-1)! 种，短歌单下随机播放会变成固定循环。
   */
  static buildShuffleBag(l) {
    const order = Array.from({ length: l }, (_v, i) => i);
    for (let i = l - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const swap = order[i];
      order[i] = order[j];
      order[j] = swap;
    }
    const bag = order.concat(new Array(l).fill(0));
    order.forEach((trackIndex, position) => {
      bag[l + trackIndex] = position;
    });
    return bag;
  }

  /**
   * 本轮长度：半随机 —— 至少半张表，至多整张表。
   * 轮长不满 l 时"刚播完的那首"天然落在本轮之外（它就在锚位上），
   * 于是既不会跨轮连播同一首，轮末那首也不会被同一首长期占住。
   */
  static randomRoundLength(l) {
    const minLength = Math.max(1, Math.ceil(l / 2));
    return minLength + Math.floor(Math.random() * (l - minLength + 1));
  }

  /**
   * 开一轮新的随机播放：重洗，并把当前曲目放在锚位（本轮从锚位之后开始走）。
   * @param {Number} originIndex 当前曲目下标；不在范围内表示没有正在播的曲目
   */
  startRandomRound(originIndex) {
    const l = this._tracks.length;
    const bag = PlaylistModel.buildShuffleBag(l);
    const originInRange = originIndex >= 0 && originIndex < l;
    this._random_playlist = bag;
    this._random_anchor = originInRange ? bag[l + originIndex] : l - 1;
    this._random_steps = 0;
    this._random_len = PlaylistModel.randomRoundLength(l);
  }

  /** 丢掉随机播放状态：下一次随机走位会重新洗牌。 */
  resetRandomState() {
    this._random_playlist = [];
    this._random_anchor = -1;
    this._random_steps = 0;
    this._random_len = 0;
  }

  /**
   * 计算方向上的目标下标（不修改 this.index）。
   * @param {'next'|'prev'|'random'} direction
   * @returns {Number} 目标下标；空列表时返回原下标
   */
  nextIndex(direction) {
    const idx = this._index;
    const l = this._tracks.length;
    // 空歌单：没有可走位的位置
    if (l === 0) return idx;

    const indexInRange = idx >= 0 && idx < l;
    const randomMode = this._loopMode === 2 || direction === 'random';

    if (!randomMode) {
      if (this._random_playlist.length !== 0) {
        this.resetRandomState();
      }
      if (!indexInRange) return direction === 'prev' ? l - 1 : 0;
      return direction === 'prev' ? (idx - 1 + l) % l : (idx + 1) % l;
    }

    if (!indexInRange) {
      // 没有正在播的曲目：开一轮新的，从新顺序的头 / 尾进入
      this.startRandomRound(-1);
      this._random_steps = direction === 'prev' ? 0 : 1;
      return this._random_playlist[direction === 'prev' ? l - 1 : 0];
    }

    const bagMissing = this._random_playlist.length / 2 !== l;
    if (
      bagMissing ||
      (direction !== 'prev' && this._random_steps >= this._random_len)
    ) {
      // 没洗过牌 / 歌单变了 / 本轮已播完：换一轮新顺序
      this.startRandomRound(idx);
    }

    if (direction === 'prev') {
      this._random_steps = Math.max(this._random_steps - 1, -1);
    } else {
      this._random_steps += 1;
    }
    const position = (this._random_anchor + this._random_steps + l) % l;

    return this._random_playlist[position];
  }
}
