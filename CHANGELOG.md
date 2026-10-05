# Changelog

本仓库是 [Listen 1](https://github.com/listen1/listen1_chrome_extension) 的 fork：**llz121517/listen1**。
本 fork 的版本号自 `Liuli-1.0.0` 起独立编号，上游历史日志已原样归档。

- 上游历史日志（中文）：[docs/archive/CHANGELOG_UPSTREAM.md](docs/archive/CHANGELOG_UPSTREAM.md)
- 上游历史日志（英文）：[docs/archive/CHANGELOG_UPSTREAM_EN.md](docs/archive/CHANGELOG_UPSTREAM_EN.md)

## 版本号约定

| 位置 | 写法 |
| --- | --- |
| `package.json` / `package-lock.json` | `Liuli-1.0.0` |
| `manifest.json` / `manifest_firefox.json` | `"version": "1.0.0"` + `"version_name": "Liuli-1.0.0"`（清单的 `version` 只接受纯数字） |
| 界面与文档 | `Liuli-1.0.0` |

## Liuli-1.0.0 (2026-10-06)

- 版本号由上游 `2.33.0` 重置为 `Liuli-1.0.0`；上游更新日志归档到 `docs/archive/`，本文件成为 fork 日志
- 设置页「最新版本」改为检查本 fork 仓库的 releases
- 新增日语界面
- 语言按钮改为按 `config/languages.json` 动态生成，按钮文本取自各语言文件自己的 `_LANGUAGE_NAME`；新增语言只需加一个 `i18n/xx.json` 并在该清单里加一行
- 「关于」页信息（版本展示、官网、邮箱、反馈链接、主题署名）抽到 `config/about.json`
- 修正上游文案问题：`Authencate` 拼写、英文/法文串里残留的中文「页面」、英文授权提示语法

基线：上游 `3f24efa`（`chore: add more changelog`，版本 `2.33.0`）。
