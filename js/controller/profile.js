/* eslint-disable import/no-unresolved */
/* eslint-disable global-require */
/* eslint-disable no-undef */
/* eslint-disable no-param-reassign */
/* global angular i18next notyf sourceList platformSourceList */
angular.module('listenone').controller('ProfileController', [
  '$scope',
  '$q',
  ($scope, $q) => {
    const LANGUAGE_LABEL = '_LANGUAGE_NAME';
    const BACKGROUND_KEY = 'custom_background';
    // 壁纸一律以 data URL 存 localStorage：图太大就顶到 ≈5MB 配额，
    // 宁可提示换图也不要把存储写坏（BACKGROUND_MAX_LENGTH 按 data URL 字符数算）。
    const BACKGROUND_MAX_LENGTH = 4 * 1024 * 1024;
    let defaultLang = 'zh-CN';
    // First-run detection only: which browser locales are auto-selected. The list
    // of available languages (and the UI buttons) comes from config/languages.json.
    const detectedLangs = ['zh-CN', 'en-US'];
    if (detectedLangs.indexOf(navigator.language) !== -1) {
      defaultLang = navigator.language;
    }
    if (detectedLangs.indexOf(localStorage.getObject('language')) !== -1) {
      defaultLang = localStorage.getObject('language');
    }
    $scope.lastestVersion = '';
    $scope.theme = '';
    $scope.about = {};
    $scope.languages = [];
    // 自定义背景：壁纸存 data URL（localStorage.custom_background）。DOM 落点是
    // listen1.html「[装饰层]」里的壁纸层，样式在 css/custom-background.css，
    // 见 applyCustomBackground()。
    //
    // 主题也用属性表达给 CSS 用：<html> 上的 data-theme-family 由 setTheme 写，但页面容器
    // 不一定带得上（`.page[data-theme-family='classic']` 这类选择器要靠它）—— 这里把它同步
    // 到所有 .page 上，样式表就能按主题族分别给值（顶部留白 49 / 64px 就是这么分的）。
    const syncThemeFamilyToPages = () => {
      const family = document.documentElement.getAttribute('data-theme-family');
      if (!family) {
        return;
      }
      Array.prototype.forEach.call(document.querySelectorAll('.page'), (page) => {
        page.setAttribute('data-theme-family', family);
      });
    };
    $scope.customBackground = false;
    $scope.proxyModes = [
      { name: 'system', displayId: '_PROXY_SYSTEM' },
      { name: 'direct', displayId: '_PROXY_DIRECT' },
      { name: 'custom', displayId: '_PROXY_CUSTOM' },
    ];

    [$scope.proxyModeInput] = $scope.proxyModes;
    [$scope.proxyMode] = $scope.proxyModes;
    $scope.proxyProtocols = ['http', 'https', 'quic', 'socks4', 'socks5'];

    $scope.proxyProtocol = 'http';
    $scope.proxyRules = '';

    $scope.changeProxyProtocol = (newProtocol) => {
      $scope.proxyProtocol = newProtocol;
    };

    $scope.changeProxyMode = (newMode) => {
      $scope.proxyModeInput = newMode;
    };

    $scope.setProxyConfig = () => {
      const mode = $scope.proxyModeInput.name;
      $scope.proxyMode = $scope.proxyModeInput;
      const host = document.getElementById('proxy-rules-host').value;
      const port = document.getElementById('proxy-rules-port').value;
      $scope.proxyRules = `${$scope.proxyProtocol}://${host}:${port}`;
      if (isElectron()) {
        const message = 'update_proxy_config';
        const { ipcRenderer } = require('electron');
        if (mode === 'system' || mode === 'direct') {
          ipcRenderer.send('control', message, { mode });
        } else {
          ipcRenderer.send('control', message, {
            proxyRules: $scope.proxyRules,
          });
        }
      }
    };

    $scope.getProxyConfig = () => {
      if (isElectron()) {
        // get proxy config from main process
        const message = 'get_proxy_config';
        const { ipcRenderer } = require('electron');
        ipcRenderer.send('control', message);
      }
    };

    $scope.initProfile = () => {
      // "About" page info (contact / links / credits / displayed version).
      axios
        .get('config/about.json')
        .then((response) => {
          $scope.about = response.data;
        })
        .catch(() => {
          // A missing or unreadable config must not break the settings page.
          $scope.about = {};
        });

      // Language buttons: the ids come from config/languages.json, the label from
      // each locale file's own _LANGUAGE_NAME field.
      axios
        .get('config/languages.json')
        .then((response) =>
          $q.all(
            response.data.map((id) =>
              axios
                .get(`i18n/${id}.json`)
                .then((res) => ({ id, label: res.data[LANGUAGE_LABEL] || id }))
                .catch(() => ({ id, label: id }))
            )
          )
        )
        .then((list) => {
          $scope.languages = list;
        })
        .catch(() => {
          $scope.languages = [];
        });

      // Fork build: check this fork's releases instead of upstream's.
      const url = `https://api.github.com/repos/llz121517/listen1/releases/latest`;
      axios
        .get(url)
        .then((response) => {
          $scope.lastestVersion = response.data.tag_name;
        })
        .catch(() => {
          // No release published yet (or offline): keep the label hidden.
          $scope.lastestVersion = '';
        });

      $scope.initCustomBackground();
      $scope.getProxyConfig();
    };

    // ------------------------------------------------------------------
    // 自定义背景：壁纸层（listen1.html 的 [装饰层]）
    //
    // 一个 fixed 全屏层跟着窗口走，任何容器都裁不到它。状态只写在 <html> 上：
    //   data-custom-background="1"   开关（css/custom-background.css 的总条件）
    //   .custom-bg-wallpaper 的内联 backgroundImage  壁纸 data URL
    // 没有遮罩层：壁纸保持原色，界面不被压暗。
    //
    // 文案一律走 i18next.t()：$scope 上的 _XXX 键由 setLang() 异步灌入，
    // 选图 / 清除的提示不依赖那次填充；顺便避开 no-underscore-dangle 规则。
    // ------------------------------------------------------------------

    // 只认图片 data URL：非图片（拖进来的 .txt 等）在这里就被挡掉，
    // 不会出现"存进去了但画不出来"的半套状态。
    const isImageDataUrl = (value) =>
      typeof value === 'string' && value.startsWith('data:image/');

    // 唯一入口：把 localStorage 里的壁纸落到 DOM。
    function applyCustomBackground() {
      const html = document.documentElement;
      const wallpaper = localStorage.getObject(BACKGROUND_KEY);
      const hasWallpaper = isImageDataUrl(wallpaper);
      $scope.customBackground = hasWallpaper;
      if (hasWallpaper) {
        html.setAttribute('data-custom-background', '1');
      } else {
        html.removeAttribute('data-custom-background');
      }
      const wallpaperLayer = document.querySelector('.custom-bg-wallpaper');
      if (wallpaperLayer) {
        wallpaperLayer.style.backgroundImage = hasWallpaper
          ? `url("${wallpaper}")`
          : '';
      }
    }

    $scope.clearCustomBackground = () => {
      localStorage.removeItem(BACKGROUND_KEY);
      applyCustomBackground();
      notyf.success(i18next.t('_CUSTOM_BACKGROUND_RESET'));
    };

    // 选图：读成 data URL 校验后落盘。成功时不弹提示 —— 壁纸本身与设置页的
    // 清除按钮 / 滑块就是反馈，省掉一个 toast。
    $scope.onCustomBackgroundSelected = (event) => {
      const input = event.target;
      const file = input.files && input.files[0];
      // 同一个文件连选两次也要能触发 change
      input.value = '';
      if (!file) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const dataUrl = reader.result;
          if (!isImageDataUrl(dataUrl)) {
            notyf.error(i18next.t('_CUSTOM_BACKGROUND_ERROR_TYPE'));
          } else if (dataUrl.length > BACKGROUND_MAX_LENGTH) {
            notyf.error(i18next.t('_CUSTOM_BACKGROUND_ERROR_SIZE'));
          } else {
            // 配额写满时 setItem 会抛 QuotaExceededError，这里接住转成提示，
            // 不让异常冒到 change 事件里（那会连 notyf 提示都没有）
            localStorage.setObject(BACKGROUND_KEY, dataUrl);
            if (localStorage.getObject(BACKGROUND_KEY) === dataUrl) {
              applyCustomBackground();
            } else {
              notyf.error(i18next.t('_CUSTOM_BACKGROUND_ERROR_STORAGE'));
            }
          }
        } catch (error) {
          notyf.error(i18next.t('_CUSTOM_BACKGROUND_ERROR_STORAGE'));
        }
        $scope.$apply();
      };
      reader.onerror = () => {
        notyf.error(i18next.t('_CUSTOM_BACKGROUND_ERROR_READ'));
        $scope.$apply();
      };
      reader.readAsDataURL(file);
    };

    $scope.initCustomBackground = () => {
      applyCustomBackground();
      syncThemeFamilyToPages();
    };

    if (isElectron()) {
      const { ipcRenderer } = require('electron');

      ipcRenderer.on('proxyConfig', (event, config) => {
        // parse config
        if (config.mode === 'system' || config.mode === 'direct') {
          [$scope.proxyMode] = $scope.proxyModes.filter(
            (i) => i.name === config.mode
          );
          $scope.proxyModeInput = $scope.proxyMode;
          $scope.proxyRules = '';
        } else {
          [$scope.proxyMode] = $scope.proxyModes.filter(
            (i) => i.name === 'custom'
          );
          $scope.proxyModeInput = $scope.proxyMode;
          $scope.proxyRules = config.proxyRules;
          // rules = 'socks5://127.0.0.1:1080'
          const match = /(\w+):\/\/([\d.]+):(\d+)/.exec(config.proxyRules);
          const [, protocol, host, port] = match;

          $scope.proxyProtocol = protocol;
          document.getElementById('proxy-rules-host').value = host;
          document.getElementById('proxy-rules-port').value = port;
        }
      });
    }
    $scope.setLang = (langKey) => {
      // You can change the language during runtime
      i18next.changeLanguage(langKey).then((t) => {
        axios.get('i18n/zh-CN.json').then((res) => {
          Object.keys(res.data).forEach((key) => {
            $scope[key] = t(key);
          });
          sourceList.forEach((item) => {
            item.displayText = t(item.displayId);
          });
          platformSourceList.forEach((item) => {
            item.displayText = t(item.displayId);
          });
          $scope.proxyModes.forEach((item) => {
            item.displayText = t(item.displayId);
          });
        });
        localStorage.setObject('language', langKey);
      });
    };
    $scope.setLang(defaultLang);

    let defaultTheme = 'white';
    if (localStorage.getObject('theme') !== null) {
      defaultTheme = localStorage.getObject('theme');
    }
    $scope.setTheme = (theme) => {
      $scope.theme = theme;
      // 壁纸挂在 <html> 的开关属性 + 壁纸层的内联背景上，换 palette 不会把它冲掉，
      // 这里重挂一次，保证写的是当前状态
      $scope.initCustomBackground();

      // DOM 统一为原来的"新版"布局：四个主题共用 common2.css 的结构；经典主题
      // 另外靠 css/compat-classic.css 做变量别名与外观覆盖，播放栏与"正在播放"
      // 页由 listen1.html 里的 .classic-player 分支还原成经典 HTML
      // （样式 css/classic-player.css）。
      const palettes = {
        white: 'css/iparanoid.css',
        black: 'css/origin.css',
        white2: 'css/iparanoid2.css',
        black2: 'css/origin2.css',
      };
      const structureCss = 'css/common2.css';
      const classicThemes = ['white', 'black'];

      if (palettes[theme] !== undefined) {
        // data-theme-family 给 css/compat-classic.css 做作用域；
        // data-theme 只是方便在 DevTools 里看出当前主题
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.setAttribute(
          'data-theme-family',
          classicThemes.includes(theme) ? 'classic' : 'modern'
        );
        document.getElementById('theme-css').href = palettes[theme];
        document.getElementById('common-css').href = structureCss;
        localStorage.setObject('theme', theme);
      }
      axios.get('images/feather-sprite.svg').then((res) => {
        document.getElementById('feather-container').innerHTML = res.data;
      });
    };
    $scope.setTheme(defaultTheme);
  },
]);
