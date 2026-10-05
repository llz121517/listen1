# Listen 1 — 项目索引

> 一份"从零读懂这个仓库"的导读：结构、加载顺序、运行时链路、模块职责与改动入口。
> 本文档是索引，不是教程；每个结论都尽量给出可直接跳转的 `文件:行号`。

| 项 | 值 |
| --- | --- |
| 项目 | Listen 1（Chrome / Firefox 扩展，同时作为 Listen1 桌面版渲染层） |
| 版本 | `Liuli-1.0.0`（本 fork 独立编号；`package.json`/`package-lock.json` 写 `Liuli-1.0.0`，`manifest*.json` 写纯数字 `1.0.0` + `version_name`，界面展示值在 `config/about.json`） |
| 一句话 | 聚合网易云 / QQ / 酷狗 / 酷我 / B 站 / 咪咕 / 千千音乐的搜索与播放，本地歌单 + Gist 云备份 + Last.fm scrobble |
| 技术栈 | 原生 ES6 + AngularJS 1.x + Howler.js + axios + i18next + forge，**无打包器/无构建步骤**，全部靠 `<script>` 顺序加载 |
| 入口 | `listen1.html`（扩展页面）/ `js/background.js`（MV3 service worker） |
| 规模 | 非 vendor JS 10,428 行 / 28 文件；CSS 6,604 行；i18n 1,225 行；`listen1.html` 4,241 行 |
| 仓库 | https://github.com/listen1/listen1_chrome_extension （本工作区 remote: `llz121517/listen1`，分支 `master`） |
| License | MIT（`LICENSE`） |

> **fork 与版本方案**：本仓库是 [llz121517/listen1](https://github.com/llz121517/listen1)，fork 自 [listen1/listen1_chrome_extension](https://github.com/listen1/listen1_chrome_extension)。
> 版本号自 `Liuli-1.0.0` 起独立编号，以避免与上游 `2.33.0` 混淆；上游更新日志已归档到 [`docs/archive/`](docs/archive/)，本 fork 的日志见 [`CHANGELOG.md`](CHANGELOG.md)。
> 浏览器扩展清单的 `version` 只接受 1~4 段纯数字（Chrome / Firefox 均不接受字母与连字符），因此 `manifest.json` / `manifest_firefox.json` 写 `1.0.0`，用 `version_name` 承载 `Liuli-1.0.0`；`package.json` / `package-lock.json` 直接写 `Liuli-1.0.0`（npm 11 的 `install`/`ci`/`pack` 实测接受）。

---

## 目录

- [1. 快速开始](#1-快速开始)
- [2. 目录结构](#2-目录结构)
- [3. 架构总览](#3-架构总览)
- [4. 启动顺序](#4-启动顺序)
- [5. 运行时核心链路](#5-运行时核心链路)
- [6. 模块索引](#6-模块索引)
  - [6.1 基础设施层](#61-基础设施层)
  - [6.2 服务层](#62-服务层)
  - [6.3 Provider 音乐源层](#63-provider-音乐源层)
  - [6.4 AngularJS 控制器层](#64-angularjs-控制器层)
  - [6.5 扩展/后台层](#65-扩展后台层)
  - [6.6 第三方库](#66-第三方库vendor)
- [7. UI 结构（listen1.html）](#7-ui-结构listen1html)
- [8. 主题、样式、i18n 与静态资源](#8-主题样式i18n-与静态资源)
- [9. 数据存储与扩展 API](#9-数据存储与扩展-api)
- [10. 外部集成](#10-外部集成)
- [11. 工具链、Lint 与 CI](#11-工具链lint-与-ci)
- [12. 已知问题与技术债](#12-已知问题与技术债)
- [13. 速查：改哪里](#13-速查改哪里)
- [14. 相关文档](#14-相关文档)

---

## 1. 快速开始

**没有 `npm install` 也可以跑**：仓库里没有任何构建产物依赖，`node_modules` 只服务于 lint。

```bash
# 代码检查（CI 用的就是这一条）
npx eslint .
```

加载扩展：

1. **Chrome / Edge**：`chrome://extensions` → 开发者模式 → "加载已解压的扩展程序" → 选择仓库根目录（`manifest.json`，Manifest V3）。
2. **Firefox**：用 `manifest_firefox.json` 内容替换 `manifest.json`（Manifest V2），再 `zip -r ../listen1.xpi *` 打包安装；或 `about:debugging` 临时加载。
3. 点击扩展图标 → `js/background.js:3-12` 打开 `chrome.runtime.getURL('listen1.html')`。

没有 dev server、没有 HMR：**改完 JS/CSS/HTML 后重新加载扩展（或刷新 `listen1.html` 页面）即可**。修改 `manifest.json` 必须重新加载扩展。

---

## 2. 目录结构

```text
listen1/
├── listen1.html              4,241 行  唯一 UI 页面（含两套主题布局，见 §7）
├── manifest.json                        Manifest V3：Chrome/Edge
├── manifest_firefox.json                Manifest V2：Firefox
├── rules_1.json                         声明式网络请求规则（改 Referer/UA 绕过防盗链，见 §9）
├── package.json                         仅 devDependencies（eslint/prettier/husky），version Liuli-1.0.0
├── .eslintrc.json .prettierrc .gitignore
├── .github/workflows/eslint.yml         CI：push/PR 到 master 跑 npx eslint .
├── README.md / README_EN.md             中文/英文说明与更新日志
├── LICENSE                              MIT
├── js/
│   ├── app.js                    508    AngularJS 模块、指令、i18next 初始化
│   ├── bridge.js                  91    UI ↔ 播放器（front/background 双模式）消息桥
│   ├── player_thread.js          665    音频引擎（Howler 封装、播放列表、进度事件）
│   ├── l1_player.js              238    播放器门面 window.l1Player（UI 唯一调用入口）
│   ├── loweb.js                  444    服务层 MediaService：Provider 注册表 + 播放地址解析 + 自动切源
│   ├── lowebutil.js              115    通用工具（cookie、localStorage 扩展、isElectron…）
│   ├── myplaylist.js             262    本地歌单存储（localStorage 实现）
│   ├── github.js                 187    GitHub Gist 备份/恢复 + OAuth
│   ├── lastfm.js                 249    Last.fm 授权与 scrobble
│   ├── background.js             213    MV3 service worker（打开页面、OAuth 回调转发）
│   ├── oauth_callback.js          15    内容脚本：抓 GitHub OAuth code 回传后台
│   ├── controller/                      AngularJS 控制器（8 文件，2,137 行）
│   │   ├── play.js               917    播放状态、歌词、设置项、快捷键、BG_PLAYER 消息处理
│   │   ├── navigation.js         705    视图路由、歌单/对话框操作、备份导入导出
│   │   ├── profile.js            198    语言、主题、代理、版本检查
│   │   ├── instant_search.js     139    多平台搜索页
│   │   ├── playlist.js            73    歌单详情页
│   │   ├── platform.js            58    "我的平台"（平台歌单）页
│   │   ├── auth.js                49    各平台登录状态
│   │   └── my_playlist.js         43    侧栏歌单列表
│   ├── provider/                       音乐源适配器（9 文件，5,257 行，见 §6.3）
│   │   ├── netease.js            962    网易云
│   │   ├── migu.js               921    咪咕
│   │   ├── qq.js                 867    QQ 音乐
│   │   ├── kuwo.js               790    酷我
│   │   ├── kugou.js              515    酷狗
│   │   ├── bilibili.js           479    B 站（含 wbi 签名）
│   │   ├── taihe.js              391    千千音乐（百度）
│   │   ├── localmusic.js         180    本地导入音乐（localStorage）
│   │   └── xiami.js              152    虾米（空实现占位，见 §12）
│   └── vendor/                         10 个第三方库（3,965 行，勿手改）
├── css/                        6,604 行  13 个文件（含 3 个已废弃，见 §8）
├── i18n/                       7 语言 × 173 键，扁平结构
├── fonts/                      listen1-icon 图标字体 4 种格式
├── config/                     about.json（「关于」页信息）、languages.json（语言清单）
└── images/                     logo、图标雪碧图、加载动画、默认封面等
```

---

## 3. 架构总览

```text
┌──────────────────────────────────────────────────────────────────────┐
│  listen1.html（AngularJS 视图，4293 行，两套主题布局）                │
│  ┌────────────────┬──────────────────┬───────────────────────────┐   │
│  │ Profile        │ Navigation       │ Play (playCtrl)           │   │
│  │ 主题/语言/代理 │ 视图路由/对话框  │ 播放状态/歌词/设置/快捷键 │   │
│  └────────────────┴──────────────────┴───────────────────────────┘   │
└───────────┬──────────────────────────────────────┬───────────────────┘
            │ window.l1Player (§6.1)               │ MediaService (§6.2)
            ▼                                      ▼
┌───────────────────────────┐        ┌──────────────────────────────────┐
│ l1_player.js  门面         │        │ loweb.js  MediaService           │
│  → bridge.js  消息桥       │        │  ├ PROVIDERS 注册表              │
│  → player_thread.js 引擎   │───────▶│  ├ playlistCache (LRU 1h)        │
│    └ Howler(html5) 播放    │ 取地址 │  └ bootstrapTrack 自动切源       │
└───────────────────────────┘        └───────────┬──────────────────────┘
                                                 │ 静态类调用
                                                 ▼
                    ┌────────────────────────────────────────────────┐
                    │ provider/*.js  网易云 QQ 酷狗 酷我 B站 咪咕…   │
                    │ 各自 axios 请求 + 签名/加密 + 字段归一化        │
                    └────────────────────────────────────────────────┘
                                                 │
        myplaylist.js（本地歌单）  github.js（Gist 备份）  lastfm.js（scrobble）
                    全部基于 localStorage + chrome.cookies
```

分层规则（重要）：

- **Provider 只被 `loweb.js` 调用**，控制器不直接碰 Provider（唯一例外见 `play.js:663` 走的是 `MediaService.getLyric`）。
- **UI 不直接操作 `threadPlayer`**，一律经 `l1Player` 门面；`threadPlayer` 是播放引擎单例（`player_thread.js:617-619`）。
- Provider 方法是 **静态类 + 回调式伪 Promise**（`{ success(fn) {...} }`），不是真 Promise，见 §6.3 契约。

---

## 4. 启动顺序

`listen1.html` 顶部脚本顺序是硬约束（无模块系统，靠全局变量与执行顺序）：

| 行 | 引入 | 为什么在这个位置 |
| --- | --- | --- |
| `listen1.html:23-28` | CommonJS `module` 垫片 | 让 vendor 库里的 UMD 判断走浏览器分支；`:74-76` 还原 |
| `:30` | `angular.min.js` | `ng-app="listenone"`（`:2`） |
| `:31-32` | `i18next` + HTTP backend | 供 `app.js:497-506` 初始化 |
| `:33-36` | `forge_listen1_fork.min.js` | Provider 加密/签名（AES/RSA/MD5） |
| `:37-42` | axios / notyf / howler / hotkeys / async / lru-cache | 全局 `axios`、`Notyf`、`Howl`、`hotkeys`、`async`、`LRUCache` |
| `:44` | `lowebutil.js` | `isElectron()`、`cookieGet`、`localStorage.getObject` 补丁、`getLocalStorageValue` |
| `:45-46` | `github.js` / `lastfm.js` | `window.GithubClient` / `window.lastfm` |
| `:47-55` | `provider/*.js` ×9 | 注册全局类 `netease`/`qq`/…，**必须早于 `loweb.js`** |
| `:57` | `bridge.js` | `getPlayer`/`playerSendMessage`，被 `l1_player.js`、`player_thread.js` 使用 |
| `:58` | `player_thread.js` | 立即 `new Player()` 并挂到 `window.threadPlayer`（`player_thread.js:617-619`） |
| `:59` | `myplaylist.js` | 单例 `myplaylist`，被 `loweb.js:71-75` 注册进 PROVIDERS |
| `:60` | `loweb.js` | `PROVIDERS` 表 + `MediaService`（别名 `loWeb`，`loweb.js:444`） |
| `:61` | `l1_player.js` | `window.l1Player`，读取 `enable_stop_when_close` 决定 front/background 模式 |
| `:62` | `app.js` | 创建 `listenone` 模块、注册指令、**最后**初始化 i18next 并 `main()` |
| `:63-73` | `controller/*.js` ×8 | 控制器必须晚于模块创建 |

> ⚠️ `profile.js` 在 `:63` 却使用了 `js/controller/platform.js:2` 定义的 `platformSourceList` ——
> 运行时按需访问，不构成加载顺序冲突，但阅读代码时容易误判。

---

## 5. 运行时核心链路

### 5.1 播放一首歌

```text
点击歌曲（ng-click / play-from-playlist 指令，l1_player.js:161-172）
  └─ l1Player.playById(id)
       └─ getPlayerAsync(mode, p => p.playById(id))            l1_player.js:36-40
            └─ Player.play(index)                              player_thread.js:198
                 └─ 无缓存地址 → retrieveMediaUrl(index, true) player_thread.js:209
                      └─ MediaService.bootstrapTrack(track)    loweb.js:338
                           ├─ provider.bootstrap_track(...)    kuwo.js:381 / netease.js / ...
                           │     success: {url, bitrate, platform}
                           └─ 失败 → 自动切源（§5.4）           loweb.js:341-398
                 └─ setMediaURI + finishLoad                   player_thread.js:266
                      └─ new Howl({ html5: true, format:'mp3' }) player_thread.js:273-278
                           └─ 设置 navigator.mediaSession 元数据 player_thread.js:280-296
```

### 5.2 进度 / 歌词 / 状态回传

```text
Howler 播放中
  └─ setInterval 10Hz → sendFrameUpdate()          player_thread.js:26-33, 552
       └─ playerSendMessage(this.mode, {type:'BG_PLAYER:FRAME_UPDATE', data})
            ├─ front 模式：直接遍历 frontPlayerListener 回调   bridge.js:72-78
            └─ background 模式：chrome.runtime.sendMessage     bridge.js:81
                 └─ play.js:497-779 按 type 分发：
                      FRAME_UPDATE → 进度条 + 歌词行滚动（play.js:518-609）
                      LOAD         → MediaService.getLyric + parseLyric（play.js:663-674, 386）
                      PLAYLIST     → 写入 localStorage 'current-playing'（play.js:697）
                      PLAY_STATE   → 标题/isPlaying；reason==='Ended' 时 Last.fm scrobble（play.js:739-752）
```

播放器前/后台两种运行模式（`bridge.js:2-10` 注释即规格）：

| 模式 | 触发条件 | 音频跑在哪 | 通信方式 |
| --- | --- | --- | --- |
| `front` | `isElectron()` 为真，或 `localStorage.enable_stop_when_close` 为 true（默认 true） | 当前页面 | 内存回调数组 `frontPlayerListener` |
| `background` | 用户关闭"关闭时停止播放" | 后台页 | `chrome.runtime.sendMessage` + `BG_PLAYER:` 前缀 |

模式在 `l1_player.js:4-7`（门面）与 `play.js:482-487`（`getPlayer(mode).setMode(mode)`）两处独立推导，取值必须一致。⚠️ MV3 下 background 模式的可用性存疑，见 §12。

### 5.3 搜索

`InstantSearchController`（`instant_search.js`）→ `MediaService.search(source, {keywords, curpage, type})`（`loweb.js:122-151`）：
- 单平台：直接调 `provider.search(构造的伪 URL)`；
- `allmusic`：`async.parallel` 并发所有 `searchable` 平台，再交错合并结果；
- 伪 URL 形如 `/search?keywords=xxx&curpage=1`，**不会真发请求**，Provider 用 `getParameterByName` 解析（`lowebutil.js:5`）。

### 5.4 自动切源（V2.9.0 特性）

`loweb.js:338-398`：当 `provider.bootstrap_track` 失败时，若 `enable_auto_choose_source !== false`，
按 `auto_choose_source_list`（默认 `['kuwo','qq','migu']`，`play.js:158-165`）依次搜索 `"标题 歌手"`，
要求 `title` 与 `artist` **完全一致**，首个成功者胜出（实现上借用了 `reject(sound)` 的技巧，`loweb.js:393-397`）。

### 5.5 歌单缓存

单一 `playlistCache = new LRUCache({ max: 100, maxAge: 3600000 })`（`loweb.js:103-106`）；
`myplaylist` 与 `localmusic` 跳过缓存（`loweb.js:209`）；`getPlaylist(listId, useCache)` 可显式绕过（`loweb.js:193`）。

---

## 6. 模块索引

### 6.1 基础设施层

| 文件 | 行数 | 职责 | 关键符号 |
| --- | --- | --- | --- |
| `js/lowebutil.js` | 115 | 无依赖工具集 | `isElectron():16`、`cookieGet/Set/Remove:20/38/49`（chrome.cookies + `@electron/remote` 双实现）、`setPrototypeOfLocalStorage():63`（给 localStorage 加 `getObject/setObject`）、`getLocalStorageValue:79`、`getParameterByName:5`、`smoothScrollTo:99`(歌词滚动) |
| `js/bridge.js` | 91 | UI↔播放器消息桥，定义 front/background 双协议 | `getPlayer/getPlayerAsync:26/36`、`addPlayerListener:62`、`playerSendMessage:84`、`getBackgroundPlayer:17`(MV2 API) |
| `js/l1_player.js` | 238 | 播放器门面，UI 唯一入口；维护 `status` 镜像 | `window.l1Player:237`；`play/pause/togglePlayPause/playById/loadById/seek/next/prev/random/setLoopMode/mute/setVolume/adjustVolume/addTrack/insertTrack/removeTrack/addTracks/clearPlaylist/setNewPlaylist:17-128`；`connectPlayer():133`（恢复上次播放）；`injectDirectives:161`（6 个播放指令） |
| `js/myplaylist.js` | 262 | 本地歌单 CRUD，纯 localStorage 实现，单例 | `myplaylistFactory():262`；`show_myplaylist:25`、`get_playlist:52`、`create_myplaylist:205`、`add_track_to_myplaylist:148`、`insert_myplaylist_to_myplaylists:78`；键名映射 `getPlaylistObjectKey:16-24` |

### 6.2 服务层

| 文件 | 行数 | 职责 | 关键符号 |
| --- | --- | --- | --- |
| `js/player_thread.js` | 665 | 音频引擎：播放列表状态机 + Howler 封装 + 事件发射 | `class Player:10`；`setRefreshRate:26`(10Hz)；`retrieveMediaUrl:209`；`finishLoad:266`；`skip:381`(含随机表)；`seek:506`/`seekTime:522`；发射器 `sendFrameUpdate:552`/`sendPlayingEvent:574`/`sendLoadEvent:584`/`sendVolumeEvent:600`/`sendPlaylistEvent:607`；mediaSession 动作 `:621-661`；单例 `:617-619` |
| `js/loweb.js` | 444 | Provider 注册表 + 服务门面（别名 `loWeb`） | `PROVIDERS:4-78`、`getProviderByName:80`、`getAllSearchProviders:88`、`getProviderByItemId:97`、`playlistCache:103`、`MediaService:116`、`search:122`、`getPlaylist:193`、`getLyric:171`、`bootstrapTrack:338`、`parseURL:302`、`mergePlaylist:325`、`clonePlaylist:217`、`loWeb = MediaService:444` |
| `js/github.js` | 187 | GitHub OAuth + Gist 备份/恢复 | `window.GithubClient:26`；`.github`: `handleCallback:28`、`openAuthUrl:49`、`getStatusText:68`、`updateStatus:80`、`logout:97`；`.gist`: `json2gist:104`、`gist2json:138`、`listExistBackup:150`、`backupMySettings2Gist:159`、`importMySettingsFromGist:180`；axios 拦截器注入 token `:14-19` |
| `js/lastfm.js` | 249 | Last.fm 授权 + now playing + scrobble | `window.lastfm:248`；`generateSign:31`(forge MD5)、`getAuth:141`、`getSession:57`、`sendNowPlaying:169`、`scrobble:195`、`isAuthorized:226` |
| `js/app.js` | 508 | AngularJS 模块装配：全局指令、toast、i18next 引导 | `sourceList:10-39`（7 平台 tab）、`main():41`、`l1Player.injectDirectives:110`、指令 `pagination:142`/`errSrc:150`/`addAndPlay:179`/`addWithoutPlay:194`/`openUrl:209`/`windowControl:229`/`infiniteScroll:247`/`dragDropZone:287`/`draggableBar:413`；`i18next.init:497-506` |

### 6.3 Provider 音乐源层

**接口契约**（每个文件导出一个同名全局静态类，`loweb.js:6-78` 注册为 `instance`）：

| 方法 | 入参 | 回调载荷 |
| --- | --- | --- |
| `search(url)` | 伪 URL（`keywords`/`curpage`/`type`） | `{result:[track], total, type}`，`type` `'0'` 歌曲 / `'1'` 歌单 |
| `show_playlist(url)` | 含 `offset` / `filter_id` | `{result:[playlist]}` |
| `get_playlist_filters()` | — | `{recommend:[{id,name}], all:[{category, filters:[…]}]}` |
| `get_playlist(url)` | `list_id` 前缀派发 | `{tracks, info}` |
| `parse_url(url)` | 平台 URL | `{type:'playlist', id:'<2位前缀>_<id>'}` 或 `undefined` |
| `bootstrap_track(track, success, failure)` | track | `success({url, bitrate, platform})` / `failure({})` |
| `lyric(url)` | 歌词 URL | `{lyric, tlyric}` |
| `get_user()` | — | `{status, data:{is_login, user_id, nickname, avatar, platform, data}}` |
| `get_login_url()` / `logout()` | — | 登录 URL / 清 cookie |
| `login(url)` | 仅 `netease.js:750` 实现 | — |
| 平台歌单三件套 | `get_user_created_playlist` / `get_user_favorite_playlist` / `get_recommend_playlist` | 仅 netease、qq 实现 |
| 本地歌单两件套 | `add_playlist` / `remove_from_playlist` | 仅 `localmusic.js:103/148` |

返回值为 **回调式伪 Promise**：`{ success: (fn) => fn(payload) }`，**不是** 原生 Promise，也不支持 `catch`。

**统一 track 结构**（`qq.js:103-118`、`netease.js:249-260`）：
`{ id:'netrack_123', title, artist, artist_id, album, album_id, source, source_url, img_url, url?, lyric_url?, tlyric_url?, quality?, disable? }`；
**`url: ''` 是唯一的"不可播放"信号**；`id` 前缀（`ne/xm/qq/kg/kw/bi/mg/th/lm/my`）决定回落到哪个 Provider（`loweb.js:97`）。

| 文件 | 行数 | 全局类 | 主要端点 | 鉴权 | 关键实现点 |
| --- | --- | --- | --- | --- | --- |
| `js/provider/netease.js` | 962 | `netease` | `music.163.com/weapi/*`、`/api/search/pc`、`interface3.music.163.com/eapi/song/enhance/player/url` | cookie `MUSIC_U` | weapi = AES-CBC + RSA（硬编码 modulus/nonce/pubKey `:34-58`）；eapi = MD5 + `-36cd479b6b5-` AES-ECB（`:61-76`）；自动生成 `_ntes_nuid`/`NMTID`（`:161-216`）；`br:999000`、fee 1/4 跳过（`:397`） |
| `js/provider/qq.js` | 867 | `qq` | `u.y.qq.com/cgi-bin/musicu.fcg`、`c.y.qq.com`、`i.y.qq.com`、`y.gtimg.cn` | cookie `uin`/`wxuin` | module/method JSON POST；硬编码 `g_tk`；音质硬编码降级 128kbps（`:427-428`）；榜单靠 HTML 正则抓取（`:156-181`） |
| `js/provider/kugou.js` | 515 | `kugou` | `mobilecdnbj.kugou.com/api/v3`、`m.kugou.com/app/i/getSongInfo.php`、`songsearch.kugou.com` | 无 | 移动端 API；歌词为 JSONP 字符串切割后 `JSON.parse`（`:340`）；逐曲 N+1 请求 |
| `js/provider/kuwo.js` | 790 | `kuwo` | `www.kuwo.cn/api/www/*`、`/api/pc/classify/*`、`nplserver.kuwo.cn/pl.svc`、`m.kuwo.cn/newh5/singles/songinfoandlrc` | cookie `Hm_Iuvt_*` → `Secret` 头 | 移植的混淆函数 `h(t,e):5-47`；token 失效自动重取并重试一次（`:232-292`）；100/页 `async.concat` |
| `js/provider/bilibili.js` | 479 | `bilibili` | `api.bilibili.com/x/web-interface/*`、`/x/space/wbi/*`、`/x/player/playurl` | 搜索需 `buvid3='0'`（`:396`） | **wbi 签名**：nav → img/sub key → 64 项混淆表 → `md5(query+mixin_key)` 得 `w_rid`（`:12-110`）；同时支持音频稿件与视频稿件（取 `dash.audio[0].baseUrl`）；`lyric()` 空实现（`:423`） |
| `js/provider/migu.js` | 921 | `migu` | `app.c.nf.migu.cn/MIGUM2.0 \| MIGUM3.0/*`、`app.u.nf.migu.cn/pc/*`、`music.migu.cn/v3/api/*` | 无（logout 清 13 个 cookie） | `toneFlag` PQ/HQ/SQ/ZQ 由 `track.quality` 位推导（`:508-515`）；榜单解析 `script[1]` 内联 JSON（`:297-302`）；50/页 |
| `js/provider/taihe.js` | 391 | `taihe` | `https://music.taihe.com/v1`（独立 axios 实例 `axiosTH`） | 无 | 请求拦截器加 `timestamp` + `appid=16073360` + `sign=md5(排序后的 query + secret)`（`:6-26`）；不支持歌单搜索（`:68`） |
| `js/provider/localmusic.js` | 180 | `localmusic` | 无网络请求 | 无 | 数据存 localStorage；唯一实现 `add_playlist`/`remove_from_playlist` 的 Provider；`hidden: true` |
| `js/provider/xiami.js` | 152 | `xiami` | 无 | 无 | **全部方法返回空数组/触发 failure**：虾米已停服，仅为兼容旧歌单保留（`hidden: true`） |

> 绕过防盗链：MV3 用 `rules_1.json`（`declarativeNetRequest`）改写 Referer/UA；
> `background.js:14-193` 里旧的 `hack_referer_header`（`webRequest.onBeforeSendHeaders`）**整段被注释**，仅 MV2 曾用。

### 6.4 AngularJS 控制器层

| 文件 | 行数 | 控制器 | `ng-controller` 位置 | 职责要点 |
| --- | --- | --- | --- | --- |
| `js/controller/profile.js` | 198 | `ProfileController` | `listen1.html:81`（包裹两套布局） | 语言（`setLang:149`，按钮清单来自 `config/languages.json`）、主题（`setTheme:175`）、代理由 Electron IPC 管理（`setProxyConfig:46` / `getProxyConfig:65` / 状态回调 `ipcRenderer.on:125`）、`initProfile:74` 拉取 `config/about.json`、`config/languages.json` 并查最新 release（fork 版查 `llz121517/listen1` 的 release，失败则隐藏该行） |
| `js/controller/play.js` | 917 | `PlayController` | `:88`、`:2096` | 播放状态、歌词渲染、`enable_*` 设置项、快捷键 `:786-815`（`p [ ] m l s u d`）、Electron 全局快捷键 `:835`、`BG_PLAYER:*` 消息分发 `:497-779`、`parseLyric:386` |
| `js/controller/auth.js` | 49 | `AuthController` | `:91`、`:2099` | 各平台登录状态 `musicAuth`、`refreshAuthStatus`、`openLogin` |
| `js/controller/navigation.js` | 705 | `NavigationController` | `:93`、`:2101` | 视图路由 `current_tag`、`showDialog(0-12)`、歌单增删改、拖拽排序、备份导入导出、`f` 聚焦搜索 `:605` |
| `js/controller/my_playlist.js` | 43 | `MyPlayListController` | `:364`、`:2372` | 侧栏"我的歌单/收藏歌单"，监听 `myplaylist:update` |
| `js/controller/instant_search.js` | 139 | `InstantSearchController` | `:478`、`:2499` | 多平台搜索、分页、`search:keyword_change` 广播（被 `navigation.js:60` 消费） |
| `js/controller/playlist.js` | 73 | `PlayListController` | `:537`、`:2562` | 精选歌单分类与列表 |
| `js/controller/platform.js` | 58 | `PlatformController` | `:629`、`:2660` | "我的平台"歌单；定义全局 `platformSourceList:2-15`（创建/收藏/推荐） |

控制器嵌套（A 套布局，B 套结构相同）：

```text
ProfileController (listen1.html:81)
└─ PlayController (:88) ── AuthController (:91) ── NavigationController (:93)
     └─ .main  MyPlayListController (:364)   .content  InstantSearchController (:478)
        ⋯ 内部再嵌 PlayListController (:537) / PlatformController (:629)
```

### 6.5 扩展/后台层

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `js/background.js` | 213 | MV3 service worker：点击图标开 `listen1.html`（`:3-12`）；监听 `{type:'code'}` 消息转 `GithubClient.github.handleCallback`（`:206-213`）；`:14-193` 为注释掉的 MV2 防盗链代码 |
| `js/oauth_callback.js` | 15 | 内容脚本，匹配 `https://listen1.github.io/listen1/*`，读取 `?code=` 并 `chrome.runtime.sendMessage({type:'code'})` |

### 6.6 第三方库（`js/vendor/`）

| 库 | 用途 |
| --- | --- |
| `angular.min.js` | MVVM 框架（AngularJS 1.x） |
| `howler.core.min.js` | 音频播放（`html5: true` 流式播放） |
| `axios.min.js` | HTTP 客户端（`app.js:56-59` 被包装成 `$q` Promise 以触发 digest） |
| `forge_listen1_fork.min.js` | 加密/摘要（AES、RSA、MD5），Provider 签名所需 |
| `i18next.min.js` + `i18nextHttpBackend.min.js` | 国际化 |
| `notyf.min.js` | toast 提示 |
| `hotkeys.min.js` | 键盘快捷键（hotkeys-js v3.8.3） |
| `async.min.js` | `parallel`/`concat` 并发控制 |
| `lru-cache.min.js` | 歌单缓存 |

---

## 7. UI 结构（listen1.html）

### 7.1 关键事实：整个布局写了两遍

`listen1.html` 用两个互斥的 `.body` 容器承载**两套完整布局**，由 `ng-if` 按主题族切换；
`ng-if` 会销毁 DOM，所以同一时刻只有一套控制器被实例化（这也是快捷键不会重复注册的原因）。

| 套 | 起始行 | 结束行 | `ng-if` | 特点 | 主题 CSS |
| --- | --- | --- | --- | --- | --- |
| A 经典 | `:82` | `:2060` | `theme==='white' \|\| theme==='black'` | 扁平 `.sidebar-block`，歌词在内容区 | `iparanoid.css`/`origin.css` + `common.css` |
| B 新版 | `:2061` | `:4225` | `theme==='white2' \|\| theme==='black2'` | 可折叠侧栏、封面背景、`#rotatemark` 动画、歌词在页脚内 | `iparanoid2.css`/`origin2.css` + `common2.css` |

映射表在 `js/controller/profile.js:178-183`，切换时改写 `#theme-css`/`#common-css` 的 `href`。
外层 `ProfileController` 容器在 `:81`，闭合于 `:4226`，因此语言/主题状态只有一份。

> ⚠️ **行号说明（2026-10-06 起的 fork 改动）**：fork 把两套布局里硬编码的语言按钮换成了 `ng-repeat`（A `:893-899` / B `:2946-2952`），并把设置页「关于」信息改为绑定 `config/about.json`；因此 `listen1.html` 总行数由上游的 4,293 降为 **4,241**，本节 A/B 边界与相关行号为实测值。§7.2 / §13 中 `listen1.html` 的行号多数由上游 4,293 行基线推算、未逐一复核，检索时请优先用 `current_tag==` / `window_type==` / 键名定位，行号仅作参考。

**维护含义：改 UI 必须同步改两处**（A 套行号 × B 套行号见下表）。

### 7.2 区块索引（A 套行号，方括号为 B 套）

| 区块 | A 套 | B 套 |
| --- | --- | --- |
| 对话框/遮罩层（12 个 `dialog_type`） | `:96-362` | `[2103-2370]` |
| 左侧歌单栏 | `:365-477` | `[2373-2498]` |
| 顶部导航 + `#search-input` | `:479-532`（搜索框 `:490`） | `[2500-2557]`（搜索框 `:2514`；`:3743` 另有一个列表内搜索框） |
| 精选歌单（`current_tag==2`，A 起始 `:536` / B `:2561`） | `:533-624` | `[2558-2658]` |
| 我的平台（`current_tag==6`，A `:628` / B `:2659`） | `:625-676` | `[2659-2715]` |
| 搜索结果（`current_tag==3`，A `:680` / B `:2716`） | `:677-879` | `[2716-2964]` |
| **设置页**（`current_tag==4`，A `:883` / B `:2965`，含快捷键表 `:1283-1411`） | `:880-1482` | `[2965-3562]` |
| 登录页（`current_tag==5`，A `:1486` / B `:3563`） | `:1483-1525` | `[3563-3612]` |
| 曲目列表窗（`window_type=='list'`，A `:1530` / B `:3613`） | `:1526-1730` | `[3613-3852]` |
| 正在播放窗（`window_type=='track'`） | `:1731-1833` | `[3847-3848]`（B 套把歌词移进页脚） |
| **播放器栏/页脚** | `:1834-2088` | `[3853-4276]` |
| 播放队列抽屉（`.menu-modal`/`.menu`） | `:1987-2088` | `[4184-4270]` |

### 7.3 快捷键

绑定处（`hotkeys-js`，全局 `hotkeys`）：

| 键 | 行为 | 位置 |
| --- | --- | --- |
| `p` | 播放/暂停 | `play.js:786` |
| `[` / `]` | 上一首 / 下一首 | `play.js:789/792` |
| `m` | 静音切换 | `play.js:795` |
| `l` | 播放列表抽屉 | `play.js:798` |
| `s` | 循环播放模式 | `play.js:801` |
| `u` / `d` | 音量 + / − | `play.js:804/811` |
| `f` | 打开搜索并聚焦输入框 | `navigation.js:605` |

页面上可见的快捷键表是**手写标记**而非自动生成（`:1283-1411` / `:3359-3487`），且 `m`、`l` 两行被注释掉却仍在生效 —— 改快捷键时必须同时改绑定与这张表。Electron 另有全局快捷键（左/右/空格，`play.js:835`）。

---

## 8. 主题、样式、i18n 与静态资源

| CSS | 行数 | 状态 | 用途 |
| --- | --- | --- | --- |
| `css/common.css` | 1,802 | 使用中 | 经典布局主体 |
| `css/common2.css` | 2,734 | 使用中 | 新版布局主体 |
| `css/iparanoid.css` / `css/origin.css` | 2,560 / 2,603 B | 使用中 | 经典主题的浅色（white）/ 深色（black）变量 |
| `css/iparanoid2.css` / `css/origin2.css` | 2,193 / 2,110 B | 使用中 | 新版主题的浅色（white2）/ 深色（black2）变量 |
| `css/notyf.min.css` + `css/notyf_custom.css` | vendor + 7 行 | 使用中 | toast 样式与定制 |
| `css/icon.css` | 1,803 B | 使用中 | `@font-face listen1-icon` 与 `.li-*` 图标类 |
| `css/hotkeys.css` | 1,965 B | **废弃** | angular-hotkeys 的样式，但该库从未加载 |
| `css/player.css` | 1,225 行 | **废弃** | 旧播放器皮肤，无引用 |
| `css/cover.css` / `css/reset.css` | 3,537 / 1,041 B | **废弃** | Bootstrap Cover 模板残留 / reset |

- **i18n**：`i18n/{zh-CN,zh-TC,en-US,fr-FR,ko-KR,pt-BR,ja-JP}.json`，**扁平无命名空间**，7 个语言各 173 个键且键集与键序完全一致；其中 162 个键以 `_` 开头（如 `_ALL_MUSIC`、`_ADD_TO_PLAYLIST`），另有 11 个非下划线键：`HELLO`、`ZOOM_IN_OUT` 以及 9 个平台名（`netease`/`bilibili`/`kugou`/`kuwo`/`migu`/`qq`/`xiami`/`taihe`/`localmusic`）。加载器为 `i18nextHttpBackend`（`app.js:497` 起），默认与回退语言均为 `zh-CN`；fork 起改为 `supportedLngs: false` + `preload: ['zh-CN']`（`app.js:502-503`），**不再需要维护语言白名单**。语言按钮由 `ng-repeat` 动态生成（A `listen1.html:893-899` / B `:2946-2952`），语言清单来自 `config/languages.json`，按钮文本取自各语言文件自己的 `_LANGUAGE_NAME`（由 `profile.js:86-105` 加载）。`profile.js` 的首次运行自动探测仍只在 `zh-CN`/`en-US` 间选择（`detectedLangs`），但 `setLang` 可切到全部 7 种。**新增文案必须 7 个文件同步加键。**
- **字体**：`fonts/listen1-icon.{eot,svg,ttf,woff}`。
- **图片**：`logo*.png`/`favicon.ico`（清单与页面图标）、`mycover.jpg`（默认歌单封面）、`placeholder.png`（登录卡占位）、`feather-sprite.svg`（运行时注入 `#feather-container`，供 `<use>` 引用）、`loading.svg`/`loading-1.gif`（加载态）；`netease-logo.png` 与 `loading.gif`、`player_*.png`、`progress_indicator.png`、`statbar.png` 已无有效引用。

---

## 9. 数据存储与扩展 API

### 9.1 localStorage 键

| 键 | 写入位置 | 用途 |
| --- | --- | --- |
| `playerlists` | `myplaylist.js:19,130` | 自建歌单 id 索引 |
| `favoriteplayerlists` | `myplaylist.js:21,130` | 收藏歌单 id 索引 |
| `<playlist_id>`（如 `myplaylist_<guid>`） | `myplaylist.js:131,172,191,202,235` | 歌单对象（信息 + 曲目） |
| `player-settings` | `l1_player.js:148`、`app.js:448,450`、`play.js:129,315,646,648` | 当前曲目 id、播放模式、UI 设置 |
| `current-playing` | `l1_player.js:139`、`play.js:697` | 退出前的播放列表快照，用于恢复 |
| `githubOauthAccessKey` | `github.js:15,43,81,98` | GitHub token |
| `lastfmtoken` / `lastfmsession` | `lastfm.js:51,64,153,165` / `:59,84,164` | Last.fm 授权 token / 会话 |
| `gistid` | `navigation.js:552` | 备份时排除的遗留键 |
| `enable_auto_choose_source` / `auto_choose_source_list` | `loweb.js:342,347`、`play.js:850,861,874` | 自动切源开关与源顺序 |
| `enable_stop_when_close` | `l1_player.js:5`、`play.js:167,483,882` | 决定 front/background 播放模式 |
| `enable_lyric_translation` / `enable_lyric_floating_window[_translation]` / `float_window_setting` | `play.js:819,234,828,300` | 歌词翻译与悬浮窗 |
| `enable_nowplaying_cover_background` / `_bitrate` / `_platform` / `enable_global_shortcut` | `play.js:893,902,911,212` | 正在播放页外观与全局快捷键 |
| `theme` / `language` / `openSidebar` | `profile.js:172,18`、`navigation.js:40` | 应用偏好 |

> Gist 备份会把这些键整体上传（`navigation.js:509-556`，排除 `gistid`、`githubOauthAccessKey`）。

### 9.2 chrome.* API 使用点

| API | 位置 | 说明 |
| --- | --- | --- |
| `chrome.cookies.get/set/remove` | `lowebutil.js:22,40,51` | 全项目唯一的 cookie 读写点（Electron 走 `@electron/remote`） |
| `chrome.runtime.sendMessage` | `bridge.js:81`、`oauth_callback.js:5` | 后台播放器消息 / OAuth code |
| `chrome.runtime.onMessage` | `bridge.js:52`、`background.js:206` | `BG_PLAYER:` 前缀过滤 / `type:'code'` |
| `chrome.action.onClicked`、`chrome.tabs.create`、`chrome.runtime.getURL` | `background.js:3-8` | 打开播放器页面 |
| `chrome.extension.getBackgroundPage` / `chrome.runtime.getBackgroundPage` | `bridge.js:17,21` | **MV2 专有 API**，见 §12 |
| `chrome.notifications`、`chrome.downloads` | 清单已声明（`notifications` 在 MV3+MV2，`downloads` 仅 MV2），**代码中无调用** | 导出实际用 Blob + `<a download>`（`navigation.js:500-506`） |

### 9.3 请求改写规则（`rules_1.json`）

| # | 匹配 | 动作 |
| --- | --- | --- |
| 1 | `\|*.y.qq.com`（main_frame + xmlhttprequest） | 设 `referer`、`origin` = `https://y.qq.com/` |
| 2 | `\|*.kugou.com`（main_frame + xmlhttprequest） | 设 `user-agent` = iPhone Safari UA |
| 3 | `\|*.bilivideo.com/`（**media**） | 设 `referer` = `https://www.bilibili.com/` |

作用：绕过各平台的 Referer/UA 防盗链校验。清单中 `declarativeNetRequest` 权限与 `host_permissions`（15 条）与此配套（`manifest.json:17-48`）。
Firefox 的 MV2 清单**不支持** `declarativeNetRequest`，而对应的 `webRequest` 代码又被注释，导致 Firefox 侧改写能力缺失（见 §12）。

---

## 10. 外部集成

### 10.1 GitHub Gist 备份/恢复（`js/github.js`）

```text
授权：openAuthUrl(:49) → github.com/login/oauth/authorize?scope=gist
      → 回调页 listen1.github.io/listen1?code=…
      → js/oauth_callback.js 抓 code → chrome.runtime.sendMessage({type:'code'})
      → js/background.js:206 转 GithubClient.github.handleCallback(:28)
      → POST /login/oauth/access_token → localStorage 'githubOauthAccessKey'(:43)
备份：navigation.js:509 收集 localStorage 全部设置 → json2gist(:104) 生成 listen1_backup.json
      + 每个歌单一份 markdown → backupMySettings2Gist(:159) POST/PATCH /gists
恢复：listExistBackup(:150) 列出描述以 "updated by Listen1" 开头的 gist → importMySettingsFromGist(:180)
```

⚠️ 源码中硬编码了 OAuth `client_id` / `client_secret`（`github.js:7-8`）。

### 10.2 Last.fm（`js/lastfm.js`）

`getAuth(:141)` 取 token（存 `lastfmtoken`）→ 跳 `last.fm/api/auth` 授权 → `getSession(:57)` 换 `lastfmsession`；
播放时 `sendNowPlaying(:169)`，曲终 `reason==='Ended'` 时 `scrobble(:195)`（调用点 `play.js:660-661`、`740-751`）。
签名算法 `generateSign(:31)`：`md5(排序后的参数串 + secret)`，用 forge 实现。

UI 入口在 `listen1.html` 的 ng-click 绑定（`:884`、`:1258-1273`）。

---

## 11. 工具链、Lint 与 CI

| 项 | 内容 |
| --- | --- |
| 包管理 | `package.json` 仅 devDependencies：eslint 7 + airbnb-base + prettier 8 + husky 4 + lint-staged 10 |
| 脚本 | `npm test` 是占位（`exit 1`），**没有测试套件** |
| ESLint | `.eslintrc.json`：`ecmaVersion: 11`，继承 `airbnb-base` + `prettier`，关闭 `camelcase`、`linebreak-style`；忽略 `**/vendor/*.js` |
| Prettier | `.prettierrc`：`singleQuote: true`、`trailingComma: "es5"` |
| 提交钩子 | husky pre-commit → lint-staged：非 vendor 的 `.js` 跑 `eslint --cache --fix`，`.js/.css/.md` 跑 `prettier --write` |
| CI | `.github/workflows/eslint.yml`：push/PR 到 `master`，Node 16，`npm ci` + `npx eslint .` |
| 构建 | **无**。发布即源码；Firefox 需手动替换清单并打包 xpi |

### 清单差异（MV3 vs MV2）

| 项 | `manifest.json`（Chrome/Edge，MV3） | `manifest_firefox.json`（Firefox，MV2） |
| --- | --- | --- |
| 后台 | `background.service_worker: js/background.js` | `background.scripts: [axios, github.js, background.js, howler.core, bridge.js, player_thread.js]`，`persistent: true` |
| 入口按钮 | `action` | `browser_action` |
| 权限 | `notifications, unlimitedStorage, cookies, declarativeNetRequest` | `notifications, unlimitedStorage, downloads, storage, contextMenus, tabs, cookies` + `webRequest, webRequestBlocking` |
| 域名 | 独立 `host_permissions`（15 条，含 `bilivideo.cn`） | 内联进 `permissions`（无 `bilivideo.cn`） |
| 网络改写 | `declarative_net_request` → `rules_1.json` | 无（依赖已注释的 webRequest 代码） |
| 可访问资源 | 对象形式 + `matches` | 字符串数组 `["images/*"]` |
| Gecko | — | `applications.gecko.id: githublisten1@gmail.com`，`strict_min_version: 45.0` |

> Firefox 清单把 `github.js`/`player_thread.js` 等显式加载进后台页（MV2 后台页有 `localStorage` 与 DOM），
> 这正是 MV3 版本丢失的能力，见 §12。

---

## 12. 已知问题与技术债

按"是否影响使用"排序，均已核对源码：

1. **MV3 下 background 播放模式不可用（结构性）** —— `bridge.js:17,21` 使用 MV2 专有的 `chrome.extension.getBackgroundPage` / `chrome.runtime.getBackgroundPage`，而 `manifest.json:15` 是 MV3（无后台页，只有 service worker）。
   *现状*：`l1_player.js:4-7` 默认 `enable_stop_when_close=true` → 走 `front` 模式，因此默认路径正常；只有用户手动关闭"关闭时停止播放"才会命中。
2. **GitHub OAuth 回调在 MV3 下失效** —— `oauth_callback.js:5` 把 code 发给扩展，`background.js:206-213` 调用全局 `GithubClient`，但 `manifest.json` 的 service worker **没有 `importScripts`**，`github.js` 从未被加载；且 `github.js:43,15` 依赖 `localStorage`（MV3 worker 中不存在）。
   *影响*：Chrome 新版下 Gist 授权链路断裂（Firefox MV2 清单显式加载了 `github.js`，不受影响）。
3. **Firefox 侧请求头改写失效** —— 唯一生效机制是 MV3 的 `rules_1.json`，MV2 清单不支持 `declarativeNetRequest`；而 `background.js:14-193` 的 `webRequest` 实现整段被注释。
   *影响*：QQ/酷狗/B 站等对被墙外链较敏感的源在 Firefox 上可能播不出声。
4. **虾米 Provider 是空壳** —— `provider/xiami.js` 全部方法返回空结果，`bootstrap_track` 直接 `failure({})`；但它仍被注册进 `PROVIDERS`（`loweb.js:13-19`，`hidden: true`）并随 MV3 一起加载。
5. **`player_thread.js:662` 的 READY 消息丢失** —— 该行位于块级顶层而非 `Player` 方法内，`this` 不是实例（构造器里 `this.mode='background'`，`player_thread.js:18`），故 `this.mode` 为 `undefined`，`bridge.js:84-91` 两个分支都不命中。
6. **契约靠约定，无校验** —— Provider 只要漏实现 `login`、`get_recommend_playlist` 等可选方法，就在运行时抛错；`url: ''` 是唯一的"不可播"信号；`disable` 只在自动切源时被检查（`loweb.js:371`）。
7. **重复代码** —— `async_process_list` 在 `netease.js:218-235` 与 `kugou.js:29-46` 逐字重复；`htmlDecode` 在 `qq.js:5`/`kuwo.js:63`/`bilibili.js:7` 三份；kuwo/migu/taihe/localmusic 存量大段注释掉的旧实现。
8. **明显小 bug** —— `kugou.js:425` 拼 `show_playlist` URL 时缺 `?`（写成 `plist/index&json=true`，应为 `plist/index?json=true`）；`qq.js:409-415` 的 `UnicodeToAscii` 在箭头函数里误用 `arguments`（箭头函数没有自己的 `arguments`），HTML 实体转换失效；QQ 播放音质被硬编码降级为 128kbps（`qq.js:427-428`，原注释称服务端不接受 320kbps 请求）。
9. **测试与构建缺失** —— 无单测、无 e2e、无打包；每次改 UI 需人工核对两套布局与 6 份 i18n。
10. **敏感信息硬编码** —— GitHub OAuth `client_id`/`client_secret`（`github.js:7-8`）、Last.fm API key/secret（`lastfm.js:5-6`）、各平台签名密钥（如 `taihe.js` 的 secret）均在源码中。

---

## 13. 速查：改哪里

| 我想… | 主要改动位置 |
| --- | --- |
| 加一个音乐平台 | 新建 `js/provider/<name>.js` → `listen1.html:47-55` 加 `<script>` → `loweb.js:4-78` 注册（含 2 位 id 前缀）→ `app.js:10-39` 的 `sourceList` 加 tab → `i18n/*.json` 加 `_XXX_MUSIC` → 清单补 `host_permissions` → 必要时补 `rules_1.json` |
| 修某平台搜不到/播不了 | 对应 `js/provider/*.js`（搜索 → `search`，播放地址 → `bootstrap_track`，歌词 → `lyric`），必要时看 `rules_1.json` 是否为防盗链问题 |
| 改播放逻辑（切歌/循环/随机） | `js/player_thread.js`（`skip:381`、loop `:438-454`）；UI 侧 `l1_player.js` |
| 改进度条 / 歌词滚动 / 正在播放页 | `js/controller/play.js`（`parseLyric:386`、`:497-779` 消息分发）+ `listen1.html` 页脚区块（A `:1834-2088` / B `:3853-4276`） |
| 改快捷键 | 绑定：`play.js:786-815`、`navigation.js:605`；**同时**改展示表 `listen1.html:1283-1411` 与 `:3359-3487` |
| 加/改界面元素 | `listen1.html` —— **两套布局都要改**（§7.2 对照表）+ 对应 `css/common.css` / `css/common2.css` |
| 改主题配色 | `css/iparanoid.css`(white)、`origin.css`(black)、`iparanoid2.css`(white2)、`origin2.css`(black2)；映射在 `profile.js:178-183` |
| 改文案/加语言 | `i18n/*.json`（扁平键，键名 `_UPPER_SNAKE`，7 份键集必须一致，每份含 `_LANGUAGE_NAME` 作为按钮自称）；**加语言 = 新增 `i18n/xx.json` + `config/languages.json` 加一行**，按钮自动生成，无需改 `listen1.html` / `app.js` |
| 改「关于」页信息 | `config/about.json`（版本展示 / 官网 / 邮箱 / 反馈链接 / 主题署名），由 `profile.js:74` 的 `initProfile` 拉取；模板绑定 `about.*`：A `listen1.html:1423-1446` / B `:3476-3499` |
| 改歌单存储/备份 | `js/myplaylist.js`（本地存储）、`js/controller/navigation.js:509-556`（备份字段清单）、`js/github.js`（Gist） |
| 改设置项 | `js/controller/play.js` 的 `loadLocalSettings`/`saveLocalSettings`（`enable_*` 键）+ 设置页 `listen1.html:880-1482` / `:2965-3562` |
| 自动切源策略 | `loweb.js:341-398` + 默认源列表 `play.js:158-165` |
| 扩展开关/权限 | `manifest.json`（MV3）、`manifest_firefox.json`（MV2）——**两份都要同步** |
| 修 MV3 OAuth / 后台模式 | `background.js`（加 `importScripts`）、`github.js`（localStorage 依赖）、`bridge.js:17,21`（MV2 API） |

---

## 14. 相关文档

| 文档 | 内容 |
| --- | --- |
| [README.md](README.md) | 中文说明、安装方式、更新日志入口 |
| [README_EN.md](README_EN.md) | 英文版说明 |
| [CHANGELOG.md](CHANGELOG.md) | **本 fork** 的更新日志（自 `Liuli-1.0.0` 起）与版本号约定 |
| [docs/archive/CHANGELOG_UPSTREAM.md](docs/archive/CHANGELOG_UPSTREAM.md) | 上游更新日志归档（中文，原文未改） |
| [docs/archive/CHANGELOG_UPSTREAM_EN.md](docs/archive/CHANGELOG_UPSTREAM_EN.md) | 上游更新日志归档（英文，原文未改） |
| [LICENSE](LICENSE) | MIT |
| [.github/workflows/eslint.yml](.github/workflows/eslint.yml) | CI 定义 |
| 本 fork 仓库 | https://github.com/llz121517/listen1 |
| 上游仓库 | https://github.com/listen1/listen1_chrome_extension |
| 桌面版（复用本仓库渲染层） | https://github.com/listen1/listen1_desktop |

> 说明：仓库中大量 `isElectron()` 分支、`ipcRenderer` 调用与代理设置说明本目录同时被桌面版（Electron）作为前端使用
> （本仓库不含 Electron 主进程代码，宿主实现见 listen1_desktop）。

---

*本索引由代码静态阅读生成，未修改任何源文件。行号以当前工作区 `master` 分支（commit `3f24efa`）为准。*
*已用 grep / read 复核的内容：脚本加载顺序、Provider 注册表、播放链路关键函数、双布局边界锚点、行数统计、`kugou.js:425` / `qq.js:409-428` / `player_thread.js:662` 三处缺陷。*
*`listen1.html` B 套布局的行号区间按各区块起始标记推算（A/B 两套内容一一对应但不等长），可能存在 ±10 行误差；精确位置请以 `current_tag==` / `window_type==` 标记检索。*
*2026-10-06（fork `Liuli-1.0.0`）：版本号自上游 `2.33.0` 重置，上游更新日志归档至 `docs/archive/`；新增日语（现 7 语言 × 173 键）。语言按钮改为按 `config/languages.json` 动态生成（按钮文本取自各语言文件的 `_LANGUAGE_NAME`），「关于」页信息（版本展示 / 官网 / 邮箱 / 反馈链接 / 主题署名）抽到 `config/about.json`。因此 `profile.js` 为 198 行（`setLang:149` / `setTheme:175` / 主题映射 `:178-183`），`listen1.html` 为 4,241 行，非 vendor JS 为 10,428 行。*
