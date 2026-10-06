/* eslint-disable no-global-assign */
/* global module */
/*
Electron 渲染进程里 `module` 是 Node 的全局对象。UMD 打包的 vendor 库（angular / i18next /
axios / howler / hotkeys…）头一行都是
  "object" == typeof exports && "object" == typeof module ? module.exports = ...
——只要看到 `module` 存在就走 CommonJS 分支，导出挂到 `module.exports` 而不是 `window` 上，
整套 UI 起不来（`angular` 会是 undefined）。所以这段必须在所有 vendor <script> 之前执行。

拆成独立文件而不是内联 <script>：MV3 的 CSP 是 `script-src 'self'`，内联脚本会被直接拦掉。
配套的还原脚本见 js/module_guard_restore.js（加载顺序：本文件 → vendor → 应用脚本 → 还原）。
*/
if (typeof module === 'object') {
  window.module = module;
  module = undefined;
}
