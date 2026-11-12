(() => {
  const post = (settings) => {
    const enabled = Boolean(settings && settings.adBlock);
    try {
      window.localStorage.setItem("youtubi.adBlock", enabled ? "1" : "0");
    } catch (error) {
      // localStorage 不可用时只靠 postMessage
    }
    window.postMessage({ __youtubiAdBlock: enabled }, "*");
  };

  if (!window.YoutubiSettings) {
    return;
  }

  window.YoutubiSettings.load().then(post);
  window.YoutubiSettings.subscribe(post);
})();
