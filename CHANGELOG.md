# Changelog

本仓库是 [Listen 1](https://github.com/listen1/listen1_chrome_extension) 的 fork：**llz121517/listen1**。
本文件记录本 fork 所有值得注意的改动，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。上游历史日志已原样归档：

- 上游历史日志（中文）：[origin/CHANGELOG_UPSTREAM.md](origin/CHANGELOG_UPSTREAM.md)
- 上游历史日志（英文）：[origin/CHANGELOG_UPSTREAM_EN.md](origin/CHANGELOG_UPSTREAM_EN.md)

## 版本号约定

全仓库统一：`package.json` / `package-lock.json` / `manifest.json` / `manifest_firefox.json`（扩展清单的 `version` 只接受 1~4 段纯数字）/ `config/about.json`（界面展示值）。

## [Unreleased]

### Changed

- 侧栏网易云 / QQ 音乐标识改为单色（`currentColor` 跟随主题深浅）：保留原图标几何、只留中间标记（去掉外层方框与被裁掉的文字层），线条由 2.6px 收细到约 2.0px，音符下部开口处为空心圆
- 经典主题侧栏底边与 60px 播放栏之间空出的约 150px：侧栏高度改为跟随容器（`height: 100%`），底边贴住播放栏
- 经典主题顶部同样还原原版口径：侧栏占位带 `menu-control` 74px → 43px，顶栏 64px 绝对定位 + 毛玻璃 → 46px 在流内、无底色
- 经典主题侧栏底色搬到整列 `.sidebar`（原版做法）：顶部占位带不再露空白，并去掉现代留的 1vw 左内边距，侧栏完全靠左
- 经典主题侧栏收起/展开恢复动效（宽度 0.2s、logo 与分组标题渐显），其余现代动效仍禁用
- 经典主题顶栏加 8px 上内边距（`box-sizing: border-box` 锁住 46px 总高），搜索框不再贴顶
- `docs/CONVENTIONS.md` 补 CHANGELOG 纪律：默认写 `[Unreleased]`、`Fixed` 自审归因、详略度对齐 `1.0.0`、只在被要求时提交

## [1.1.0] - 2026-10-06

### Added

- `listen1.html` 顶部加"结构地图 / 纪律 / 坑点"注释块，各区块前加 `[区域]` 标记注释
- `docs/CONVENTIONS.md`：项目约定（不写行号、CHANGELOG 纪律、主题与层叠与注释纪律）

### Changed

- 四个主题共用一套外壳 DOM（`css/common2.css` 为唯一结构表），删除 `listen1.html` 里重复的经典布局
- 经典主题（white / black）新增兼容层 `css/compat-classic.css`：变量别名 + 外壳外观还原（圆角、色块、边框、滚动条；只禁外壳动效）
- 经典播放栏与"正在播放"页改用 `ng-if` 切回原版 HTML（`css/classic-player.css`）；现代播放区包 `.player-modern`，`common2.css` 的播放区选择器全部加此前缀
- 经典播放区整块成一个层叠上下文（`.classic-player` `110`，内部播放页 `1` < 播放栏 `2`），外壳不再压住播放页
- 经典播放页收起由 `top` 挤压改为整页 `transform` 下滑
- 歌单内搜索框 id 改为 `#playlist-search-input`，消掉与导航的同名 id
- `js/controller/profile.js` 的 `setTheme` 改为表驱动，并在 `<html>` 上写 `data-theme` / `data-theme-family`
- `docs/INDEX.md` 与各处注释里的 `listen1.html:行号` 改为搜索串定位
- 上游更新日志归档目录由 `docs/archive/` 移到仓库根的 `origin/`
- 版本号全仓库统一到 `1.1.0`

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
