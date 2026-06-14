(() => {
  let i18nUnavailable = false;
  let cachedUILanguage = "";

  const FALLBACK_MESSAGES = {
    en: {
      extName: "YouTuBi",
      extDescription: "Turn YouTube comments into danmaku overlays.",
      popupDanmaku: "Danmaku",
      popupDanmakuArea: "Danmaku area",
      trackFull: "Full",
      trackTwoThirds: "2/3",
      trackHalf: "Half",
      trackOneThird: "1/3",
      popupSpeed: "Speed",
      popupFontSize: "Font size",
      popupOpacity: "Opacity",
      popupPreload: "Preload",
      unitSpeed: "$1 px/s",
      unitFontSize: "$1 px",
      unitOpacity: "$1%",
      unitPreload: "$1 comments",
      watchToggleAria: "Toggle danmaku",
      watchToggleLabel: "Danmaku",
      watchToggleOffTitle: "Turn off danmaku",
      watchToggleOnTitle: "Turn on danmaku",
      replyLoading: "Loading replies...",
      replyFailed: "Failed to load replies",
      replyEmpty: "No replies",
      replyCount: "$1 replies",
      replyMore: "More replies available",
      logCommentsLoaded: "[Youtubi] Comments loaded",
      logReason: "Reason",
      logCommentCount: "Comment count",
      logReplyEntryCount: "Comments with reply entry",
      logCommentData: "Comment data",
      logReasonDone: "All loaded",
      logReasonMaxComments: "Comment limit reached",
      logReasonContinuationMissing: "Comment continuation not found",
      logReplyCommentsFailed: "[Youtubi] Reply comments failed"
    },
    zh_CN: {
      extName: "YouTuBi",
      extDescription: "打开YouTube看弹幕～",
      popupDanmaku: "弹幕",
      popupDanmakuArea: "弹幕范围",
      trackFull: "全屏",
      trackTwoThirds: "2/3屏",
      trackHalf: "半屏",
      trackOneThird: "1/3屏",
      popupSpeed: "速度",
      popupFontSize: "字号",
      popupOpacity: "透明度",
      popupPreload: "预加载",
      unitSpeed: "$1 px/s",
      unitFontSize: "$1 px",
      unitOpacity: "$1%",
      unitPreload: "$1 条",
      watchToggleAria: "切换弹幕",
      watchToggleLabel: "弹幕",
      watchToggleOffTitle: "关闭弹幕",
      watchToggleOnTitle: "开启弹幕",
      replyLoading: "加载回复...",
      replyFailed: "回复加载失败",
      replyEmpty: "暂无回复",
      replyCount: "$1 条回复",
      replyMore: "还有更多回复",
      logCommentsLoaded: "[Youtubi] 评论加载完成",
      logReason: "结束原因",
      logCommentCount: "评论数",
      logReplyEntryCount: "带回复入口评论数",
      logCommentData: "评论数据",
      logReasonDone: "全部加载完成",
      logReasonMaxComments: "达到评论上限",
      logReasonContinuationMissing: "未找到评论续页",
      logReplyCommentsFailed: "[Youtubi] 回复评论加载失败"
    }
  };

  const hasI18n = () => {
    if (i18nUnavailable) {
      return false;
    }

    try {
      return (
        typeof chrome !== "undefined" &&
        chrome.i18n &&
        typeof chrome.i18n.getMessage === "function"
      );
    } catch (error) {
      i18nUnavailable = true;
      return false;
    }
  };

  const readChromeUILanguage = () => {
    if (!hasI18n()) {
      return "";
    }

    try {
      if (typeof chrome.i18n.getUILanguage === "function") {
        const language = chrome.i18n.getUILanguage();
        if (language) {
          cachedUILanguage = language;
        }
        return language || "";
      }
    } catch (error) {
      i18nUnavailable = true;
    }

    return "";
  };

  readChromeUILanguage();

  const normalizeSubstitutions = (substitutions) => {
    if (substitutions == null) {
      return [];
    }

    return Array.isArray(substitutions) ? substitutions.map(String) : [String(substitutions)];
  };

  const formatFallback = (fallback, substitutions) => {
    const values = normalizeSubstitutions(substitutions);
    return String(fallback || "").replace(/\$(\d+)/g, (match, index) => {
      const value = values[Number(index) - 1];
      return value == null ? match : value;
    });
  };

  const normalizeLanguage = (language) => String(language || "").trim().replace("_", "-").toLowerCase();

  const readNavigatorLanguages = () => {
    if (typeof navigator === "undefined") {
      return [];
    }

    const languages = [];
    if (Array.isArray(navigator.languages)) {
      languages.push(...navigator.languages);
    }

    if (navigator.language) {
      languages.push(navigator.language);
    }

    return languages.filter(Boolean);
  };

  const getFallbackLocale = () => {
    const languages = cachedUILanguage ? [cachedUILanguage] : [];
    const chromeLanguage = readChromeUILanguage();

    if (chromeLanguage && !languages.includes(chromeLanguage)) {
      languages.push(chromeLanguage);
    }

    languages.push(...readNavigatorLanguages());

    for (const language of languages) {
      const normalized = normalizeLanguage(language);
      if (normalized.startsWith("zh")) {
        return "zh_CN";
      }
      if (normalized.startsWith("en")) {
        return "en";
      }
    }

    return "en";
  };

  const getFallbackMessage = (key, fallback) => {
    const locale = getFallbackLocale();
    const messages = FALLBACK_MESSAGES[locale] || FALLBACK_MESSAGES.en;
    return messages[key] || FALLBACK_MESSAGES.en[key] || fallback || key;
  };

  const t = (key, substitutions, fallback = "") => {
    const values = normalizeSubstitutions(substitutions);

    if (hasI18n()) {
      try {
        const message = values.length
          ? chrome.i18n.getMessage(key, values)
          : chrome.i18n.getMessage(key);
        if (message) {
          return message;
        }
      } catch (error) {
        i18nUnavailable = true;
      }
    }

    return formatFallback(getFallbackMessage(key, fallback), values);
  };

  const getUILanguage = () => {
    const chromeLanguage = readChromeUILanguage();
    if (chromeLanguage) {
      return chromeLanguage.replace("_", "-");
    }

    if (cachedUILanguage) {
      return cachedUILanguage.replace("_", "-");
    }

    return readNavigatorLanguages()[0] || "en";
  };

  const localizeDocument = (root = document) => {
    if (!root || !root.querySelectorAll) {
      return;
    }

    if (document.documentElement) {
      document.documentElement.lang = getUILanguage();
    }

    root.querySelectorAll("[data-i18n]").forEach((node) => {
      node.textContent = t(node.dataset.i18n, null, node.textContent);
    });

    root.querySelectorAll("[data-i18n-title]").forEach((node) => {
      node.title = t(node.dataset.i18nTitle, null, node.title);
    });

    root.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
      const fallback = node.getAttribute("aria-label") || "";
      node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel, null, fallback));
    });
  };

  window.YoutubiI18n = {
    t,
    getUILanguage,
    localizeDocument
  };
})();
