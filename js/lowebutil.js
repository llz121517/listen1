/* eslint-disable consistent-return */
/* eslint-disable no-param-reassign */
/* eslint-disable no-unused-vars */

function getParameterByName(name, url) {
  if (!url) url = window.location.href;
  name = name.replace(/[[\]]/g, '\\$&');
  const regex = new RegExp(`[?&]${name}(=([^&#]*)|&|#|$)`);

  const results = regex.exec(url);
  if (!results) return null;
  if (!results[2]) return '';
  return decodeURIComponent(results[2].replace(/\+/g, ' '));
}

function isElectron() {
  return window && window.process && window.process.type;
}

function cookieGet(cookieRequest, callback) {
  if (!isElectron()) {
    return chrome.cookies.get(cookieRequest, (cookie) => {
      callback(cookie);
    });
  }
  const remote = require('@electron/remote'); // eslint-disable-line
  remote.session.defaultSession.cookies
    .get(cookieRequest)
    .then((cookieArray) => {
      let cookie = null;
      if (cookieArray.length > 0) {
        [cookie] = cookieArray;
      }
      callback(cookie);
    });
}

function cookieSet(cookie, callback) {
  if (!isElectron()) {
    return chrome.cookies.set(cookie, (arg1, arg2) => {
      callback(arg1, arg2);
    });
  }
  const remote = require('@electron/remote'); // eslint-disable-line
  remote.session.defaultSession.cookies.set(cookie).then((arg1, arg2) => {
    callback(null, arg1, arg2);
  });
}
function cookieRemove(cookie, callback) {
  if (!isElectron()) {
    return chrome.cookies.remove(cookie, (arg1, arg2) => {
      callback(arg1, arg2);
    });
  }
  const remote = require('@electron/remote'); // eslint-disable-line
  remote.session.defaultSession.cookies
    .remove(cookie.url, cookie.name)
    .then((arg1, arg2) => {
      callback(null, arg1, arg2);
    });
}

function setPrototypeOfLocalStorage() {
  const proto = Object.getPrototypeOf(localStorage);
  proto.getObject = function getObject(key) {
    const value = this.getItem(key);
    try {
      return value && JSON.parse(value);
    } catch (error) {
      return {};
    }
  };
  proto.setObject = function setObject(key, value) {
    this.setItem(key, JSON.stringify(value));
  };
  Object.setPrototypeOf(localStorage, proto);
}

function getLocalStorageValue(key, defaultValue) {
  const keyString = localStorage.getItem(key);
  let result = keyString && JSON.parse(keyString);
  if (result === null) {
    result = defaultValue;
  }
  return result;
}

function easeInOutQuad(t, b, c, d) {
  // t = current time
  // b = start value
  // c = change in value
  // d = duration
  t /= d / 2;
  if (t < 1) return (c / 2) * t * t + b;
  t -= 1;
  return (-c / 2) * (t * (t - 2) - 1) + b;
}

function smoothScrollTo(element, to, duration) {
  const start = element.scrollTop;
  const change = to - start;
  const startTime = performance.now();

  const animateScroll = (currentTime) => {
    const timeElapsed = currentTime - startTime;
    const val = easeInOutQuad(timeElapsed, start, change, duration);
    element.scrollTop = val;
    if (timeElapsed < duration) {
      requestAnimationFrame(animateScroll);
    } else {
      element.scrollTop = to; // Ensure it ends exactly at 'to'
    }
  };
  requestAnimationFrame(animateScroll);
}

/**
 * 歌词翻译开关的显示条件：解析后的歌词里至少有一行“有内容”的翻译行。
 * 翻译行由 parseLyric() 打上 translationFlag；只有时间戳、内容为空的翻译行不算。
 * 传 null / 非数组时按“没有翻译”处理，不抛异常。
 */
function hasLyricTranslationLines(lyricArray) {
  if (!Array.isArray(lyricArray)) {
    return false;
  }
  return lyricArray.some(
    (line) =>
      line &&
      line.translationFlag === true &&
      typeof line.content === 'string' &&
      line.content.trim() !== ''
  );
}

/**
 * 歌单内搜索（#playlist-search-input）的匹配规则：按空白把查询词拆成多个关键词，
 * 大小写不敏感；每个关键词都要命中 title / artist / album 之一（关键词 AND、字段 OR）。
 * 空查询不过滤任何曲目；缺字段按不命中处理，不抛异常。
 */
function matchPlaylistFilter(song, key) {
  const keywords = String(key || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (keywords.length === 0) {
    return true;
  }
  return keywords.every((word) =>
    ['title', 'artist', 'album'].some(
      (field) =>
        typeof song[field] === 'string' &&
        song[field].toLowerCase().includes(word)
    )
  );
}
