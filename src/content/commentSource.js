(() => {
  const COMMENT_ROOT_SELECTORS = [
    "ytd-comment-thread-renderer",
    "ytd-comment-view-model",
    "ytd-comment-renderer"
  ];

  const COMMENT_TEXT_SELECTORS = [
    "#content-text",
    "yt-attributed-string#content-text",
    ".yt-core-attributed-string"
  ];

  const PUBLISHED_TIME_SELECTORS = [
    "#published-time-text a",
    "#published-time-text",
    "a[href*='lc=']"
  ];

  const ROOT_SELECTORS = [
    "ytd-comments #contents",
    "ytd-comments",
    "#comments"
  ];

  const normalizeText = (text) =>
    String(text || "")
      .replace(/\s+/g, " ")
      .trim();

  const findFirst = (root, selectors) => {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) {
        return node;
      }
    }

    return null;
  };

  const parseEnglishRelativeTime = (text, now) => {
    const normalized = text
      .toLowerCase()
      .replace(/\((edited|\u5df2\u7f16\u8f91|\u7de8\u96c6\u6e08\u307f)\)/g, "")
      .replace(/\bedited\b/g, "")
      .trim();

    if (/^(just now|now)$/.test(normalized)) {
      return now;
    }

    if (normalized === "yesterday") {
      return now - 24 * 60 * 60 * 1000;
    }

    const numberWords = {
      a: 1,
      an: 1,
      one: 1
    };
    const match = normalized.match(/\b(\d+(?:\.\d+)?|a|an|one)\s*(second|sec|minute|min|hour|hr|day|week|wk|month|mo|year|yr)s?\s+ago\b/);
    if (!match) {
      return null;
    }

    const value = numberWords[match[1]] || Number(match[1]);
    const unit = match[2];
    const units = {
      second: 1000,
      sec: 1000,
      minute: 60 * 1000,
      min: 60 * 1000,
      hour: 60 * 60 * 1000,
      hr: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      wk: 7 * 24 * 60 * 60 * 1000,
      month: 30.4375 * 24 * 60 * 60 * 1000,
      mo: 30.4375 * 24 * 60 * 60 * 1000,
      year: 365.25 * 24 * 60 * 60 * 1000,
      yr: 365.25 * 24 * 60 * 60 * 1000
    };

    return Number.isFinite(value) && units[unit] ? now - value * units[unit] : null;
  };

  const parseChineseRelativeTime = (text, now) => {
    const normalized = text.replace(/[()\uff08\uff09\s]/g, "");

    if (/^(\u521a\u521a|\u525b\u525b|\u521a\u624d|\u525b\u624d)$/.test(normalized)) {
      return now;
    }

    const match = normalized.match(/(\d+(?:\.\d+)?)(\u79d2|\u5206\u949f|\u5206\u9418|\u5c0f\u65f6|\u5c0f\u6642|\u5929|\u65e5|\u5468|\u9031|\u661f\u671f|\u4e2a\u6708|\u500b\u6708|\u6708|\u5e74)\u524d/);
    if (!match) {
      return null;
    }

    const value = Number(match[1]);
    const units = {
      "\u79d2": 1000,
      "\u5206\u949f": 60 * 1000,
      "\u5206\u9418": 60 * 1000,
      "\u5c0f\u65f6": 60 * 60 * 1000,
      "\u5c0f\u6642": 60 * 60 * 1000,
      "\u5929": 24 * 60 * 60 * 1000,
      "\u65e5": 24 * 60 * 60 * 1000,
      "\u5468": 7 * 24 * 60 * 60 * 1000,
      "\u9031": 7 * 24 * 60 * 60 * 1000,
      "\u661f\u671f": 7 * 24 * 60 * 60 * 1000,
      "\u4e2a\u6708": 30.4375 * 24 * 60 * 60 * 1000,
      "\u500b\u6708": 30.4375 * 24 * 60 * 60 * 1000,
      "\u6708": 30.4375 * 24 * 60 * 60 * 1000,
      "\u5e74": 365.25 * 24 * 60 * 60 * 1000
    };

    return Number.isFinite(value) && units[match[2]] ? now - value * units[match[2]] : null;
  };

  const parseChineseAbsoluteTime = (text) => {
    const match = text.match(/(\d{4})\u5e74\s*(\d{1,2})\u6708\s*(\d{1,2})\u65e5(?:\s*(\d{1,2}):(\d{2}))?/);
    if (!match) {
      return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const hour = Number(match[4] || 0);
    const minute = Number(match[5] || 0);
    const timestamp = new Date(year, month, day, hour, minute).getTime();

    return Number.isFinite(timestamp) ? timestamp : null;
  };

  const parsePublishedAt = (values) => {
    const now = Date.now();

    for (const value of values) {
      const text = normalizeText(value);
      if (!text) {
        continue;
      }

      const absolute = Date.parse(text);
      if (Number.isFinite(absolute)) {
        return absolute;
      }

      const chineseAbsolute = parseChineseAbsoluteTime(text);
      if (Number.isFinite(chineseAbsolute)) {
        return chineseAbsolute;
      }

      const englishRelative = parseEnglishRelativeTime(text, now);
      if (Number.isFinite(englishRelative)) {
        return englishRelative;
      }

      const chineseRelative = parseChineseRelativeTime(text, now);
      if (Number.isFinite(chineseRelative)) {
        return chineseRelative;
      }
    }

    return null;
  };

  window.YoutubiCommentTime = {
    normalizeText,
    parsePublishedAt
  };

  class CommentSource {
    constructor({ onComment, videoId }) {
      this.onComment = onComment;
      this.videoId = videoId || "";
      this.seen = new Set();
      this.root = null;
      this.observer = null;
      this.scanTimer = 0;
      this.attachTimer = 0;
      this.scanQueued = false;
      this.order = 0;
    }

    start() {
      this.attach();
      this.scan();

      this.attachTimer = window.setInterval(() => {
        if (!this.root || !document.body.contains(this.root)) {
          this.attach();
        }

        this.scan();
      }, 2500);
    }

    attach() {
      const root = this.findRoot();
      if (!root || root === this.root) {
        return;
      }

      if (this.observer) {
        this.observer.disconnect();
      }

      this.root = root;
      this.observer = new MutationObserver(() => this.scheduleScan());
      this.observer.observe(root, {
        childList: true,
        subtree: true
      });
    }

    findRoot() {
      for (const selector of ROOT_SELECTORS) {
        const node = document.querySelector(selector);
        if (node) {
          return node;
        }
      }

      return null;
    }

    scheduleScan() {
      if (this.scanQueued) {
        return;
      }

      this.scanQueued = true;
      this.scanTimer = window.setTimeout(() => {
        this.scanQueued = false;
        this.scanTimer = 0;
        this.scan();
      }, 300);
    }

    scan() {
      if (!this.isCurrentPage()) {
        return;
      }

      const nodes = Array.from(document.querySelectorAll(COMMENT_ROOT_SELECTORS.join(","))).filter(
        (node) => !node.matches("ytd-comment-renderer") || !node.closest("ytd-comment-thread-renderer")
      );

      for (const node of nodes) {
        const textNode = findFirst(node, COMMENT_TEXT_SELECTORS);
        const text = normalizeText(textNode && textNode.textContent);
        if (!text || text.length < 2) {
          continue;
        }

        if (!this.belongsToCurrentVideo(node)) {
          continue;
        }

        const key = this.makeKey(node, text);
        if (this.seen.has(key)) {
          continue;
        }

        this.seen.add(key);
        this.trimSeen();
        this.onComment({
          id: key,
          text,
          node,
          order: this.order,
          publishedAt: this.getPublishedAt(node),
          publishedText: this.getPublishedText(node)
        });
        this.order += 1;
      }
    }

    makeKey(node, text) {
      const anchor = node.querySelector("a[href*='lc=']");
      const href = anchor && anchor.getAttribute("href");

      if (href) {
        try {
          const url = new URL(href, location.origin);
          return url.searchParams.get("lc") || href;
        } catch (error) {
          return href;
        }
      }

      return `${text.slice(0, 180)}|${this.getPublishedText(node)}`;
    }

    belongsToCurrentVideo(node) {
      if (!this.videoId) {
        return true;
      }

      const anchors = Array.from(node.querySelectorAll("a[href]"));
      const linkedVideoIds = anchors
        .map((anchor) => {
          try {
            return new URL(anchor.getAttribute("href"), location.origin).searchParams.get("v");
          } catch (error) {
            return "";
          }
        })
        .filter(Boolean);

      return !linkedVideoIds.length || linkedVideoIds.includes(this.videoId);
    }

    isCurrentPage() {
      if (!this.videoId) {
        return true;
      }

      try {
        return new URL(location.href).searchParams.get("v") === this.videoId;
      } catch (error) {
        return false;
      }
    }

    getPublishedText(node) {
      const timeNode = findFirst(node, PUBLISHED_TIME_SELECTORS);
      return normalizeText(timeNode && timeNode.textContent);
    }

    getPublishedAt(node) {
      const timeNode = findFirst(node, PUBLISHED_TIME_SELECTORS);
      if (!timeNode) {
        return null;
      }

      return parsePublishedAt([
        timeNode.getAttribute("datetime"),
        timeNode.getAttribute("title"),
        timeNode.getAttribute("aria-label"),
        timeNode.textContent
      ]);
    }

    trimSeen() {
      if (this.seen.size <= 1500) {
        return;
      }

      const overflow = this.seen.size - 1200;
      const iterator = this.seen.values();

      for (let index = 0; index < overflow; index += 1) {
        const next = iterator.next();
        if (next.done) {
          break;
        }

        this.seen.delete(next.value);
      }
    }

    dispose() {
      if (this.observer) {
        this.observer.disconnect();
      }

      if (this.attachTimer) {
        window.clearInterval(this.attachTimer);
      }

      if (this.scanTimer) {
        window.clearTimeout(this.scanTimer);
      }

      this.observer = null;
      this.root = null;
      this.attachTimer = 0;
      this.scanTimer = 0;
      this.order = 0;
      this.seen.clear();
    }
  }

  window.YoutubiCommentSource = CommentSource;
})();
