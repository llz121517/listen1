/* eslint-disable no-underscore-dangle */
/* global Howl Howler */
// eslint-disable-next-line no-unused-vars
class AudioEngine {
  constructor({ onEvent } = {}) {
    this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this._howl = null;
    this._track = null;
    this._howls = [];
    this._unloading = new Set();
  }

  get currentHowl() {
    return this._howl;
  }

  get currentTrack() {
    return this._track;
  }

  /**
   * 所有 Howl 事件的唯一出口：正在卸载的 Howl 的 stop 事件会被抑制，
   * 避免事件回调（PlayerCore 里可能再次 unload）把 unload 递归回去。
   */
  _emit(event) {
    if (event.howl && this._unloading.has(event.howl)) return;
    this._onEvent(event);
  }

  /**
   * 为一次 load session 新建 Howl。事件里的 token 由调用方传入，
   * 采纳与否由 PlayerCore 按代际判断。
   */
  load({ url, track, token }) {
    const self = this;
    const howl = new Howl({
      src: [url],
      format: 'mp3', // bypass Howl checking url extension, issue #1200
      volume: 1,
      // 这里**不要**传 mute：Howler 会把该选项存成"这个音源自己的 _muted"，而全局
      // mute(false) 只把 node.muted 恢复成 sound._muted、永不重写 node.volume，于是
      // 全局静音期间新建的音源会被永久静音（只有重建 Howl 才恢复）。全局静音由
      // applyAudioState() 经 Howler.mute() 统一施加。
      html5: true, // Force to HTML5 so that the audio can stream in (best for large files).
      onplay() {
        self._emit({ type: 'playing', token, track, howl });
      },
      onload() {
        self._emit({ type: 'loaded', token, track, howl });
      },
      onpause() {
        self._emit({ type: 'paused', token, track, howl });
      },
      onstop() {
        self._emit({ type: 'stopped', token, track, howl });
      },
      onend() {
        self._emit({ type: 'ended', token, track, howl });
      },
      onloaderror(id, error) {
        self._emit({ type: 'error', token, track, howl, error });
      },
      onplayerror(id, error) {
        self._emit({ type: 'error', token, track, howl, error });
      },
    });
    this._howls.push(howl);
    this._howl = howl;
    this._track = track;
    return howl;
  }

  play() {
    if (this._howl) this._howl.play();
  }

  pause() {
    if (this._howl) this._howl.pause();
  }

  stop() {
    if (this._howl) this._howl.stop();
  }

  seek(seconds) {
    if (this._howl) this._howl.seek(seconds);
  }

  seekPercent(percent) {
    if (!this._howl) return;
    const duration = this._howl.duration();
    if (!(duration > 0)) return;
    this._howl.seek(duration * percent);
  }

  duration() {
    return this._howl ? this._howl.duration() : 0;
  }

  position() {
    return this._howl ? this._howl.seek() : 0;
  }

  rate() {
    return this._howl ? this._howl.rate() : 1;
  }

  /**
   * 唯一写 Howler 音量/静音的地方。顺序不能反：Howler.volume() 在全局 _muted 为真时
   * 直接 return、不更新任何节点，而全局 _muted 只在 Howler.mute() 里被改写。
   * 再对当前 Howl 补一次 mute/volume：html5 node 会被 Howler 复用，复用时 muted/volume
   * 没有复位（Howler 的 OR 语义），所以每次开播都要把权威状态再写一遍。
   */
  applyAudioState({ volume, muted }) {
    Howler.mute(muted);
    Howler.volume(volume);
    const { currentHowl } = this;
    if (currentHowl) {
      const groupVolume = currentHowl.volume(); // 应用里恒为 1（new Howl({ volume: 1 })）
      currentHowl.mute(muted);
      currentHowl.volume(groupVolume);
    }
  }

  unload(howl = this._howl) {
    if (!howl) return;
    const index = this._howls.indexOf(howl);
    if (index < 0) return;
    this._howls.splice(index, 1);
    if (this._howl === howl) {
      this._howl = null;
      this._track = null;
    }
    // Howl.unload() 内部会 stop 并派发 onstop：这段期间抑制该 Howl 的事件，防止事件回调再次触发卸载而递归
    this._unloading.add(howl);
    try {
      howl.unload();
    } finally {
      this._unloading.delete(howl);
    }
  }

  /** 定向卸载：保留指定 Howl，其余全部卸载（不调 Howler.unload()）。 */
  unloadOtherThan(keepHowl) {
    this._howls.slice().forEach((howl) => {
      if (howl !== keepHowl) this.unload(howl);
    });
    this._howl = keepHowl || null;
    if (!keepHowl) this._track = null;
  }

  unloadAll() {
    this._howls.slice().forEach((howl) => this.unload(howl));
    this._howl = null;
    this._track = null;
  }
}
