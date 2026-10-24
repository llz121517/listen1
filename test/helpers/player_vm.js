/**
 * 共享 vm 沙箱加载器：被测文件是浏览器脚本（无 import/export，依赖全局），
 * 这里只负责「在同一个 context 里按顺序跑多个脚本」和「取回顶层 class 绑定」。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

/**
 * @param {object} sandbox 需要补的浏览器全局（会被 context 化）
 * @param {string[]} files 相对仓库根的脚本路径，按顺序执行
 */
function loadScripts(sandbox, files) {
  const context = vm.createContext(sandbox);
  files.forEach((file) => {
    const full = path.join(ROOT, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), context, {
      filename: full,
    });
  });
  return context;
}

/** 在 context 里求一个表达式（用于取回顶层 class / 函数绑定） */
function globalValue(context, expression) {
  return vm.runInContext(expression, context);
}

module.exports = { ROOT, loadScripts, globalValue };
