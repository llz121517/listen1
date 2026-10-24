/* eslint-disable no-underscore-dangle */
/* global MediaMetadata playerSendMessage MediaService */
/* global Howl Howler */
{
  /**
   * Player class containing the state of our playlist and where we are in it.
   * Includes all methods for playing, skipping, updating the display, etc.
   * @param {Array} playlist Array of objects with playlist song details ({title, file, howl}).
   */
  class Player {
    constructor() {
      this.playlist = [];
      // 随机播放状态：洗牌袋（长度 2l：前半是本轮顺序，后半是逆映射）、
      // 本轮锚位（本轮起点那首在顺序里的位置）、轮内已走步数、本轮长度
      this._random_playlist = [];
      this._random_anchor = -1;
      this._random_steps = 0;
      this._random_len = 0;
      this.index = -1;
      this._loop_mode = 0;
      this._media_uri_list = {};
      this.playedFrom = 0;
      this.mode = 'background';
      this.skipTime = 15;
      // 音量 / 静音的权威状态：只有这两个字段说了算，Howler 只是 applyAudioState() 写下去的目标
      this._volume = 1;
      this._muted = false;
    }

    setMode(newMode) {
      this.mode = newMode;
    }

    setRefreshRate(rate = 10) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = setInterval(() => {
        if (this.playing) {
          this.sendFrameUpdate();
        }
      }, 1000 / rate);
    }

    get currentAudio() {
      return this.playlist[this.index];
    }

    get currentHowl() {
      return this.currentAudio && this.currentAudio.howl;
    }

    get playing() {
      return this.currentHowl ? this.currentHowl.playing() : false;
    }

    get muted() {
      return this._muted;
    }

    get volume() {
      return this._volume;
    }

    /**
     * 对外口径的音频状态：音量为百分数（UI 与 localStorage 都按百分数用），静音为布尔。
     */
    getAudioState() {
      return {
        volume: Math.round(this._volume * 100),
        muted: this._muted,
      };
    }

    /**
     * 唯一写 mute / volume 到 Howler 的地方。
     * 顺序不能反：Howler 的 volume() 在全局 _muted 为真时直接 return、不更新任何节点，
     * 而全局 _muted 只在 Howler.mute() 里被改写。
     */
    applyAudioState() {
      Howler.mute(this._muted);
      Howler.volume(this._volume);
      // 上面两条只遍历 Howler._howls；而 skip() 开头的 Howler.unload() 会把播过的 Howl 从
      // _howls 摘掉，finishLoad 又复用同一个 Howl 对象（随机模式复播必走这条），于是它对
      // 当前这个 Howl 无效。这里补一次：Howl 自己的 mute()/volume() 直接写 node
      // （node.muted / node.volume = groupVolume * Howler.volume()）。
      const { currentHowl } = this;
      if (currentHowl) {
        const groupVolume = currentHowl.volume(); // 应用里恒为 1（new Howl({ volume: 1 })）
        currentHowl.mute(this._muted);
        currentHowl.volume(groupVolume);
      }
    }

    insertAudio(audio, idx) {
      if (this.playlist.find((i) => audio.id === i.id)) return;

      const audioData = {
        ...audio,
        disabled: false, // avoid first time load block
        howl: null,
      };
      const originTrack = this.currentAudio;
      if (typeof idx === 'number' && idx >= 0 && idx < this.playlist.length) {
        this.playlist.splice(idx, 0, audioData);
        // 插到当前曲目之前会把它挤后一位，按 id 找回来
        const foundIndex = this.playlist.findIndex(
          (i) => originTrack && i.id === originTrack.id
        );
        if (foundIndex >= 0) {
          this.index = foundIndex;
        }
      } else {
        this.playlist.push(audioData);
      }
      // 歌单变了，当前的随机顺序作废
      this.resetRandomPlaylist();
      this.sendPlaylistEvent();
      this.sendLoadEvent();
    }

    static array_move(arr, old_index, new_index) {
      // https://stackoverflow.com/questions/5306680/move-an-array-element-from-one-array-position-to-another
      if (new_index >= arr.length) {
        let k = new_index - arr.length + 1;
        while (k > 0) {
          k -= 1;
          arr.push(undefined);
        }
      }
      arr.splice(new_index, 0, arr.splice(old_index, 1)[0]);
      return arr; // for testing
    }

    insertAudioByDirection(audio, to_audio, direction) {
      const originTrack = this.playlist[this.index];
      const index = this.playlist.findIndex((i) => i.id === audio.id);
      let insertIndex = this.playlist.findIndex((i) => i.id === to_audio.id);
      if (index === insertIndex) {
        return;
      }
      if (insertIndex > index) {
        insertIndex -= 1;
      }
      const offset = direction === 'top' ? 0 : 1;
      this.playlist = Player.array_move(
        this.playlist,
        index,
        insertIndex + offset
      );
      const foundOriginTrackIndex = this.playlist.findIndex(
        (i) => i.id === originTrack.id
      );
      if (foundOriginTrackIndex >= 0) {
        this.index = foundOriginTrackIndex;
      }

      // 歌单变了，当前的随机顺序作废
      this.resetRandomPlaylist();
      this.sendPlaylistEvent();
      this.sendLoadEvent();
    }

    removeAudio(idx) {
      if (!this.playlist[idx]) {
        return;
      }
      // restore playing status before change
      const isPlaying = this.playing;
      const { id: trackId } = this.currentAudio;

      if (isPlaying && this.playlist[idx].id === trackId) {
        this.pause();
      }

      this.playlist.splice(idx, 1);
      const newIndex = this.playlist.findIndex((i) => i.id === trackId);
      if (newIndex >= 0) {
        this.index = newIndex;
      } else {
        // current playing is deleted
        if (idx >= this.playlist.length) {
          this.index = this.playlist.length - 1;
        } else {
          this.index = idx;
        }
        if (isPlaying) {
          this.play();
        }
      }

      // 歌单变了，当前的随机顺序作废
      this.resetRandomPlaylist();
      this.sendPlaylistEvent();
      this.sendLoadEvent();
    }

    appendAudioList(list) {
      if (!Array.isArray(list)) {
        return;
      }
      list.forEach((audio) => {
        this.insertAudio(audio);
      });
    }

    clearPlaylist() {
      this.stopAll(); // stop the loadded track before remove list
      this.playlist = [];
      this.resetRandomPlaylist();
      Howler.unload();
      this.sendPlaylistEvent();
      this.sendLoadEvent();
    }

    stopAll() {
      this.playlist.forEach((i) => {
        if (i.howl) {
          i.howl.stop();
        }
      });
    }

    setNewPlaylist(list) {
      if (list.length) {
        // stop current
        this.stopAll();
        Howler.unload();

        this.playlist = list.map((audio) => ({
          ...audio,
          howl: null,
        }));
        this.resetRandomPlaylist();
        // 随机模式从随机的第一首开始；顺序模式仍从第 0 首开始
        const startIndex =
          this._loop_mode === 2
            ? Math.floor(Math.random() * this.playlist.length)
            : 0;
        this.index = startIndex;
        this.load(startIndex);
      }
      this.sendPlaylistEvent();
    }

    playById(id) {
      const idx = this.playlist.findIndex((audio) => audio.id === id);
      this.play(idx);
    }

    loadById(id) {
      const idx = this.playlist.findIndex((audio) => audio.id === id);
      this.load(idx);
    }

    /**
     * Play a song in the playlist.
     * @param  {Number} index Index of the song in the playlist
     * (leave empty to play the first or current).
     */
    play(idx) {
      this.load(idx);

      const data = this.playlist[this.index];
      if (!data.howl || !this._media_uri_list[data.id]) {
        this.retrieveMediaUrl(this.index, true);
      } else {
        this.finishLoad(this.index, true);
      }
    }

    retrieveMediaUrl(index, playNow) {
      const msg = {
        type: 'BG_PLAYER:RETRIEVE_URL',
        data: {
          ...this.playlist[index],
          howl: undefined,
          index,
          playNow,
        },
      };

      MediaService.bootstrapTrack(
        msg.data,
        (bootinfo) => {
          msg.type = 'BG_PLAYER:RETRIEVE_URL_SUCCESS';

          msg.data = { ...msg.data, ...bootinfo };

          this.playlist[index].bitrate = bootinfo.bitrate;
          this.playlist[index].platform = bootinfo.platform;

          this.setMediaURI(msg.data.url, msg.data.id);
          this.setAudioDisabled(false, msg.data.index);
          this.finishLoad(msg.data.index, playNow);
          playerSendMessage(this.mode, msg);
        },
        () => {
          msg.type = 'BG_PLAYER:RETRIEVE_URL_FAIL';

          this.setAudioDisabled(true, msg.data.index);
          playerSendMessage(this.mode, msg);

          this.skip('next');
        }
      );
    }

    /**
     * Load a song from the playlist.
     * @param  {Number} index Index of the song in the playlist
     * (leave empty to load the first or current).
     */
    load(idx) {
      let index = typeof idx === 'number' ? idx : this.index;
      if (index < 0) return;
      if (!this.playlist[index]) {
        index = 0;
      }
      // stop when load new track to avoid multiple songs play in same time
      if (index !== this.index) {
        Howler.unload();
      }
      this.index = index;

      this.sendLoadEvent();
    }

    finishLoad(index, playNow) {
      const data = this.playlist[index];

      // If we already loaded this track, use the current one.
      // Otherwise, setup and load a new Howl.
      const self = this;
      if (!data.howl) {
        data.howl = new Howl({
          src: [self._media_uri_list[data.url || data.id]],
          format: 'mp3', // bypass Howl checking url extension, issue #1200
          volume: 1,
          // 这里**不要**传 mute：Howler 会把该选项存成"这个音源自己的 _muted"，而全局
          // mute(false) 只把 node.muted 恢复成 sound._muted、永不重写 node.volume，于是
          // 全局静音期间新建的音源会被永久静音（只有重建 Howl 才恢复）。全局静音由
          // applyAudioState() 经 Howler.mute() 统一施加。
          html5: true, // Force to HTML5 so that the audio can stream in (best for large files).
          onplay() {
            // 兜底：Howler 的 HTML5 音频池释放节点时不重置 muted，play 分支又会把旧的
            // node.muted 一起 OR 进去；这里（playHtml5 写完 muted/volume 之后）重放一次
            // 权威状态，把节点的 muted 与 volume 纠正过来。
            self.applyAudioState();
            if ('mediaSession' in navigator) {
              const { mediaSession } = navigator;
              mediaSession.playbackState = 'playing';
              mediaSession.metadata = new MediaMetadata({
                title: self.currentAudio.title,
                artist: self.currentAudio.artist,
                album: `Listen 1  •  ${(
                  self.currentAudio.album || '<???>'
                ).padEnd(100)}`,
                artwork: [
                  {
                    src: self.currentAudio.img_url,
                    sizes: '500x500',
                  },
                ],
              });
            }
            self.currentAudio.disabled = false;
            // Date.now() returns a millisecond timestamp that needs to be converted to a second timestamp
            self.playedFrom = Math.round(Date.now() / 1000);
            self.sendPlayingEvent('Playing');
          },
          onload() {
            self.currentAudio.disabled = false;
            self.sendPlayingEvent('Loaded');
          },
          onend() {
            switch (self.loop_mode) {
              case 2:
                self.skip('random');
                break;

              case 1:
                self.play();
                break;

              case 0:
              default:
                self.skip('next');
                break;
            }
            self.sendPlayingEvent('Ended');
          },
          onpause() {
            navigator.mediaSession.playbackState = 'paused';
            self.sendPlayingEvent('Paused');
          },
          onstop() {
            self.sendPlayingEvent('Stopped');
          },
          onseek() {},
          onvolume() {},
          onloaderror(id, err) {
            playerSendMessage(this.mode, {
              type: 'BG_PLAYER:PLAY_FAILED',
              data: err,
            });
            self.currentAudio.disabled = true;
            self.sendPlayingEvent('err');
            self.currentHowl.unload();
            data.howl = null;
            delete self._media_uri_list[data.id];
          },
          onplayerror(id, err) {
            playerSendMessage(this.mode, {
              type: 'BG_PLAYER:PLAY_FAILED',
              data: err,
            });
            self.currentAudio.disabled = true;
            self.sendPlayingEvent('err');
          },
        });
      }

      if (playNow) {
        if (this.playing && index === this.index) {
          return;
        }
        this.playlist.forEach((i) => {
          if (i.howl && i.howl !== this.currentHowl) {
            i.howl.stop();
          }
        });
        this.currentHowl.play();
      }
    }

    /**
     * Pause the currently playing track.
     */
    pause() {
      if (!this.currentHowl) return;

      // Puase the sound.
      this.currentHowl.pause();
    }

    /**
     * 随机播放的洗牌袋：长度 2l，前半是本轮播放顺序（值为曲目下标），
     * 后半是逆映射（[l + 下标] = 它在本轮里的位置），skip() 靠它 O(1) 走位。
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
      const l = this.playlist.length;
      const bag = Player.buildShuffleBag(l);
      const originInRange = originIndex >= 0 && originIndex < l;
      this._random_playlist = bag;
      this._random_anchor = originInRange ? bag[l + originIndex] : l - 1;
      this._random_steps = 0;
      this._random_len = Player.randomRoundLength(l);
    }

    /** 丢掉随机播放状态：下一次随机走位会重新洗牌。 */
    resetRandomPlaylist() {
      this._random_playlist = [];
      this._random_anchor = -1;
      this._random_steps = 0;
      this._random_len = 0;
    }

    /**
     * Skip to the next or previous track.
     * @param  {String} direction 'next' or 'prev'.
     */
    skip(direction) {
      Howler.unload();
      // Get the next track based on the direction of the track.
      const nextIndexFn = (idx) => {
        const l = this.playlist.length;
        // 空歌单：没有可走位的位置，交给下面的循环去广播失败
        if (l === 0) return idx;

        const indexInRange = idx >= 0 && idx < l;
        const random_mode = this._loop_mode === 2 || direction === 'random';

        if (!random_mode) {
          if (this._random_playlist.length !== 0) {
            // clear random playlist
            this.resetRandomPlaylist();
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
      };
      this.index = nextIndexFn(this.index);

      let tryCount = 0;
      while (tryCount < this.playlist.length) {
        if (!this.playlist[this.index].disabled) {
          this.play(this.index);
          return;
        }
        this.index = nextIndexFn(this.index);
        tryCount += 1;
      }
      playerSendMessage(this.mode, {
        type: 'BG_PLAYER:RETRIEVE_URL_FAIL_ALL',
      });
      this.sendLoadEvent();
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
      if (!Object.values(LOOP_MODE).includes(myMode)) {
        return;
      }
      if (myMode !== this._loop_mode) {
        // 换播放模式后旧洗牌顺序作废：切进随机要重新洗牌，切出去也不必留着
        this.resetRandomPlaylist();
      }
      this._loop_mode = myMode;
    }

    get loop_mode() {
      return this._loop_mode;
    }

    /**
     * 设音量。语义：调音量即取消静音（滑块 / 滚轮 / 快捷键同一条规则）。
     * @param  {Number} pct 0..100；非有限数值直接忽略
     */
    setVolume(pct) {
      if (typeof pct !== 'number' || !Number.isFinite(pct)) {
        return;
      }
      this._volume = Math.min(Math.max(pct, 0), 100) / 100;
      this._muted = false;
      this.applyAudioState();
      this.sendAudioStateEvent();
    }

    /**
     * 按一档调音量。
     * @param  {Boolean} increase true = 增大一档（沿用既有布尔语义：滚轮与快捷键都传布尔值）
     */
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

    /**
     * Seek to a new position in the currently playing track.
     * @param  {Number} per Percentage through the song to skip.
     */
    seek(per) {
      if (!this.currentHowl) return;

      // Get the Howl we want to manipulate.
      const audio = this.currentHowl;

      // Convert the percent into a seek position.
      // if (audio.playing()) {
      // }
      audio.seek(audio.duration() * per);
    }
    /**
     * Seek to a new position in the currently playing track.
     * @param {Number} seconds Seconds through the song to skip.
     */

    seekTime(seconds) {
      if (!this.currentHowl) return;
      const audio = this.currentHowl;
      audio.seek(seconds);
    }

    /**
     * Format the time from seconds to M:SS.
     * @param  {Number} secs Seconds to format.
     * @return {String}      Formatted time.
     */
    static formatTime(secs) {
      const minutes = Math.floor(secs / 60) || 0;
      const seconds = secs - minutes * 60 || 0;

      return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    }

    setMediaURI(uri, url) {
      if (url) {
        this._media_uri_list[url] = uri;
      }
    }

    setAudioDisabled(disabled, idx) {
      if (this.playlist[idx]) {
        this.playlist[idx].disabled = disabled;
      }
    }

    async sendFrameUpdate() {
      const data = {
        id: this.currentAudio ? this.currentAudio.id : 0,
        duration: this.currentHowl ? this.currentHowl.duration() : 0,
        pos: this.currentHowl ? this.currentHowl.seek() : 0,
        playedFrom: this.playedFrom,
        playing: this.playing,
      };
      if ('setPositionState' in navigator.mediaSession) {
        navigator.mediaSession.setPositionState({
          duration: this.currentHowl ? this.currentHowl.duration() : 0,
          playbackRate: this.currentHowl ? this.currentHowl.rate() : 1,
          position: this.currentHowl ? this.currentHowl.seek() : 0,
        });
      }

      playerSendMessage(this.mode, {
        type: 'BG_PLAYER:FRAME_UPDATE',
        data,
      });
    }

    async sendPlayingEvent(reason = 'UNKNOWN') {
      playerSendMessage(this.mode, {
        type: 'BG_PLAYER:PLAY_STATE',
        data: {
          isPlaying: this.playing,
          reason,
        },
      });
    }

    async sendLoadEvent() {
      playerSendMessage(this.mode, {
        type: 'BG_PLAYER:LOAD',
        data: {
          currentPlaying: {
            ...this.currentAudio,
            howl: undefined,
          },
          playlist: {
            index: this.index,
            length: this.playlist.length,
          },
        },
      });
    }

    async sendAudioStateEvent() {
      playerSendMessage(this.mode, {
        type: 'BG_PLAYER:AUDIO_STATE',
        data: this.getAudioState(),
      });
    }

    async sendPlaylistEvent() {
      playerSendMessage(this.mode, {
        type: 'BG_PLAYER:PLAYLIST',
        data: this.playlist.map((audio) => ({ ...audio, howl: undefined })),
      });
    }
  }

  // Setup our new audio player class and pass it the playlist.

  const threadPlayer = new Player();
  threadPlayer.setRefreshRate();
  window.threadPlayer = threadPlayer;

  if ('mediaSession' in navigator) {
    const { mediaSession } = navigator;
    mediaSession.setActionHandler('play', () => {
      threadPlayer.play();
    });
    mediaSession.setActionHandler('pause', () => {
      threadPlayer.pause();
    });
    mediaSession.setActionHandler('seekforward', (details) => {
      // User clicked "Seek Forward" media notification icon.
      const { currentHowl } = threadPlayer;
      const skipTime = details.seekOffset || threadPlayer.skipTime;
      const newTime = Math.min(
        currentHowl.seek() + skipTime,
        currentHowl.duration()
      );
      threadPlayer.seekTime(newTime);
      threadPlayer.sendFrameUpdate();
    });
    mediaSession.setActionHandler('seekbackward', (details) => {
      // User clicked "Seek Backward" media notification icon.
      const { currentHowl } = threadPlayer;
      const skipTime = details.seekOffset || threadPlayer.skipTime;
      const newTime = Math.max(currentHowl.seek() - skipTime, 0);
      threadPlayer.seekTime(newTime);
      threadPlayer.sendFrameUpdate();
    });
    mediaSession.setActionHandler('seekto', (details) => {
      const { seekTime } = details;
      threadPlayer.seekTime(seekTime);
      threadPlayer.sendFrameUpdate();
    });
    mediaSession.setActionHandler('nexttrack', () => {
      threadPlayer.skip('next');
      threadPlayer.sendFrameUpdate();
    });
    mediaSession.setActionHandler('previoustrack', () => {
      threadPlayer.skip('prev');
      threadPlayer.sendFrameUpdate();
    });
  }
  playerSendMessage(this.mode, {
    type: 'BG_PLAYER:READY',
  });
}
