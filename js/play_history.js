/* global addPlayerListener getPlayerMode MediaService getLocalStorageValue */

/*
 * 播放历史同步：把 listen1 里的播放行为按网易云 web 客户端的 bi-log 协议上报，
 * 使「听歌排行 / 播放历史」与官方客户端一致。设置页开关：enable_play_history_sync。
 *
 * 协议要点（详见 js/provider/netease.js 的 submit_play_history）：
 *   - 播满 3 秒后才补发 action=startplay（startplay 就会被记账，选曲即发会让 0 秒曲目进排行）
 *   - 切歌/播完发 action=play（带 time 与 end），未播满 3 秒则整首不发任何日志
 */
(() => {
  const SETTING_KEY = 'enable_play_history_sync';
  const MIN_SECONDS = 3;
  // 播放位置距结尾不足这个秒数时，上一首按「自然播完」结算，否则算用户切歌
  const NEAR_END_SECONDS = 2;

  // 当前曲目：{ track, seconds, lastPos, duration, started, reported }
  let current = null;

  function isEnabled() {
    return getLocalStorageValue(SETTING_KEY, false) === true;
  }

  function isNeteaseTrack(track) {
    return !!track && typeof track.id === 'string' && /^netrack_\d+$/.test(track.id);
  }

  function report(track, action, seconds, end) {
    if (!isNeteaseTrack(track)) {
      return;
    }
    const result = MediaService.submitPlayHistory(track, seconds, end, action);
    // 服务端结果不打扰用户；这里只是让 provider 的 lazy spec 真正发起请求
    if (result && typeof result.success === 'function') {
      result.success(() => {});
    }
  }

  function startTrack(track) {
    // 注意：这里不发 startplay。网易云会拿 startplay 记账，选曲/加载即发会导致
    // 「播放进度 0 秒」的曲目也进听歌排行。startplay 统一等到真正播满 MIN_SECONDS 再补发。
    current = {
      track,
      seconds: 0,
      lastPos: 0,
      duration: 0,
      started: false,
      reported: false,
    };
  }

  function isNearEnd() {
    if (!current || current.duration <= 0) {
      return false;
    }
    return current.lastPos >= current.duration - NEAR_END_SECONDS;
  }

  // reason: 'ui' 用户切歌 | 'playend' 自然播完 | 'exception' 播放出错
  function flush(reason) {
    if (!current || !current.started || current.reported) {
      return;
    }
    // 先标记：紧接着的 LOAD 不能再把同一首算第二次
    current.reported = true;
    if (isEnabled()) {
      report(current.track, 'play', Math.round(current.seconds), reason);
    }
  }

  addPlayerListener(getPlayerMode(), (msg) => {
    if (!msg || !msg.type) {
      return;
    }
    // 播放器事件统一带 BG_PLAYER: 前缀（front/后台两种模式共用同一套协议）
    switch (msg.type) {
      case 'BG_PLAYER:LOAD': {
        const track = msg.data && msg.data.currentPlaying;
        if (!track || track.id === undefined) {
          return;
        }
        if (current && current.track.id === track.id) {
          return;
        }
        // 切歌：上一首结算。走到自然结尾的按 playend 记，否则算用户切歌
        flush(isNearEnd() ? 'playend' : 'ui');
        startTrack(track);
        break;
      }
      case 'BG_PLAYER:FRAME_UPDATE': {
        if (!current || current.reported) {
          return;
        }
        const pos = msg.data.pos || 0;
        const duration = msg.data.duration || 0;
        const delta = pos - current.lastPos;
        current.lastPos = pos;
        current.duration = duration;
        // 只累计正常播放增量，跳转（seek）不计入播放时长
        if (delta > 0 && delta <= 5) {
          current.seconds += delta;
          if (duration > 0 && current.seconds > duration) {
            current.seconds = duration;
          }
        }
        // 真正播满阈值才补发 startplay：这时才算一条有效播放。
        // 开关关闭期间跨过阈值不记 started，之后再打开也不会补发这一首。
        if (!current.started && current.seconds >= MIN_SECONDS && isEnabled()) {
          current.started = true;
          report(current.track, 'startplay', Math.round(current.seconds), '');
        }
        break;
      }
      case 'BG_PLAYER:PLAY_STATE': {
        const reason = msg.data && msg.data.reason;
        if (reason === 'err') {
          flush('exception');
          return;
        }
        if (reason !== 'Ended' || !current || current.seconds <= 0) {
          return;
        }
        // 单曲循环不会再发 LOAD：同一首在这结算一轮，再按新一轮重开。
        // 列表循环/顺序播放时上面 LOAD 已把 current 换成新曲目（seconds 为 0），不会重复处理。
        flush('playend');
        current.seconds = 0;
        current.lastPos = 0;
        current.duration = 0;
        current.started = false;
        current.reported = false;
        break;
      }
      default:
        break;
    }
  });
})();
