/* global createPlayerHost PlayerCore */
{
  // 播放器单例：host 收敛运行时差异（消息通道 / 取地址），core 负责播放状态机。
  // 模式在 play.js 里通过 setMode() 确定（此前不知道自己是 front 还是 background，
  // 旧实现的 READY 顶层广播因此永远发不出去）。
  const threadPlayer = new PlayerCore({
    host: createPlayerHost({ mode: 'background' }),
  });
  threadPlayer.setRefreshRate();
  window.threadPlayer = threadPlayer;
}
