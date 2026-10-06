/* eslint-disable no-unused-vars */
/* global isElectron getLocalStorageValue */
/*
build a bridge between UI and audio player

audio player has 2 modes, but share same protocol: front and background.

* front: audio player and UI are in same environment
* background: audio player is in background page.

*/

function getFrontPlayer() {
  return window.threadPlayer;
}

/*
MV3 的后台是 service worker，没有 background page：runtime.getBackgroundPage 仍然存在，
但会带 lastError 回调 undefined（"You do not have a background page."）。
下面这个判断是"后台播放器可用吗"的唯一依据，模式推导和取播放器都走它。
*/
function hasBackgroundPlayer() {
  // Electron 里没有 chrome.* API，这里必须用 typeof 探测（原先这些函数只在 Chrome 分支被调用）
  let api = null;
  if (typeof chrome !== 'undefined') {
    api = chrome;
  } else if (typeof browser !== 'undefined') {
    api = browser;
  }
  if (!api || !api.runtime || typeof api.runtime.getBackgroundPage !== 'function') {
    return false;
  }
  return api.runtime.getManifest().manifest_version < 3;
}

/*
front / background 模式的唯一推导处。原先 l1_player.js 与 play.js 各推一次、必须保持一致，
MV3 下这里恒为 front —— 否则用户关掉"关闭时停止播放"会指向一个不存在的后台播放器。
*/
function getPlayerMode() {
  if (!hasBackgroundPlayer()) {
    return 'front';
  }
  return isElectron() || getLocalStorageValue('enable_stop_when_close', true)
    ? 'front'
    : 'background';
}

function getBackgroundPlayer() {
  if (!hasBackgroundPlayer()) {
    return undefined;
  }
  return chrome.extension.getBackgroundPage().threadPlayer;
}

function getBackgroundPlayerAsync(callback) {
  if (!hasBackgroundPlayer()) {
    // 没有后台播放器：调用方都是 play / pause 这类空操作，不需要回调
    return;
  }
  (chrome || browser).runtime.getBackgroundPage((w) => {
    // 先读掉 lastError，否则控制台会报 "Unchecked runtime.lastError"
    if ((chrome || browser).runtime.lastError || !w) {
      return;
    }
    callback(w.threadPlayer);
  });
}

function getPlayer(mode) {
  if (mode === 'front') {
    return getFrontPlayer();
  }
  if (mode === 'background') {
    return getBackgroundPlayer();
  }
  return undefined;
}

function getPlayerAsync(mode, callback) {
  if (mode === 'front') {
    const player = getFrontPlayer();
    return callback(player);
  }
  if (mode === 'background') {
    return getBackgroundPlayerAsync(callback);
  }
  return undefined;
}
const frontPlayerListener = [];
function addFrontPlayerListener(listener) {
  frontPlayerListener.push(listener);
}

function addBackgroundPlayerListener(listener) {
  return (chrome || browser).runtime.onMessage.addListener(
    (msg, sender, res) => {
      if (!msg.type.startsWith('BG_PLAYER:')) {
        return null;
      }
      return listener(msg, sender, res);
    }
  );
}

function addPlayerListener(mode, listener) {
  if (mode === 'front') {
    return addFrontPlayerListener(listener);
  }
  if (mode === 'background') {
    return addBackgroundPlayerListener(listener);
  }
  return null;
}

function frontPlayerSendMessage(message) {
  if (frontPlayerListener !== []) {
    frontPlayerListener.forEach((listener) => {
      listener(message);
    });
  }
}

function backgroundPlayerSendMessage(message) {
  (chrome || browser).runtime.sendMessage(message);
}

function playerSendMessage(mode, message) {
  if (mode === 'front') {
    frontPlayerSendMessage(message);
  }
  if (mode === 'background') {
    backgroundPlayerSendMessage(message);
  }
}
