(() => {
  const hasI18n = () =>
    typeof chrome !== "undefined" &&
    chrome.i18n &&
    typeof chrome.i18n.getMessage === "function";

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

  const t = (key, substitutions, fallback = "") => {
    const values = normalizeSubstitutions(substitutions);

    if (hasI18n()) {
      const message = values.length
        ? chrome.i18n.getMessage(key, values)
        : chrome.i18n.getMessage(key);
      if (message) {
        return message;
      }
    }

    return formatFallback(fallback || key, values);
  };

  const getUILanguage = () => {
    if (hasI18n() && typeof chrome.i18n.getUILanguage === "function") {
      return chrome.i18n.getUILanguage().replace("_", "-");
    }

    return navigator.language || "en";
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
