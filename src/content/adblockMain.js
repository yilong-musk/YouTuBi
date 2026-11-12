(() => {
  const PLAYER_URL_RE = /\/youtubei\/v1\/player(\?|$)/;
  const AD_KEYS = ["adPlacements", "playerAds", "adSlots"];

  // 默认关闭：只有用户在弹窗里显式开启过（localStorage 记为 "1"）才工作
  let enabled = false;

  try {
    const stored = window.localStorage && window.localStorage.getItem("youtubi.adBlock");
    if (stored === "1") {
      enabled = true;
    }
  } catch (error) {
    // 隐私模式下 localStorage 不可用，保持关闭
  }

  const stripAds = (value) => {
    if (!value || typeof value !== "object") {
      return false;
    }

    let changed = false;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (stripAds(item)) {
          changed = true;
        }
      }
      return changed;
    }

    for (const key of AD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        delete value[key];
        changed = true;
      }
    }

    if (value.playerResponse && typeof value.playerResponse === "object" && stripAds(value.playerResponse)) {
      changed = true;
    }

    return changed;
  };

  const shouldPatch = (url) => enabled && PLAYER_URL_RE.test(String(url || ""));

  const patchFetch = () => {
    const originalFetch = window.fetch;

    if (typeof originalFetch !== "function") {
      return;
    }

    window.fetch = function patchedFetch(input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";

      if (!shouldPatch(url)) {
        return originalFetch.apply(this, arguments);
      }

      return originalFetch.apply(this, arguments).then((response) => {
        try {
          return response
            .clone()
            .text()
            .then((text) => {
              let data;
              try {
                data = JSON.parse(text);
              } catch (error) {
                return response;
              }

              if (!stripAds(data)) {
                return response;
              }

              return new Response(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
              });
            })
            .catch(() => response);
        } catch (error) {
          return response;
        }
      });
    };
  };

  const patchXhr = () => {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || !proto.open || !proto.send) {
      return;
    }

    const originalOpen = proto.open;
    const originalSend = proto.send;

    proto.open = function patchedOpen(method, url) {
      this.__youtubiPlayerUrl = url;
      return originalOpen.apply(this, arguments);
    };

    proto.send = function patchedSend() {
      if (shouldPatch(this.__youtubiPlayerUrl)) {
        this.addEventListener("readystatechange", function onReady() {
          if (this.readyState !== 4) {
            return;
          }

          try {
            if (this.responseType && this.responseType !== "text" && this.responseType !== "json") {
              return;
            }

            const raw = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
            const data = JSON.parse(raw);
            if (!stripAds(data)) {
              return;
            }

            const patched = JSON.stringify(data);
            Object.defineProperty(this, "responseText", { value: patched, configurable: true });
            Object.defineProperty(this, "response", {
              value: this.responseType === "json" ? JSON.parse(patched) : patched,
              configurable: true
            });
          } catch (error) {
            // 解析失败就不动，保持 YouTube 原始响应
          }
        });
      }

      return originalSend.apply(this, arguments);
    };
  };

  const patchInitialPlayerResponse = () => {
    let stored;
    try {
      Object.defineProperty(window, "ytInitialPlayerResponse", {
        configurable: true,
        get() {
          return stored;
        },
        set(value) {
          if (enabled) {
            stripAds(value);
          }
          stored = value;
        }
      });
    } catch (error) {
      // 页面已定义该属性时放弃，不影响其他两个钩子
    }
  };

  patchFetch();
  patchXhr();
  patchInitialPlayerResponse();

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.__youtubiAdBlock === undefined) {
      return;
    }

    enabled = Boolean(data.__youtubiAdBlock);
  });

  window.__youtubiAdBlock = {
    stripAds,
    isEnabled: () => enabled,
    setEnabled: (value) => {
      enabled = Boolean(value);
    }
  };
})();