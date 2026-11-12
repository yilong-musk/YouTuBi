(() => {
  const STORAGE_KEY = "youtubi.settings";

  const apply = (settings) => {
    const enabled = Boolean(settings && settings.adBlock);

    try {
      window.localStorage.setItem("youtubi.adBlock", enabled ? "1" : "0");
    } catch (error) {
      // localStorage 不可用时只靠 postMessage
    }

    const root = document.documentElement;
    if (root) {
      root.dataset.youtubiAdBlock = enabled ? "1" : "0";
    }

    window.postMessage({ __youtubiAdBlock: enabled }, "*");
  };

  try {
    chrome.storage.sync.get({ [STORAGE_KEY]: null }, (items) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        return;
      }
      apply(items[STORAGE_KEY] || {});
    });
  } catch (error) {
    // 扩展上下文失效时保持默认（关闭）
  }

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" || !changes[STORAGE_KEY]) {
        return;
      }
      apply(changes[STORAGE_KEY].newValue || {});
    });
  } catch (error) {
    // 同上
  }
})();