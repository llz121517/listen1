# Changelog

本仓库是 [Listen 1](https://github.com/listen1/listen1_chrome_extension) 的 fork：**llz121517/listen1**。
本文件记录本 fork 所有值得注意的改动，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。上游历史日志已原样归档：

- 上游历史日志（中文）：[origin/CHANGELOG_UPSTREAM.md](origin/CHANGELOG_UPSTREAM.md)
- 上游历史日志（英文）：[origin/CHANGELOG_UPSTREAM_EN.md](origin/CHANGELOG_UPSTREAM_EN.md)

## 版本号约定

全仓库统一：`package.json` / `package-lock.json` / `manifest.json` / `manifest_firefox.json`（扩展清单的 `version` 只接受 1~4 段纯数字）/ `config/about.json`（界面展示值）。

## [Unreleased]

_尚无未发布改动。_

## [1.1.0] - 2026-10-06

### Added

- `listen1.html` 顶部加"结构地图 / 纪律 / 坑点"注释块（文件顶部、样式表之后），各区块前加 `[区域]` 标记注释：样式表加载顺序、区域划分、播放区 `.player-modern` 作用域纪律、z-index 顺序、同名 id 等坑点

### Changed

- **外壳只保留一套布局（播放区仍按主题族分叉）**：删掉 `listen1.html` 里重复的那套经典布局，四个主题共用原来的"新版"结构 + `css/common2.css`，主题只换 palette；`css/common.css` 不再是运行期样式表
- 经典主题（white / black）新增兼容层 `css/compat-classic.css`：把经典 palette 变量别名到结构需要的现代变量，并把外壳外观换成经典惯用法（2px 圆角、平面色块、1px 边框、14px 滚动条，去掉毛玻璃与缩放动效）—— 换之前经典主题套的是新版外壳样式，侧栏 / 按钮 / 滚动条 / 封面都是现代外观；动效只禁共用外壳：`animation` 全禁，`transition` 用 `:not()` 排除 `.classic-player` 子树，保留经典播放区原有的下滑 / 淡入 / 菜单上滑
- 经典主题的播放栏与"正在播放"页改用 `ng-if` 切回原版 HTML（`listen1.html` 的 `.classic-player` 分支 + `css/classic-player.css`），不再用 CSS 模拟；现代播放区则包一层 `.player-modern` 做作用域，`css/common2.css` 里 150 处播放区选择器前缀（139 条规则，以 `.footer` / `.songdetail-wrapper` / `.playsong-detail` / `.volume-ctrl` 为根）全部加此前缀 —— 加之前这些选择器会命中经典分支的同名类，把 7px 图标内边距 + 圆角、播放栏 `98vw` + `1vh 1vw` 边距、毛玻璃播放菜单、`54vh` 封面、`-webkit-line-clamp` 标题等现代值带进经典播放区
- 经典播放区改成整块一个层叠上下文（`.classic-player { position: relative; z-index: 110 }`），内部只有两级：播放页 `1` < 播放栏 / 播放列表菜单 `2` —— 播放页铺满窗口并盖住顶栏与侧栏，外壳以后再新增 z-index 也压不住播放区（改之前 `common2.css` 给侧栏 svg 的 `10` 和顶栏的 `100` 都压在播放页之上，顶栏浮着还破坏原版的沉浸感）
- 经典播放页的收起由原版的 `top: calc(100% - 60px)` 挤压改为整页 `transform: translateY(calc(100% + 60px))` 下滑、高度不变：挤压会把封面背景和内容一起压扁，看起来像"背景先消失、没等收起动画走完"（本 fork 相对原版的一处有意偏离，注释写在 `css/classic-player.css`）
- 歌单内搜索框的 `id="search-input"` 改为 `id="playlist-search-input"`，消掉与导航搜索框的同名 id（`navigation.js` 的 `f` 快捷键此前取到的永远是文档里第一个）
- `js/controller/profile.js` 的 `setTheme` 改为表驱动（palette 映射 + 结构样式），并在 `<html>` 上写 `data-theme` / `data-theme-family`
- 上游更新日志归档目录由 `docs/archive/` 移到仓库根的 `origin/`

## [1.0.0] - 2026-10-06

### Added

- 日语界面（现 7 种语言 × 173 个键）
- 语言清单 `config/languages.json`：设置页语言按钮由该清单动态生成，按钮文本取自各语言文件自己的 `_LANGUAGE_NAME`；新增语言只需加一个 `i18n/xx.json` 并在清单里加一行
- 「关于」页信息抽到 `config/about.json`：版本展示、官网、邮箱、反馈链接、主题署名
- 英文说明迁至 `docs/en/README.md`，与中文说明互链

### Changed

- 版本号由上游 `2.33.0` 重置为 `1.0.0`；上游更新日志归档到 `docs/archive/`（后移到仓库根的 `origin/`），本文件成为 fork 日志
- 设置页「最新版本」改为检查本 fork 仓库的 releases
- i18n 加载口径统一为完整区域码文件（如 `i18n/zh-CN.json`）：不再维护语言白名单，也不会请求未发布的语言文件
- 总索引 `INDEX.md` 等 root 散落文档统一移入 `docs/`
- 默认分支由 `master` 改为 `main`，并删除 fork 继承自上游的其余分支

### Fixed

- 上游文案：`Authencate` 拼写、英文/法文串里残留的中文「页面」、英文授权提示语法

基线：上游 `3f24efa`（`chore: add more changelog`，版本 `2.33.0`）。本 fork 尚无 tag/release，发布后再在此补版本比较链接。
