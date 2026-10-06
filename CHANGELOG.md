# Changelog

本仓库是 [Listen 1](https://github.com/listen1/listen1_chrome_extension) 的 fork：**llz121517/listen1**。
本文件记录本 fork 所有值得注意的改动，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
版本号为 `1.0.0`（重新编号，不带前缀），上游历史日志已原样归档：

- 上游历史日志（中文）：[docs/archive/CHANGELOG_UPSTREAM.md](docs/archive/CHANGELOG_UPSTREAM.md)
- 上游历史日志（英文）：[docs/archive/CHANGELOG_UPSTREAM_EN.md](docs/archive/CHANGELOG_UPSTREAM_EN.md)

## 版本号约定

全仓库统一为 `1.0.0`：`package.json` / `package-lock.json` / `manifest.json` / `manifest_firefox.json`（扩展清单的 `version` 只接受 1~4 段纯数字）/ `config/about.json`（界面展示值）。

## [Unreleased]

## [1.0.0] - 2026-10-06

### Added

- 日语界面（现 7 种语言 × 173 个键）
- 语言清单 `config/languages.json`：设置页语言按钮由该清单动态生成，按钮文本取自各语言文件自己的 `_LANGUAGE_NAME`；新增语言只需加一个 `i18n/xx.json` 并在清单里加一行
- 「关于」页信息抽到 `config/about.json`：版本展示、官网、邮箱、反馈链接、主题署名
- 英文说明迁至 `docs/en/README.md`，与中文说明互链

### Changed

- 版本号由上游 `2.33.0` 重置为 `1.0.0`；上游更新日志归档到 `docs/archive/`，本文件成为 fork 日志
- 设置页「最新版本」改为检查本 fork 仓库的 releases
- i18n 加载口径统一为完整区域码文件（如 `i18n/zh-CN.json`）：不再维护语言白名单，也不会请求未发布的语言文件
- 总索引 `INDEX.md` 等 root 散落文档统一移入 `docs/`

### Fixed

- 上游文案：`Authencate` 拼写、英文/法文串里残留的中文「页面」、英文授权提示语法

基线：上游 `3f24efa`（`chore: add more changelog`，版本 `2.33.0`）。本 fork 尚无 tag/release，发布后再在此补版本比较链接。
