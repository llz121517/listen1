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
      this._random_playlist = [];
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
      if (idx) {
        this.playlist.splice(idx, 0, [audio]);
      } else {
        this.playlist.push(audioData);
      }
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
        // TODO: random mode need random choose first song to load
        this.index = 0;
        this.load(0);
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
     * Skip to the next or previous track.
     * @param  {String} direction 'next' or 'prev'.
     */
    skip(direction) {
      Howler.unload();
      // Get the next track based on the direction of the track.
      const nextIndexFn = (idx) => {
        const l = this.playlist.length;
        const random_mode = this._loop_mode === 2 || direction === 'random';

        let rdx = idx;

        if (random_mode) {
          if (this._random_playlist.length / 2 !== l) {
            // construction random playlist
            const a = Array.from({ length: l }, (_v, i) => i);
            for (let i = 0; i < l; i += 1) {
              const e = l - i - 1;
              const s = Math.floor(Math.random() * e);
              const t = a[s];
              a[s] = a[e];
              a[e] = t;
              // lookup table
              a[t + l] = e;
            }
            this._random_playlist = a;
          }
          rdx = this._random_playlist[idx + l];
        } else if (this._random_playlist.length !== 0) {
          // clear random playlist
          this._random_playlist = [];
        }

        if (direction === 'prev') {
          if (rdx === 0) rdx = l;
          rdx -= 1;
        } else {
          rdx += 1;
        }
        const result = random_mode ? this._random_playlist[rdx % l] : rdx % l;

        return result;
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
