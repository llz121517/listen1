/* eslint-disable no-underscore-dangle */
/* global MediaMetadata */
// eslint-disable-next-line no-unused-vars
class MediaSessionController {
  constructor(handlers = {}) {
    this._handlers = handlers;
    this._mediaSession =
      typeof navigator !== 'undefined' && 'mediaSession' in navigator
        ? navigator.mediaSession
        : null;
    if (this._mediaSession) {
      this._registerActionHandlers();
    }
  }

  get supported() {
    return this._mediaSession !== null;
  }

  _setActionHandler(action, handler) {
    try {
      this._mediaSession.setActionHandler(action, handler);
    } catch (err) {
      // 个别浏览器不支持某些 action：静默跳过，不影响其它按钮
    }
  }

  _registerActionHandlers() {
    const {
      onPlay,
      onPause,
      onNext,
      onPrev,
      onSeek,
      onSeekForward,
      onSeekBackward,
    } = this._handlers;
    if (onPlay) this._setActionHandler('play', () => onPlay());
    if (onPause) this._setActionHandler('pause', () => onPause());
    if (onNext) this._setActionHandler('nexttrack', () => onNext());
    if (onPrev) this._setActionHandler('previoustrack', () => onPrev());
    if (onSeek) this._setActionHandler('seekto', (details) => onSeek(details));
    if (onSeekForward) {
      this._setActionHandler('seekforward', (details) =>
        onSeekForward(details)
      );
    }
    if (onSeekBackward) {
      this._setActionHandler('seekbackward', (details) =>
        onSeekBackward(details)
      );
    }
  }

  setTrack(track) {
    if (!this._mediaSession || !track) return;
    const artwork = track.img_url
      ? [{ src: track.img_url, sizes: '500x500' }]
      : [];
    const metadata = {
      title: track.title,
      artist: track.artist,
      album: `Listen 1  •  ${(track.album || '<???>').padEnd(100)}`,
      artwork,
    };
    try {
      this._mediaSession.metadata = new MediaMetadata(metadata);
    } catch (err) {
      // 环境没有 MediaMetadata 或参数不合法：保持原 metadata
    }
  }

  clearTrack() {
    if (!this._mediaSession) return;
    try {
      this._mediaSession.metadata = null;
    } catch (err) {
      // 某些实现不允许置空：忽略
    }
  }

  setPlaybackState(state) {
    if (!this._mediaSession) return;
    try {
      this._mediaSession.playbackState = state;
    } catch (err) {
      // playbackState 不可写：忽略
    }
  }

  setPosition({ duration, position, rate } = {}) {
    if (
      !this._mediaSession ||
      typeof this._mediaSession.setPositionState !== 'function'
    ) {
      return;
    }
    // duration 为 0 / 非法时写位置状态会抛 NotSupportedError，直接跳过
    if (typeof duration !== 'number' || !(duration > 0)) return;
    const safePosition = Math.min(
      Math.max(typeof position === 'number' ? position : 0, 0),
      duration
    );
    const playbackRate = typeof rate === 'number' && rate > 0 ? rate : 1;
    try {
      this._mediaSession.setPositionState({
        duration,
        playbackRate,
        position: safePosition,
      });
    } catch (err) {
      // 参数不合法 / 不支持：忽略
    }
  }
}
