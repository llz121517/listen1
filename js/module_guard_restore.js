/* eslint-disable no-global-assign, no-unused-vars */
/* global module */
/*
还原被 js/module_guard_hide.js 摘掉的 Node 全局 `module`（Electron 里后续运行时还要用）。
位置固定：所有 <script> 之后（原来就是 head 里最后一段内联脚本）。
Chrome 扩展里 `window.module` 不存在 → 整段是空操作。详见 module_guard_hide.js 的说明。
*/
if (window.module) {
  module = window.module;
}
