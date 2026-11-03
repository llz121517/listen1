/* global playerSendMessage MediaService */

function pruneTrack(track) {
  return { ...track, howl: undefined };
}

// eslint-disable-next-line no-unused-vars
function createPlayerHost({ mode = 'background' } = {}) {
  const host = {
    mode,
    send(type, data) {
      const message = data === undefined ? { type } : { type, data };
      if (typeof playerSendMessage === 'function') {
        playerSendMessage(host.mode, message);
      }
    },
    resolveUrl(track, callback) {
      if (
        typeof MediaService !== 'undefined' &&
        MediaService &&
        typeof MediaService.bootstrapTrack === 'function'
      ) {
        MediaService.bootstrapTrack(
          pruneTrack(track),
          (bootinfo) => callback(bootinfo || null),
          () => callback(null)
        );
        return;
      }
      // 后台页没有服务层脚本（Firefox MV2）：没有地址可解析，立即判失败。
      // 全仓没有 BG_PLAYER:RETRIEVE_URL 的消费者，走消息回传只会变成每次播放等超时再逐首跳。
      callback(null);
    },
  };
  return host;
}
