# Changelog

本仓库是 [Listen 1](https://github.com/listen1/listen1_chrome_extension) 的 fork：**llz121517/listen1**。
为避免与上游版本号混淆，本 fork 的版本号自 `Liuli-1.0.0` 起独立编号，上游历史日志已原样归档。

- 上游历史日志（中文，原文归档）：[docs/archive/CHANGELOG_UPSTREAM.md](docs/archive/CHANGELOG_UPSTREAM.md)
- 上游历史日志（英文，原文归档）：[docs/archive/CHANGELOG_UPSTREAM_EN.md](docs/archive/CHANGELOG_UPSTREAM_EN.md)

## 版本号约定

| 位置 | 写法 | 原因 |
| --- | --- | --- |
| `package.json` / `package-lock.json` | `Liuli-1.0.0` | 人类可读、便于区分上游；npm 11 的 `install` / `ci` / `pack` 实测接受该字符串 |
| `manifest.json` / `manifest_firefox.json` | `"version": "1.0.0"` + `"version_name": "Liuli-1.0.0"` | 浏览器清单的 `version` 只接受 1~4 段纯数字（Chrome / Firefox 均不接受字母与连字符），完整版本由 `version_name` 承载 |
| 界面与文档 | `Liuli-1.0.0` | 设置页版本行、README / CHANGELOG / INDEX |

## Liuli-1.0.0 (2026-10-06)

版本号重置与 fork 化整理：

- 版本号由上游 `2.33.0` 重置为 `Liuli-1.0.0`
  - `package.json`、`package-lock.json`：`version` → `Liuli-1.0.0`
  - `manifest.json`、`manifest_firefox.json`：`version` → `1.0.0`，新增 `version_name` → `Liuli-1.0.0`
  - `listen1.html`：设置页两套布局的版本显示行 → `Liuli-1.0.0`（当前位于 `:1481` / `:3569`）
  - `README.md` / `README_EN.md`：标题与日期
- 上游更新日志归档到 `docs/archive/`（中英各一份，正文逐行校验为原文未改），README 只保留入口链接
- 新增本 fork 的更新日志（即本文件）
- 设置页的「最新版本」检查改为读取本 fork 仓库的 releases（`llz121517/listen1`），并处理无 release / 请求失败的情况（`js/controller/profile.js`）
- `INDEX.md` 同步版本行与 fork 版本方案说明

基线：上游 `3f24efa`（`chore: add more changelog`，版本 `2.33.0`）。
