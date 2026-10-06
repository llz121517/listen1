# 项目约定

适用范围：本 fork（`llz121517/listen1`）的代码、注释与文档。**改代码或文档前先读这一页**；与本文冲突的写法以本文为准。

关联文档：[`docs/INDEX.md`](INDEX.md)（现状索引）、[`CHANGELOG.md`](../CHANGELOG.md)（更新日志）、[`origin/`](../origin/)（上游历史日志归档）。

---

## 1. 文档里不写具体行号（最重要的一条）

定位一律用**搜索串**：唯一属性串、CSS 选择器、函数/键名、注释标记。

- ✅ `listen1.html` 的 `ng-show="current_tag==2 && is_window_hidden==1"`（精选歌单页）
- ✅ `.classic-player` 容器、`css/classic-player.css` 的 `.songdetail-wrapper.slidedown`
- ✅ 标记注释里的方括号令牌 `[精选歌单]`（完整写法 `<!-- ===== [精选歌单] …`）
- ❌ `listen1.html:612`、`:1392-1520`、`:23-76` —— 任何一次编辑都会让它失真（本项目已因此返工三次）

细则：

- `listen1.html` 这类**高频编辑的大文件禁止写行号**。其它文件若要写行号，必须同时给出可唯一检索的符号名（例：`js/player_thread.js` 的 `skip()`），且行号只作"跳到附近"用。
- 行数/规模统计（"2,688 行"）不是定位手段，只作规模参考：写的时候标明口径（是否含末尾换行），并接受它会漂移。
- 统计脚本一律**先剥掉 `<!-- -->` 注释**再统计，否则注释里的 `ng-if="…"`、`{{ }}` 会污染计数。
- **存量行号不专门追改**，但每次改到附近就顺手换成搜索串；新增内容一律不许再写行号。

## 2. 文档分工

| 文件 | 作用 |
| --- | --- |
| `docs/CONVENTIONS.md` | 本页：约定（改代码/文档前先读） |
| `docs/INDEX.md` | 现状索引：结构、模块、主题、i18n、维护入口 |
| `CHANGELOG.md` | 更新日志：Keep a Changelog，英文小节标题 + 中文正文；**新条目默认写进 `[Unreleased]`**，发版时整体移入新版本小节并留空 |
| `docs/en/README.md` | 英文说明，与中文 `README.md` 互链 |
| `origin/` | 上游历史日志归档（只读，不再维护） |

## 3. CHANGELOG 纪律（默认动作，不必等人叮嘱）

- **改完东西就顺手更新 CHANGELOG** —— 哪怕只改注释、文档、样式，也要加一条；只有在明确说"不用改 changelog"时才跳过。
- **默认写进 `## [Unreleased]`**：按 `### Added` / `### Changed` / `### Fixed` 归类，英文小节标题 + 中文正文。只有在明确说"发版 / 迁移到 x.y.z"时，才起新版本小节 `## [x.y.z] - YYYY-MM-DD` 并把 `[Unreleased]` 留空。
- **`### Fixed` 必须自审归因**：每条写完问一句"这个缺陷在本次改动**之前**就存在吗？"
  - 答"是"（上游遗留、此前就有的 bug）→ 留在 `### Fixed`。例：上游英文文案拼写错误（见 `[1.0.0]`）。
  - 答"不是"（本次改动引入或改变的）→ 移到 `### Changed` 并改成变更口径。例：合并布局后经典主题显示成现代外观 → 写"兼容层把外壳外观换成经典惯用法"，不写"修复经典主题外观"；`.player-modern` 作用域是为隔离**本次合并**引入的串扰 → Changed。
  - 拿不准按"不是"处理（宁可写 Changed）。
- 一条一改：改到既有条目就把该条目一起更新，不留过期描述；措辞写"做了什么/为什么"，而不是"修好了什么"。

## 4. 单套 DOM + 四套 palette

- 四个主题（white / black / white2 / black2）共用同一份结构 DOM；`css/common2.css` 是**唯一结构表且恒加载**。
- palette 只换变量文件：`iparanoid.css`(white) / `origin.css`(black) / `iparanoid2.css`(white2) / `origin2.css`(black2)。
- **主题族差异只写在** `css/compat-classic.css`（经典族外壳外观）与 `css/classic-player.css`（经典播放区）。不要在 HTML 里加主题判断，也不要让两套 palette 的变量互相覆盖。
- 播放区规则（以 `.footer` / `.songdetail-wrapper` / `.playsong-detail` / `.volume-ctrl` 为根）加进 `css/common2.css` 时**必须**带 `.player-modern ` 前缀，否则现代值会漏进经典分支的同名类（踩过：7px 图标内边距 + 圆角、`98vw` 播放栏、毛玻璃菜单、`54vh` 封面、`-webkit-line-clamp` 标题）。

## 5. 经典分支是冻结资产

- `listen1.html` 里 `<div class="classic-player" …>` 内的标记**与 git 原版逐行一致**：不加现代 class、不改名、不重排、不插注释（插注释会新增空白文本节点，改变 inline 排版）。
- 校验方法：与 `git show HEAD:listen1.html` 的对应窗口**逐行比对**（trim 后相等），不要只看"页面能跑"。
- 要覆盖样式就改 `css/classic-player.css`（选择器一律带 `.classic-player` 前缀），不要动标记。

## 6. 层叠（z-index）约定

- 整个经典播放区是**一个**层叠上下文：`.classic-player { position: relative; z-index: 110 }`。
- 内部只有两级：播放页 `1` < 播放栏 / 播放列表菜单 `2`。外壳（侧栏 svg、顶栏）与以后新增的任何 z-index 都无法单独压住播放页。
- 不要把层号散落到播放区子元素上；有新需求先问"是不是仍该由容器统一对外"（根因：播放区**整块**对外只占一个层号，才不会和外壳逐个比大小）。
- `position: relative` 只造上下文，**不改变**内部 `fixed` 面板的定位上下文（只有 `transform` / `filter` / `contain` / `will-change` 会改）。

## 7. HTML 注释纪律

- 注释必须**整块位于元素开始标签之外**。曾把注释插在 `<div` 与它的属性之间，浏览器把剩余属性当文本渲染，页面直接"炸"（页面上出现 `ng-show="…"` 这些字符串）。
- 显式检查：**开始标签内部不得出现 `<!--`**；提交前跑一次标签配平。
- 统计/校验脚本在处理本文件时先剥注释；检索标记时用方括号令牌（`[侧栏]`、`[现代播放区]` …）而不是整行文本（说明部分常变）。
- 区域标记统一写法 `<!-- ===== [区域] 说明 ===== -->`（**方括号里的 `[区域]` 是稳定检索串**），紧贴该区块开始标签之前（当前 10 处）。
- 注释里不要写行号（§1）；给读者指路就写搜索串。

## 8. 版本号

- 全仓库统一：`package.json` / `package-lock.json`（根 + `packages[""]`）/ `manifest.json` / `manifest_firefox.json` / `config/about.json` / 文档。
- 扩展清单的 `version` 只接受 1~4 段纯数字（Chrome / Firefox 均不接受字母、连字符），因此不用 `version_name`。
- 发布流程：CHANGELOG 起新小节 `## [x.y.z] - YYYY-MM-DD`、`[Unreleased]` 留空、各处版本号一起改。

## 9. 提交前自检（静态即可跑）

1. `listen1.html`：开始标签内无注释、标签配平、主题 `ng-if` 恰好 2 处、`class="body"` 唯一。
2. 经典分支 348 行与 `HEAD` 逐行一致。
3. `css/common2.css` 与 `HEAD` 的差异**只有** `.player-modern ` 前缀（去掉前缀后应与 HEAD 字节相同）。
4. `css/classic-player.css` 每条规则都带 `.classic-player` 前缀；层叠链"外壳 < 110"、内部 `1 < 2`。
5. CHANGELOG 已按 §3 更新：新条目在 `[Unreleased]`、小节顺序 `Unreleased → 最新 → 旧版`、`Fixed` 项逐条自审过归因。
6. 文档里新增/改动的定位串能在代码里唯一检索到；若保留了行号，确认它指向非空行。

## 10. 临时文件与提交范围

- 调试脚本用 `.tmp-*` 命名，**用完即删**，不要提交。
- 个人研究/素材（如 `.tmp-research*/`、`docs/LIVE2D_*.md`）不属于仓库内容，不要 `git add -A`；提交时按路径显式添加。
- 提交信息用 Conventional Commits（英文短标题，必要时补正文说明"改了什么、为什么"）。
