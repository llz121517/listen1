/* eslint-disable no-underscore-dangle */
/* eslint-disable no-param-reassign */
/* global AudioEngine MediaSessionController PlaylistModel */

/**
 * 播放器编排层：播放列表、随机走位、取地址会话（代际 token）、
 * 音频引擎事件与媒体会话。对外接口与旧 Player 同名同义。
 */
// eslint-disable-next-line no-unused-vars
class PlayerCore {
  constructor({ host, engine, mediaSession, playlistModel } = {}) {
    this._host = host;
    this._generation = 0;
    this._session = null;
    this._media_uri_list = {};
    this._loop_mode = 0;
    this._volume = 1;
    this._muted = false;
    this._advancing = false;
    this._skipPending = false;
    this.playedFrom = 0;
    this.mode = 'background';
    this.skipTime = 15;
    this.refreshTimer = null;

    this.playlistModel = playlistModel || new PlaylistModel();
    this._engine =
      engine ||
      new AudioEngine({
        onEvent: (event) => this._handleAudioEvent(event),
      });
    this._mediaSession =
      mediaSession ||
      new MediaSessionController({
        onPlay: () => this.play(),
        onPause: () => this.pause(),
        onNext: () => {
          this.skip('next');
          this.sendFrameUpdate();
        },
        onPrev: () => {
          this.skip('prev');
          this.sendFrameUpdate();
        },
        onSeek: (details) => {
          this.seekTime(details.seekTime);
          this.sendFrameUpdate();
        },
        onSeekForward: (details) => {
          this.seekBy(details.seekOffset || this.skipTime);
          this.sendFrameUpdate();
        },
        onSeekBackward: (details) => {
          this.seekBy(-(details.seekOffset || this.skipTime));
          this.sendFrameUpdate();
        },
      });
  }

  // ---- 数据与查询 ----

  get playlist() {
    return this.playlistModel.tracks;
  }

  get index() {
    return this.playlistModel.index;
  }

  set index(value) {
    this.playlistModel.index = value;
  }

  get currentAudio() {
    return this.playlistModel.current;
  }

  get currentHowl() {
    const howl = this._engine.currentHowl;
    // 取地址窗口里 engine 的当前 Howl 还是上一首：只有它对应的曲目就是当前曲目才算当前，
    // 否则 seek* / sendFrameUpdate 会误操作上一首
    if (!howl || this._engine.currentTrack !== this.currentAudio) return null;
    return howl;
  }

  get playing() {
    const { currentHowl } = this;
    return currentHowl ? currentHowl.playing() : false;
  }

  get muted() {
    return this._muted;
  }

  get volume() {
    return this._volume;
  }

  get loop_mode() {
    return this._loop_mode;
  }

  set loop_mode(input) {
    const LOOP_MODE = {
      all: 0,
      one: 1,
      shuffle: 2,
    };
    let myMode = 0;
    if (typeof input === 'string') {
      myMode = LOOP_MODE[input];
    } else {
      myMode = input;
    }
    if (!Object.values(LOOP_MODE).includes(myMode)) return;
    if (myMode === this._loop_mode) return;
    this._loop_mode = myMode;
    // 同步给列表模型：随机走位要用；换模式本身会作废旧洗牌顺序
    this.playlistModel.loopMode = myMode;
  }

  getAudioState() {
    return {
      volume: Math.round(this._volume * 100),
      muted: this._muted,
    };
  }

  // ---- 运行时 ----

  setMode(newMode) {
    if (this.mode === newMode) return;
    this.mode = newMode;
    if (this._host) {
      this._host.mode = newMode;
      // READY 在模式确定后才发得出去（旧实现用顶层 this.mode，永远发不出）
      this._host.send('BG_PLAYER:READY');
    }
  }

  setRefreshRate(rate = 10) {
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      if (this.playing) {
        this.sendFrameUpdate();
      }
    }, 1000 / rate);
  }

  // ---- load session ----

  _beginSession(index, playNow) {
    const track = this.playlistModel.tracks[index];
    if (!track) return null;
    this._generation += 1;
    const token = this._generation;
    this._session = {
      token,
      index,
      trackId: track.id,
      playNow: !!playNow,
      pending: true,
    };
    this.playlistModel.index = index;
    // 切歌瞬间就把媒体会话切到新曲目：系统控件不会因等待取地址而消失或不更新
    this._mediaSession.setTrack(track);
    this._mediaSession.setPlaybackState('paused');
    // 旧音频只暂停、保留元素与媒体会话，等新曲真正开播后再定向卸载
    this._engine.pause();
    // 旧 Howl 的 pause/stop 事件会因代际过期被丢弃，UI 的 isPlaying 必须由这里补发
    this.sendPlayingEvent('Paused');
    this.sendLoadEvent();
    return token;
  }

  _startSession(index, playNow) {
    const track = this.playlistModel.tracks[index];
    if (!track) return;
    const token = this._beginSession(index, playNow);
    if (token === null) return;
    const cached = this._media_uri_list[track.id];
    if (cached && cached.url) {
      // 缓存命中：仍是新会话、新 Howl，只是不再向 provider 重复取地址；
      // 已有 bitrate/platform 由 track 带过去，不会被抹成 undefined
      this._finishLoad(
        token,
        {
          url: cached.url,
          bitrate: track.bitrate,
          platform: track.platform,
        },
        track
      );
      return;
    }
    this._host.resolveUrl(track, (bootinfo) => {
      this._handleUrlResult(token, track, bootinfo);
    });
  }

  _finishLoad(token, bootinfo, track) {
    const session = this._session;
    if (!session || session.token !== token) return;
    // 等待取地址期间列表可能增删：按 trackId 重新定位，不能用 session.index
    const index = this.playlistModel.findIndexById(session.trackId);
    if (index < 0) {
      // 目标曲目已被删除：作废这一代，迟到的 URL 不会再串到别的曲目上
      this._generation += 1;
      this._session = null;
      return;
    }
    this.playlistModel.index = index;
    // 缓存重放时 bootinfo.bitrate / platform 可能缺失：只在有值时覆盖，不能抹掉已有值
    if (bootinfo.bitrate !== undefined) track.bitrate = bootinfo.bitrate;
    if (bootinfo.platform !== undefined) track.platform = bootinfo.platform;
    this.setMediaURI(
      {
        url: bootinfo.url,
        bitrate: track.bitrate,
        platform: track.platform,
      },
      track.id
    );
    this.setAudioDisabled(false, index);
    const howl = this._engine.load({ url: bootinfo.url, track, token });
    track.howl = howl;
    this._host.send('BG_PLAYER:RETRIEVE_URL_SUCCESS', {
      ...track,
      howl: undefined,
      index,
      playNow: session.playNow,
      url: bootinfo.url,
    });
    session.pending = false;
    if (session.playNow) {
      this._engine.play();
    } else {
      // 等待取地址期间用户按了暂停：不要留下一个不播的 Howl（音频元素/网络连接会累积），
      // 地址仍在缓存里，下次 play() 会用缓存重新建 Howl
      this._engine.unload(howl);
      track.howl = null;
    }
  }

  _handleUrlResult(token, track, bootinfo) {
    const session = this._session;
    if (!session || session.token !== token) {
      // 过期会话：只缓存地址，不建 Howl、不播放、不改状态
      if (bootinfo && bootinfo.url) {
        this.setMediaURI({ url: bootinfo.url }, track.id);
      }
      return;
    }
    if (!bootinfo || !bootinfo.url) {
      this._handleUrlFailure(token, track);
      return;
    }
    this._finishLoad(token, bootinfo, track);
  }

  _handleUrlFailure(token, track) {
    const session = this._session;
    if (!session || session.token !== token) return;
    const { playNow } = session;
    this._session = null;
    const index = this.playlistModel.findIndexById(track.id);
    if (index >= 0) this.setAudioDisabled(true, index);
    this._host.send('BG_PLAYER:RETRIEVE_URL_FAIL', {
      ...track,
      howl: undefined,
      index,
      playNow,
    });
    this._advanceAfterFailure();
  }

  /**
   * URL 失败后跳到下一首。同步回调（测试 / 本地缓存）会让 skip 递归回到这里，
   * 用 _advancing + _skipPending 摊平成循环，避免调用栈随曲目数增长。
   */
  _advanceAfterFailure() {
    if (this._advancing) {
      this._skipPending = true;
      return;
    }
    this._advancing = true;
    try {
      let pending = true;
      while (pending) {
        this._skipPending = false;
        this.skip('next');
        pending = this._skipPending;
      }
    } finally {
      this._advancing = false;
    }
  }

  _handleEnded() {
    switch (this._loop_mode) {
      case 2:
        this.skip('random');
        break;
      case 1:
        this.play();
        break;
      case 0:
      default:
        this.skip('next');
        break;
    }
  }

  _unloadOthers(keepHowl) {
    this._engine.unloadOtherThan(keepHowl);
    this.playlistModel.tracks.forEach((track) => {
      if (track.howl && track.howl !== keepHowl) {
        track.howl = null;
      }
    });
  }

  _handleAudioEvent({ type, token, howl, track, error }) {
    if (!token || token !== this._generation) {
      // 过期代际的事件：只清理这个已被弃用的 Howl，其余一概不采纳
      if (howl && howl !== this._engine.currentHowl) {
        this._engine.unload(howl);
      }
      return;
    }
    switch (type) {
      case 'playing': {
        // 兜底：Howler 的 HTML5 音频池释放节点时不重置 muted，play 分支又会把旧的
        // node.muted 一起 OR 进去；这里（playHtml5 写完 muted/volume 之后）重放一次
        // 权威状态，把节点的 muted 与 volume 纠正过来。
        this.applyAudioState();
        if (track) track.disabled = false;
        // Date.now() 返回毫秒时间戳，转成秒供 Last.fm scrobble 用
        this.playedFrom = Math.round(Date.now() / 1000);
        this._mediaSession.setPlaybackState('playing');
        this._unloadOthers(howl);
        this.sendPlayingEvent('Playing');
        break;
      }
      case 'loaded': {
        if (track) track.disabled = false;
        this.sendPlayingEvent('Loaded');
        break;
      }
      case 'paused': {
        this._mediaSession.setPlaybackState('paused');
        this.sendPlayingEvent('Paused');
        break;
      }
      case 'stopped': {
        this.sendPlayingEvent('Stopped');
        break;
      }
      case 'ended': {
        this._handleEnded();
        this.sendPlayingEvent('Ended');
        break;
      }
      case 'error': {
        this._handleAudioError(track, howl, error);
        break;
      }
      default:
        break;
    }
  }

  _handleAudioError(track, howl, error) {
    this._host.send('BG_PLAYER:PLAY_FAILED', error);
    if (track) track.disabled = true;
    this.sendPlayingEvent('err');
    this._engine.unload(howl);
    if (track) {
      track.howl = null;
      // 清掉地址缓存：这个地址已经播不了，下次不能再命中
      delete this._media_uri_list[track.id];
    }
    const index = track ? this.playlistModel.findIndexById(track.id) : -1;
    if (index >= 0) this.setAudioDisabled(true, index);
    this._session = null;
    // 失败时 engine 已没有当前 Howl（unload 期间的 stop 事件被抑制），必须自己把播放状态补成
    // false：否则单曲歌单 / 全部曲目都不可播时 UI 的 isPlaying 会永久卡在 true
    this._mediaSession.setPlaybackState('paused');
    this.sendPlayingEvent('Stopped');
    this._advanceAfterFailure();
  }

  // ---- 播放控制 ----

  play(idx) {
    const model = this.playlistModel;
    if (model.length === 0) return;
    let index = typeof idx === 'number' ? idx : model.index;
    if (index < 0) index = model.index;
    if (!model.tracks[index]) index = 0;
    const track = model.tracks[index];
    const howl = this.currentHowl;
    // 当前曲目已经加载好、只是暂停：直接接着播（不重开 session、不重复取地址）
    if (
      index === model.index &&
      this._media_uri_list[track.id] &&
      howl &&
      track.howl === howl
    ) {
      this.sendLoadEvent();
      // 正在播放时再点同一首是 no-op：Howler 的 Howl.play() 在 sound 仍在播时会新建一个
      // sound，直接调用会造成同一首歌两个音轨同时出声
      if (!this.playing) {
        this._engine.play();
      }
      return;
    }
    this._startSession(index, true);
  }

  playById(id) {
    const index = this.playlistModel.findIndexById(id);
    this.play(index < 0 ? undefined : index);
  }

  load(idx) {
    const model = this.playlistModel;
    if (model.length === 0) return;
    let index = typeof idx === 'number' ? idx : model.index;
    if (index < 0) return;
    if (!model.tracks[index]) index = 0;
    const track = model.tracks[index];
    // 只选曲、不取地址：作废等待中的会话
    this._generation += 1;
    this._session = null;
    model.index = index;
    this._mediaSession.setTrack(track);
    this._mediaSession.setPlaybackState('paused');
    this._engine.pause();
    // 旧实现靠卸载 Howl 的 stop 事件通知 UI；现在 stop 事件会因代际过期被丢弃，必须自己补发
    this.sendPlayingEvent('Stopped');
    this.sendLoadEvent();
  }

  loadById(id) {
    const index = this.playlistModel.findIndexById(id);
    // 与旧实现一致：id 不在列表里是 no-op，不要退化成「选中当前曲目」再发一轮 LOAD
    if (index < 0) return;
    this.load(index);
  }

  pause() {
    if (this._session && this._session.pending) {
      // 等待取地址期间按了暂停：URL 回来后不要自动播放
      this._session.playNow = false;
    }
    const { currentHowl } = this;
    if (!currentHowl) {
      if (this._mediaSession.supported) {
        this._mediaSession.setPlaybackState('paused');
      }
      return;
    }
    this._engine.pause();
  }

  skip(direction) {
    const model = this.playlistModel;
    if (model.length === 0) {
      this._engine.pause();
      // 没有可播曲目：把播放状态补成 false，否则 UI 的 isPlaying 会卡在 true
      this._mediaSession.setPlaybackState('paused');
      this._host.send('BG_PLAYER:RETRIEVE_URL_FAIL_ALL');
      this.sendPlayingEvent('Stopped');
      this.sendLoadEvent();
      return;
    }
    model.index = model.nextIndex(direction);
    let tryCount = 0;
    while (tryCount < model.length && this._isDisabled(model.index)) {
      model.index = model.nextIndex(direction);
      tryCount += 1;
    }
    if (tryCount >= model.length) {
      this._engine.pause();
      // 没有可播曲目：把播放状态补成 false，否则 UI 的 isPlaying 会卡在 true
      this._mediaSession.setPlaybackState('paused');
      this._host.send('BG_PLAYER:RETRIEVE_URL_FAIL_ALL');
      this.sendPlayingEvent('Stopped');
      this.sendLoadEvent();
      return;
    }
    this._startSession(model.index, true);
  }

  _isDisabled(index) {
    const track = this.playlistModel.tracks[index];
    return !track || track.disabled;
  }

  stopAll() {
    this.playlistModel.tracks.forEach((track) => {
      if (track.howl) {
        track.howl.stop();
      }
    });
  }

  seek(per) {
    const { currentHowl } = this;
    if (!currentHowl) return;
    const duration = currentHowl.duration();
    if (!(duration > 0)) return;
    this._engine.seek(duration * per);
  }

  seekTime(seconds) {
    if (!this.currentHowl) return;
    this._engine.seek(seconds);
  }

  seekBy(delta) {
    const { currentHowl } = this;
    if (!currentHowl) return;
    const duration = currentHowl.duration();
    const target = currentHowl.seek() + delta;
    const position =
      duration > 0
        ? Math.min(Math.max(target, 0), duration)
        : Math.max(target, 0);
    this._engine.seek(position);
  }

  // ---- 播放列表编辑 ----

  insertAudio(audio, idx) {
    const insertedIndex = this.playlistModel.insert(
      {
        ...audio,
        disabled: false, // avoid first time load block
        howl: null,
      },
      idx
    );
    if (insertedIndex < 0) return -1;
    this.sendPlaylistEvent();
    this.sendLoadEvent();
    return insertedIndex;
  }

  insertAudioByDirection(audio, toAudio, direction) {
    const insertedIndex = this.playlistModel.insertByDirection(
      audio,
      toAudio,
      direction
    );
    if (insertedIndex < 0) return -1;
    this.sendPlaylistEvent();
    this.sendLoadEvent();
    return insertedIndex;
  }

  removeAudio(idx) {
    const model = this.playlistModel;
    if (!model.tracks[idx]) return;
    const target = model.tracks[idx];
    // 动列表前先作废指向被删曲目的 pending 会话，否则 URL 回来会串到别的曲目上
    if (this._session && this._session.trackId === target.id) {
      this._generation += 1;
      this._session = null;
    }
    const wasPlaying = this.playing;
    const currentId = this.currentAudio ? this.currentAudio.id : undefined;
    const removed = model.remove(idx);
    if (!removed) return;
    const currentRemoved = removed.id === currentId;
    if (currentRemoved) {
      this._engine.pause();
      this._engine.unload();
      removed.howl = null;
    }
    if (currentRemoved && wasPlaying) {
      if (model.length > 0) {
        this.play();
      } else {
        // 删掉的是最后一首且在播：没有下一首可播，自己把媒体会话与 UI 状态复位
        this._mediaSession.clearTrack();
        this._mediaSession.setPlaybackState('none');
        this.sendPlayingEvent('Stopped');
      }
    } else if (currentRemoved) {
      // 删掉的是当前曲目但没有在播：把媒体会话切到新的当前曲目，
      // 否则系统控件会一直显示被删掉的那首
      const nextTrack = this.currentAudio;
      if (nextTrack) {
        this._mediaSession.setTrack(nextTrack);
        this._mediaSession.setPlaybackState('paused');
      } else {
        this._mediaSession.clearTrack();
        this._mediaSession.setPlaybackState('none');
      }
    }
    this.sendPlaylistEvent();
    this.sendLoadEvent();
  }

  appendAudioList(list) {
    if (!Array.isArray(list)) return;
    list.forEach((audio) => {
      this.insertAudio(audio);
    });
  }

  clearPlaylist() {
    // 清掉等待中的取地址会话
    this._generation += 1;
    this._session = null;
    this.stopAll();
    this._engine.unloadAll();
    this.playlistModel.setList([]);
    this._mediaSession.clearTrack();
    this._mediaSession.setPlaybackState('none');
    // 被作废的 stop 事件不会再通知 UI，isPlaying=false 必须由这里补发
    this.sendPlayingEvent('Stopped');
    this.sendPlaylistEvent();
    this.sendLoadEvent();
  }

  setNewPlaylist(list) {
    if (Array.isArray(list) && list.length > 0) {
      // 作废等待中的取地址会话，并卸掉旧列表的 Howl
      this._generation += 1;
      this._session = null;
      this.stopAll();
      this._engine.unloadAll();
      const tracks = list.map((audio) => ({ ...audio, howl: null }));
      // 随机模式从随机的第一首开始；顺序模式仍从第 0 首开始
      const startIndex =
        this._loop_mode === 2 ? Math.floor(Math.random() * tracks.length) : 0;
      this.playlistModel.setList(tracks, { index: startIndex });
      const startTrack = this.playlistModel.tracks[startIndex];
      this._mediaSession.setTrack(startTrack);
      this._mediaSession.setPlaybackState('paused');
      // 旧音频的 stop 事件已随代际作废：isPlaying=false 由这里补发；本方法不取地址、不播放
      this.sendPlayingEvent('Stopped');
      this.sendLoadEvent();
    }
    this.sendPlaylistEvent();
  }

  // ---- 音量 / 静音 ----

  applyAudioState() {
    this._engine.applyAudioState({
      volume: this._volume,
      muted: this._muted,
    });
  }

  setVolume(pct) {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) {
      return;
    }
    this._volume = Math.min(Math.max(pct, 0), 100) / 100;
    this._muted = false;
    this.applyAudioState();
    this.sendAudioStateEvent();
  }

  adjustVolume(increase) {
    this.setVolume(this.getAudioState().volume + (increase ? 10 : -10));
  }

  setMuted(muted) {
    this._muted = !!muted;
    this.applyAudioState();
    this.sendAudioStateEvent();
  }

  toggleMuted() {
    this.setMuted(!this._muted);
  }

  // ---- 广播 / 兼容入口 ----

  /**
   * 缓存播放地址。`_media_uri_list[track.id] = { url, bitrate, platform }`：
   * 缓存重放时要用后者补齐 track 上的字段，所以缺省时保留旧值、绝不写 undefined。
   */
  setMediaURI(uri, url) {
    if (!url || !uri) return;
    const cached = this._media_uri_list[url] || {};
    if (typeof uri === 'string') {
      // 兼容旧调用：只给地址
      this._media_uri_list[url] = {
        url: uri,
        bitrate: cached.bitrate,
        platform: cached.platform,
      };
      return;
    }
    this._media_uri_list[url] = {
      url: uri.url,
      bitrate: uri.bitrate !== undefined ? uri.bitrate : cached.bitrate,
      platform: uri.platform !== undefined ? uri.platform : cached.platform,
    };
  }

  setAudioDisabled(disabled, idx) {
    if (this.playlistModel.tracks[idx]) {
      this.playlistModel.tracks[idx].disabled = disabled;
    }
  }

  sendFrameUpdate() {
    const howl = this.currentHowl;
    const duration = howl ? howl.duration() : 0;
    const pos = howl ? howl.seek() : 0;
    const rate = howl ? howl.rate() : 1;
    // duration 为 0 / 非法时 setPositionState 会抛 NotSupportedError：这里先守一层（controller 里还有一层）
    if (duration > 0) {
      this._mediaSession.setPosition({ duration, position: pos, rate });
    }
    this._host.send('BG_PLAYER:FRAME_UPDATE', {
      id: this.currentAudio ? this.currentAudio.id : 0,
      duration,
      pos,
      playedFrom: this.playedFrom,
      playing: this.playing,
    });
  }

  sendPlayingEvent(reason = 'UNKNOWN') {
    this._host.send('BG_PLAYER:PLAY_STATE', {
      isPlaying: this.playing,
      reason,
    });
  }

  sendLoadEvent() {
    this._host.send('BG_PLAYER:LOAD', {
      currentPlaying: {
        ...this.currentAudio,
        howl: undefined,
      },
      playlist: {
        index: this.index,
        length: this.playlist.length,
      },
    });
  }

  sendAudioStateEvent() {
    this._host.send('BG_PLAYER:AUDIO_STATE', this.getAudioState());
  }

  sendPlaylistEvent() {
    this._host.send(
      'BG_PLAYER:PLAYLIST',
      this.playlist.map((audio) => ({ ...audio, howl: undefined }))
    );
  }
}
