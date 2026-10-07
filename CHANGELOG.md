# Changelog

本仓库是 [Listen 1](https://github.com/listen1/listen1_chrome_extension) 的 fork：**llz121517/listen1**。
本文件记录本 fork 所有值得注意的改动，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。上游历史日志已原样归档：

- 上游历史日志（中文）：[docs/origin/CHANGELOG_UPSTREAM.md](docs/origin/CHANGELOG_UPSTREAM.md)
- 上游历史日志（英文）：[docs/origin/CHANGELOG_UPSTREAM_EN.md](docs/origin/CHANGELOG_UPSTREAM_EN.md)

## 版本号约定

语义化版本（SemVer）`MAJOR.MINOR.PATCH`：不兼容改动升 `MAJOR`、向后兼容地新增升 `MINOR`、向后兼容地修复升 `PATCH`（细则见 [docs/CONVENTIONS.md](docs/CONVENTIONS.md) §7）。扩展清单的 `version` 只接受 1~4 段纯数字，所以只用三段 `x.y.z`。
全仓库统一：`package.json` / `package-lock.json` / `manifest.json` / `manifest_firefox.json` / `config/about.json`（界面展示值）。
发版：`dev` → `main` 的 PR，一 PR 一版本；合并提交标题为"日期 + 版本号"（`YYYY-MM-DD / vX.Y.Z`，细则见 [docs/CONVENTIONS.md](docs/CONVENTIONS.md) §10）。

## [Unreleased]

## [2.2.0] - 2026-10-07

### Changed

- 音量 / 静音状态收敛到播放器（权威字段 + 唯一出口 `applyAudioState()`），两条消息合并为 `BG_PLAYER:AUDIO_STATE`；「调音量即取消静音」成为滑块 / 滚轮 / 快捷键共用的规则
- 「删除歌单」从编辑弹窗挪到歌单页 `.playlist-button-list` 行尾，与同行同款药丸、悬浮变红
- 播放页外语歌词翻译行：未唱到 13px、与原句间距 12px，唱到时 20px
- 「显示专辑封面作为背景」开启时播放页面板更实、封面模糊减弱（`blur(200px)` → `120px`）
- 清掉两个样式表里 16 条永远不会匹配的死规则（登录页旧类名与 `.coverbg` 残留）
- 上游日志归档目录从仓库根的 `origin/` 移到 `docs/origin/`，文档引用同步

### Fixed

- 全局静音期间切歌后新建的音源永久静音，只有重建 Howl 才恢复
- 静音状态下改音量要等下一次播放才生效

## [2.1.0] - 2026-10-06

### Changed

- 播放页（`.footer` 展开态）改为叠加层：`toggleNowPlaying()` 不再置 `is_window_hidden=0`、不再 `resetWindow()`，曲目列表的 `ng-show` 去掉 `window_type=='list'` 依赖 —— 下层视图保持挂载、滚动位置不丢；关闭走新增快捷路径（只回退视图 + 恢复 offset，不重取数据）；展开期间 `.browser` 用 `nowplaying-open` 锁住底层滚动（`overflow-y: hidden !important`，压过内联的 `scroll`）
- 新增 `docs/CONVENTIONS.md` §10 分支与发版流程：`main` 原则上只经 `dev` 的 PR 更新、一 PR 一版本、合并提交标题为"日期 + 版本号"（`YYYY-MM-DD x.y.z`）
- 顶栏与播放栏的底色透明度由 0.86 降到 0.75（`--nav-background-color`，两套 palette 同步）：两条浮条透一点，自定义壁纸下更明显；同一变量驱动的侧栏顶带卡片与播放列表抽屉一并变透
- `.player-modern` 作用域前缀整体去除：`css/common2.css` 里 150 处播放区选择器回到直接以 `.footer` / `.songdetail-wrapper` / `.playsong-detail` / `.volume-ctrl` 为根（与合并布局前的上游原文一致，差异只剩 `--nav-height` 块、删掉的死声明与下面那条死规则清理），`listen1.html` 的包装 class 与相关纪律、约定一并更新
- 清理遗留：`profile.js` 不再往 `<html>` 写已无消费者的 `data-theme`，`common2.css` 删掉两套 palette 都没定义的死声明 `color: var(--color-text)`，`listen1.html` 去掉不再被引用的 `#common-css` id，i18n 的 `_THEME_MODERN_WHITE` / `_THEME_MODERN_BLACK` 更名 `_THEME_WHITE` / `_THEME_BLACK` 并去掉文案里的"现代"字样
- 右侧滚动区顶部留白加 5px（`.page` 的 `padding-top` 改为 `calc(var(--nav-height) + 5px)`），内容不再贴着顶栏下缘
- 版本号约定明确为语义化版本（SemVer）：`MAJOR` 不兼容改动、`MINOR` 向后兼容地新增、`PATCH` 向后兼容地修复；扩展清单只接受纯数字，因此只用三段 `x.y.z`

### Fixed

- `listen1.html` 的两段内联 `<script>` 移成外部文件（新增 `js/module_guard_hide.js` / `js/module_guard_restore.js`，加载位置与原来一致）：MV3 的 CSP 是 `script-src 'self'`，内联脚本会被拦掉并报 `Executing inline script violates the following Content Security Policy directive`，而这两段只在 Electron 下有用（摘掉 / 还原 Node 全局 `module`）
- 封面虚影的 `background-image` 由内联 `style` 改为 `ng-style`（5 处）：`url({{…}})` 由 CSS 先解析、Angular 后插值，浏览器会把 `{{cover_img_url}}` 字面量当 URL 去请求并报 `net::ERR_FILE_NOT_FOUND`
- front / background 模式推导收敛到 `bridge.js` 的 `getPlayerMode()`，并用 `hasBackgroundPlayer()` 判断后台播放器是否存在：MV3 没有 background page，原先默认 front 模式启动时仍会去"暂停后台播放器"，导致 `Cannot read properties of undefined (reading 'threadPlayer')` 与 `Unchecked runtime.lastError: You do not have a background page.`

## [2.0.0] - 2026-10-06

### Added

- 自定义背景：设置页新增『自定义背景』一节 —— 『选择壁纸』走文件选择窗，选中后壁纸居中缩放铺满（`cover`）并固定满窗，同时出现『清除壁纸』按钮；壁纸存 `custom_background`（图片 data URL），启动时自动恢复
- `css/custom-background.css` + `listen1.html` 的 `[装饰层]`：自定义背景画成一个 fixed 全屏壁纸层（`z-index:-1`，跟窗口走、不被容器裁切）；面板玻璃浓度由 `--custom-bg-panel-glass` 固定（默认 0.55）

### Changed

- 侧栏顶栏卡片 `.menu-control-card` 高度对齐 `.navigation`（取 `--nav-height`，不再跟随 79px 的占位带），并把左边界外扩 `-1vw` 抵消侧栏内边距、一直铺到窗口左边缘
- 侧栏顶部的 `.menu-control` 占位移到 `.sidebar` 顶层（不再裹在滚动容器里），与右侧 `.navigation` 同一横带
- 顶栏去掉 `common2.css` 留的 20px 右外边距，铺到窗口右边缘
- 顶栏留白改由 `.page` 的 `padding-top: var(--nav-height)` 给：padding 属于 `.page` 自己的盒子，那块区域仍是面板、自定义背景的玻璃盖得住（此前放在 `.page` 外面的空 div 会露出一条没有玻璃的壁纸）
- 侧栏网易云 / QQ 音乐标识改为单色（`currentColor` 跟随主题深浅）：保留原图标几何、只留中间标记（去掉外层方框与被裁掉的文字层），线条由 2.6px 收细到约 2.0px，音符下部开口处为空心圆
- `docs/CONVENTIONS.md` 补 CHANGELOG 纪律：默认写 `[Unreleased]`、`Fixed` 自审归因、详略度对齐 `1.0.0`、只在被要求时提交

### Removed

- 经典主题族整体移除：white / black 两套主题、`css/compat-classic.css` / `css/classic-player.css` / 经典 palette（`iparanoid.css` / `origin.css`）/ 运行期已无引用的 `css/common.css`、`listen1.html` 的 `.classic-player` 分支、`_THEME_WHITE` 与 `_THEME_BLACK` 两个 i18n 键；`data-theme-family` 机制与 `useModernTheme()` 一并拆掉，老用户存下的 white / black 按深浅迁到 white2 / black2
- 清掉四个已废弃的样式文件：`css/player.css`、`css/cover.css`、`css/reset.css`、`css/hotkeys.css`（运行期均无引用，`hotkeys.css` 的 `<link>` 一并从 `listen1.html` 移除）

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
