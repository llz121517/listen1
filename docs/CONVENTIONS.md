# 项目约定

适用范围：本 fork（`llz121517/listen1`）的代码、注释与文档。**改代码或文档前先读这一页**；与本文冲突的写法以本文为准。

关联文档：[`docs/INDEX.md`](INDEX.md)（现状索引）、[`CHANGELOG.md`](../CHANGELOG.md)（更新日志）、[`docs/origin/`](origin/)（上游历史日志归档）。

---

## 1. 文档里不写具体行号（最重要的一条）

定位一律用**搜索串**：唯一属性串、CSS 选择器、函数/键名、注释标记。

- ✅ `listen1.html` 的 `ng-show="current_tag==2 && is_window_hidden==1"`（精选歌单页）
- ✅ 播放区容器 `.footer`、`css/common2.css` 的 `.songdetail-wrapper.slidedown`
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
| `docs/origin/` | 上游历史日志归档（只读，不再维护） |

## 3. CHANGELOG 纪律（默认动作，不必等人叮嘱）

- **改完东西就顺手更新 CHANGELOG** —— 哪怕只改注释、文档、样式，也要加一条；只有在明确说"不用改 changelog"时才跳过。
- **默认写进 `## [Unreleased]`**：按 `### Added` / `### Changed` / `### Removed` / `### Fixed` 归类，英文小节标题 + 中文正文。只有在明确说"发版 / 迁移到 x.y.z"时，才起新版本小节 `## [x.y.z] - YYYY-MM-DD` 并把 `[Unreleased]` 留空。
- **`### Fixed` 必须自审归因**：每条写完问一句"这个缺陷在本次改动**之前**就存在吗？"
  - 答"是"（上游遗留、此前就有的 bug）→ 留在 `### Fixed`。例：上游英文文案拼写错误（见 `[1.0.0]`）。
  - 答"不是"（本次改动引入或改变的）→ 移到 `### Changed` 并改成变更口径。例：合并布局后经典主题显示成现代外观 → 写"兼容层把外壳外观换成经典惯用法"，不写"修复经典主题外观"。
  - 拿不准按"不是"处理（宁可写 Changed）。
- 一条一改：改到既有条目就把该条目一起更新，不留过期描述；措辞写"做了什么/为什么"，而不是"修好了什么"。
- **一条一句话，一行封顶**：每条只写"做了什么"，需要时加一个 `；` 从句。**不写**原因推导、vendor / 库的内部行为、函数或行号级细节、验证方式与判定过程 —— 那些属于代码注释、`docs/INDEX.md`、设计文档或 PR 描述。写完自查一句："删掉这半句，读者还知道发生了什么变化吗？" 知道就删。
- **`[Unreleased]` 与已发布小节同标准**：越详细越容易过期；宁可少写，也不要让日志变成实现笔记（历史小节不回改，但新写的一条要经得起这条约束）。

## 4. 单套 DOM + 两套 palette

- 两个主题（white2 / black2）共用同一份结构 DOM；`css/common2.css` 是**唯一结构表且恒加载**。
- palette 只换变量文件：`iparanoid2.css`(white2) / `origin2.css`(black2)。经典主题族（white / black）与其专属样式（`compat-classic.css` / `classic-player.css` / 经典 palette）已于 2026-10-06 整体移除，见 CHANGELOG。
- **主题差异只写在 palette 变量文件里**。不要在 HTML 或 `common2.css` 里加主题判断，也不要让两套 palette 的变量互相覆盖。
- `--nav-height` 定义在 `css/common2.css` 的 `html` 级，是顶栏高度的唯一来源：`.navigation` 自己、`.page` 的顶部留白、`.menu-control-card` 都取它。
- 播放区规则（以 `.footer` / `.songdetail-wrapper` / `.playsong-detail` / `.volume-ctrl` 为根）直接写在 `css/common2.css`，**不要**再加 `.player-modern ` 作用域前缀 —— 它是 1.1.0 为隔离经典分支加的，2.0.0 随经典分支一起移除（历史教训：漏加前缀曾把 7px 图标内边距 + 圆角、`98vw` 播放栏、毛玻璃菜单、`54vh` 封面、`-webkit-line-clamp` 标题带进经典播放栏）。

## 5. 层叠（z-index）约定

- 外壳：侧栏 svg `10`、顶栏 `.navigation` `100`；弹窗 `.shadow` `9999` / `.dialog` `10000`。
- 播放区：正在播放页 `.songdetail-wrapper` `100`（与顶栏同值，但 DOM 在后，所以压住顶栏）< 播放栏 `.footer` `130`（内部 `main-info` 110 / `menu` 120 / `footer-main` 140）。
- 层号写在 `css/common2.css` 对应规则的根选择器上，不要散落到子元素。
- `position: relative` 只造上下文，**不改变**内部 `fixed` 面板的定位上下文（只有 `transform` / `filter` / `contain` / `will-change` 会改）。

## 6. HTML 注释纪律

- 注释必须**整块位于元素开始标签之外**。曾把注释插在 `<div` 与它的属性之间，浏览器把剩余属性当文本渲染，页面直接"炸"（页面上出现 `ng-show="…"` 这些字符串）。
- 显式检查：**开始标签内部不得出现 `<!--`**；提交前跑一次标签配平。
- 统计/校验脚本在处理本文件时先剥注释；检索标记时用方括号令牌（`[侧栏]`、`[现代播放区]` …）而不是整行文本（说明部分常变）。
- 区域标记统一写法 `<!-- ===== [区域] 说明 ===== -->`（**方括号里的 `[区域]` 是稳定检索串**），紧贴该区块开始标签之前（当前 12 处）。
- 注释里不要写行号（§1）；给读者指路就写搜索串。

## 7. 版本号

- **语义化版本（SemVer）`MAJOR.MINOR.PATCH`**：不兼容改动升 `MAJOR`（例：`2.0.0` 移除经典主题族）；向后兼容地新增升 `MINOR`；向后兼容地修复升 `PATCH`。
- 全仓库统一：`package.json` / `package-lock.json`（根 + `packages[""]`）/ `manifest.json` / `manifest_firefox.json` / `config/about.json` / 文档。
- 扩展清单的 `version` 只接受 1~4 段纯数字（Chrome / Firefox 均不接受字母、连字符），所以只写三段 `x.y.z`：预发布标识与构建元数据（`-beta.1`、`+build`）一律不用，因此也不需要 `version_name`。
- 本 fork 独立编号，与上游历史版本号（最后 `2.33.0`）无对应关系；未发布的改动记在 CHANGELOG 的 `[Unreleased]`。
- 发布流程：CHANGELOG 起新小节 `## [x.y.z] - YYYY-MM-DD`、`[Unreleased]` 留空、各处版本号一起改。

## 8. 提交前自检（静态即可跑）

1. `listen1.html`：开始标签内无注释、标签配平、无主题 `ng-if`（只有一套布局）、`class="body"` 唯一。
2. 播放区规则直接以播放区类为根（不加作用域前缀）；`css/common2.css` 不写 palette 实色值（配色一律走变量）。
3. `css/*.css` 里用到的 `var(--x)` 都有定义（新增变量要连同 `html` 级定义一起加，`--nav-height` 是例子）。
4. CHANGELOG 已按 §3 更新：新条目在 `[Unreleased]`、小节顺序 `Unreleased → 最新 → 旧版`、`Fixed` 项逐条自审过归因。
5. 文档里新增/改动的定位串能在代码里唯一检索到；若保留了行号，确认它指向非空行。

## 9. 临时文件与提交范围

- 调试脚本用 `.tmp-*` 命名，**用完即删**，不要提交。
- 个人研究/素材（如 `.tmp-research*/`、`docs/LIVE2D_*.md`）不属于仓库内容，不要 `git add -A`；提交时按路径显式添加。
- 提交信息用 Conventional Commits（英文短标题，必要时补正文说明"改了什么、为什么"）。
- **只在被明确要求"提交 / 推送"时才 `git commit` / `git push`**；其余时候改完就停在工作区，等人发话。

## 10. 分支与发版流程

- **`main` 原则上只通过 `dev` 的 PR 更新**：日常改动先落到 `dev`，再由 `dev` 开 PR 合并进 `main`；不直接在 `main` 上提交（紧急修复也走同一条路径，避免两套口径）。
- **一 PR 一版本**：一个 PR 只对应一次版本号递增（§7 的 SemVer）。提 PR 前，该 PR 里必须已经包含：CHANGELOG 起好该版本的小节 `## [x.y.z] - YYYY-MM-DD`、`[Unreleased]` 留空、全仓库版本号同步改完。
- **合并提交标题 = 日期 + 版本号**：形如 `2026-10-06 / v2.1.0`（`YYYY-MM-DD / vX.Y.Z`，日期取合并当天）。因此合并**必须产生合并提交**（`git merge --no-ff` 或 GitHub 的 merge commit），不要用 squash / rebase 合并 —— 否则这个标题留不下来。
- **发布默认打 tag**：合并进 `main` 之后，在**该合并提交**上打 `vX.Y.Z`（与合并标题里的版本号一致）并显式推送 —— `git tag v2.2.0 <merge-commit> && git push origin v2.2.0`。tag 是"这次发布到底发了哪棵树"的锚点，属于发布的一部分，**不要漏**；标题里的 `vX.Y.Z` 与 tag 用同一个版本号（标题给人看，tag 给 git 用）。
- 从上游继承的 81 个历史 tag 已于 2026-10-06 全部删除（本地 + 远端都为 0），所以 `vX.Y.Z` 这种名字不会再和上游撞名，**不需要**加 fork 前缀。
- PR 内的普通提交照旧用 Conventional Commits（§9）；合并提交只承载"日期 + 版本号"，不再写别的。
