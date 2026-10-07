# Listen 1

[listen1/listen1_chrome_extension](https://github.com/listen1/listen1_chrome_extension) 的分支版本

简体中文 |
<a href="docs/en/README.md">English</a>

[![Software License](https://img.shields.io/badge/license-MIT-brightgreen.svg)](LICENSE)

## 缘起

当我发现找个想听的歌因为版权听不了，需要打开好几个网站开始搜索，来回切换让我抓狂的时候，我知道是时候该做点什么了。

妈妈再也不用担心我找不到我想听的歌了。

支持音乐平台

- 网易云音乐
- QQ 音乐
- 酷狗音乐
- 酷我音乐
- bilibili
- 咪咕音乐
- 千千音乐

搜歌，听歌，就用 `Listen1`。

[![imgur](https://i.imgur.com/dIVFtor.gif)]()

V2.9.0 新特性：自动切换播放源(Beta)

当一首歌的播放源不可用时，会自动搜索其他平台，获得可用的播放源。避免了用户手动搜索的麻烦。

还有精选歌单哦。

## 官方商店安装（推荐）

按你的浏览器类型点击下面的链接安装

- [Chrome Web Store 安装](https://chrome.google.com/webstore/detail/listen-1/indecfegkejajpaipjipfkkbedgaodbp)
- [FireFox 安装](https://addons.mozilla.org/zh-CN/firefox/addon/listen1/)
- [Microsoft Edge 安装](https://microsoftedge.microsoft.com/addons/detail/bcneiehcbgahghfmgigmblcgkhihehad)

感谢 [@TNT-c](https://github.com/TNT-c) 维护 Firefox 的发布渠道

感谢 [@dhxh](https://github.com/dhxh) 维护 Microsoft Edge 的发布渠道

## Chrome 下载安装

1. 下载项目的 zip 文件，在右上方有个 `Download ZIP`, 解压到本地

2. chrome 右上角的设置按钮下找到更多工具，打开`扩展程序`

3. 选择 `加载已解压的扩展程序`(如果没有显示先选中`开发者模式`)，选中解压后的文件夹，完成！

## Firefox 打包安装

1. 将根目录下 manifest_firefox.json 替换 manifest.json

2. `cd listen1_chrome_extension`

3. `zip -r ../listen1.xpi *`, 完成打包 xpi 文件

4. 打开 Firefox，加载 xpi 文件，完成安装

## 更新日志

> 本 fork 采用语义化版本（SemVer，`MAJOR.MINOR.PATCH`），当前 `2.2.1`；独立编号，与上游历史版本号（最后 `2.33.0`）无对应关系。上游历史日志已归档，不再在本文件维护。

- 本 fork 的更新日志：[CHANGELOG.md](CHANGELOG.md)
- 上游历史日志（归档原文）：[docs/origin/CHANGELOG_UPSTREAM.md](docs/origin/CHANGELOG_UPSTREAM.md)

## License

[MIT](LICENSE)
