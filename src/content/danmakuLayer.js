(() => {
  const DEFAULTS = window.YoutubiSettings.DEFAULT_SETTINGS;
  const PLAYER_HOST_CLASS = "ytbm-player-anchor";
  const LAYER_CLASS = "ytbm-surface";
  const ITEM_CLASS = "ytbm-line";
  const HORIZONTAL_PADDING = 24;
  const MIN_TRAVEL_SECONDS = 4.5;
  const MAX_TRAVEL_SECONDS = 22;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const t = (key, substitutions, fallback) =>
    window.YoutubiI18n ? window.YoutubiI18n.t(key, substitutions, fallback) : fallback;

  const cleanText = (text) =>
    String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);

  const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

  class DanmakuLayer {
    constructor(playerElement, settings, options = {}) {
      this.playerElement = playerElement;
      this.settings = { ...DEFAULTS, ...settings };
      this.onTimingChange = options.onTimingChange || null;
      this.onReplyRequest = options.onReplyRequest || null;
      this.host = null;
      this.hostObserver = null;
      this.resizeObserver = null;
      this.nodes = new Map();
      this.pauseStates = new Map();
      this.replyStates = new Map();
      this.timeline = [];
      this.layoutItems = [];
      this.measureCanvas = document.createElement("canvas");
      this.measureContext = this.measureCanvas.getContext("2d");
      this.metricsCache = new Map();
      this.width = 0;
      this.height = 0;
      this.trackHeight = 32;
      this.trackCount = 1;
      this.lastCurrentTime = 0;

      this.mount();
      this.setSettings(this.settings);
    }

    mount() {
      this.host = document.createElement("div");
      this.host.className = LAYER_CLASS;
      this.host.setAttribute("aria-hidden", "true");
      this.host.dataset.youtubiLayer = "true";

      const position = getComputedStyle(this.playerElement).position;
      if (position === "static") {
        this.playerElement.classList.add(PLAYER_HOST_CLASS);
      }

      this.ensureHostAttached();
      this.hostObserver = new MutationObserver(() => this.ensureHostAttached());
      this.hostObserver.observe(this.playerElement, {
        childList: true
      });

      this.resizeObserver = new ResizeObserver(() => this.updateLayout());
      this.resizeObserver.observe(this.playerElement);
      this.updateLayout();
    }

    ensureHostAttached() {
      if (!this.host || !this.playerElement) {
        return;
      }

      if (this.host.parentElement !== this.playerElement) {
        this.playerElement.appendChild(this.host);
      }
    }

    setSettings(settings) {
      const previous = this.settings;
      this.settings = { ...this.settings, ...settings };

      if (this.host) {
        this.host.hidden = !this.settings.enabled;
      }

      const timingChanged =
        previous.fontSize !== this.settings.fontSize ||
        previous.speed !== this.settings.speed;
      const layoutChanged =
        timingChanged ||
        previous.trackRatio !== this.settings.trackRatio ||
        previous.maxOnScreen !== this.settings.maxOnScreen;

      this.updateLayout();

      if (layoutChanged) {
        this.rebuildLayout();
      }

      if (!this.settings.enabled) {
        this.clearActive();
      } else {
        this.renderAt(this.lastCurrentTime);
      }

      if (timingChanged) {
        this.notifyTimingChange("settings-timing-updated");
      }
    }

    setDebugStatus(status) {
      if (!this.host || !status || typeof status !== "object") {
        return;
      }

      this.ensureHostAttached();

      Object.entries(status).forEach(([key, value]) => {
        const attributeName = `youtubi${key.charAt(0).toUpperCase()}${key.slice(1)}`;
        this.host.dataset[attributeName] = String(value);
      });
    }

    setTimeline(timeline) {
      this.timeline = Array.isArray(timeline) ? timeline.slice() : [];
      this.prunePauseStates();
      this.pruneReplyStates();
      this.rebuildLayout();
      this.renderAt(this.lastCurrentTime);
    }

    updateLayout() {
      if (!this.host) {
        return;
      }

      this.ensureHostAttached();

      const previousWidth = this.width;
      const previousHeight = this.height;
      const previousTrackHeight = this.trackHeight;
      const previousTrackCount = this.trackCount;

      this.width = this.host.clientWidth || this.playerElement.clientWidth || 640;
      this.height = this.host.clientHeight || this.playerElement.clientHeight || 360;
      this.trackHeight = Math.max(24, Math.ceil(this.settings.fontSize * 1.55));

      const usableHeight = Math.max(this.trackHeight, this.height * this.settings.trackRatio);
      this.trackCount = Math.max(1, Math.floor(usableHeight / this.trackHeight));

      const sizeChanged =
        previousWidth !== this.width ||
        previousHeight !== this.height ||
        previousTrackHeight !== this.trackHeight ||
        previousTrackCount !== this.trackCount;

      if (sizeChanged) {
        this.metricsCache.clear();
        this.rebuildLayout();
        this.renderAt(this.lastCurrentTime);
      }

      if (previousWidth > 0 && previousWidth !== this.width) {
        this.notifyTimingChange("viewport-timing-updated");
      }
    }

    notifyTimingChange(reason) {
      if (this.onTimingChange) {
        this.onTimingChange({ reason });
      }
    }

    rebuildLayout() {
      const trackAvailableAt = Array.from({ length: this.trackCount }, () => Number.NEGATIVE_INFINITY);
      const previousItems = new Map(this.layoutItems.map((item) => [item.id, item]));

      this.layoutItems = this.timeline.map((item, index) => {
        const metrics = this.getMetrics(item.text);
        const previous = previousItems.get(item.id);
        const canReuseTrack =
          previous &&
          previous.track < this.trackCount &&
          previous.text === metrics.text &&
          previous.appearAt === item.appearAt &&
          trackAvailableAt[previous.track] <= item.appearAt;
        const track = canReuseTrack
          ? previous.track
          : this.pickTrack(item.appearAt, trackAvailableAt);
        trackAvailableAt[track] = Math.max(trackAvailableAt[track], item.appearAt + metrics.safeGapSeconds);

        return {
          ...item,
          index,
          track,
          ...metrics
        };
      });
    }

    pickTrack(appearAt, trackAvailableAt) {
      for (let index = 0; index < trackAvailableAt.length; index += 1) {
        if (trackAvailableAt[index] <= appearAt) {
          return index;
        }
      }

      let bestTrack = 0;
      let bestTime = trackAvailableAt[0];

      for (let index = 1; index < trackAvailableAt.length; index += 1) {
        if (trackAvailableAt[index] < bestTime) {
          bestTime = trackAvailableAt[index];
          bestTrack = index;
        }
      }

      return bestTrack;
    }

    getMetrics(text) {
      const normalized = cleanText(text);
      const cacheKey = [
        this.width,
        this.settings.fontSize,
        this.settings.speed,
        normalized
      ].join("|");
      const cached = this.metricsCache.get(cacheKey);

      if (cached) {
        return cached;
      }

      if (this.measureContext) {
        this.measureContext.font = `600 ${this.settings.fontSize}px Roboto, Arial, "Microsoft YaHei", sans-serif`;
      }

      const measuredWidth = this.measureContext
        ? Math.ceil(this.measureContext.measureText(normalized).width)
        : 0;
      const textWidth = Math.max(16, measuredWidth || Math.ceil(normalized.length * this.settings.fontSize * 0.65));
      const startX = this.width + HORIZONTAL_PADDING;
      const endX = -textWidth - HORIZONTAL_PADDING;
      const distance = startX - endX;
      const duration = clamp(distance / this.settings.speed, MIN_TRAVEL_SECONDS, MAX_TRAVEL_SECONDS);
      const safeGapSeconds = Math.max(0.45, (textWidth + 96) / this.settings.speed);
      const metrics = {
        text: normalized,
        textWidth,
        startX,
        endX,
        distance,
        duration,
        safeGapSeconds
      };

      this.metricsCache.set(cacheKey, metrics);
      return metrics;
    }

    getTravelDuration(text) {
      return this.getMetrics(text).duration;
    }

    renderAt(currentTime) {
      this.lastCurrentTime = isFiniteNumber(currentTime) ? currentTime : this.lastCurrentTime;

      if (!this.host || !this.settings.enabled || !isFiniteNumber(this.lastCurrentTime)) {
        return this.nodes.size;
      }

      this.ensureHostAttached();

      const activeIds = new Set();
      let activeCount = 0;

      for (const item of this.layoutItems) {
        if (item.appearAt > this.lastCurrentTime) {
          break;
        }

        const age = this.getEffectiveAge(item, this.lastCurrentTime);
        if (age < 0 || age > item.duration) {
          continue;
        }

        if (activeCount >= this.settings.maxOnScreen) {
          break;
        }

        activeIds.add(item.id);
        activeCount += 1;
        this.renderItem(item, age);
      }

      for (const [id, node] of this.nodes) {
        if (!activeIds.has(id)) {
          node.remove();
          this.nodes.delete(id);
          this.pauseStates.delete(id);
        }
      }

      return activeCount;
    }

    getEffectiveAge(item, currentTime) {
      const rawAge = currentTime - item.appearAt;
      const state = this.pauseStates.get(item.id);
      if (!state) {
        return rawAge;
      }

      if (state.paused) {
        return state.pausedAge;
      }

      return rawAge - state.totalPausedSeconds;
    }

    renderItem(item, age) {
      let node = this.nodes.get(item.id);

      if (!node) {
        node = document.createElement("div");
        node.className = ITEM_CLASS;
        node.textContent = item.text;
        node.dataset.ytbmItemId = item.id;
        node.addEventListener("pointerenter", (event) => this.pauseItem(item.id, event));
        node.addEventListener("pointerleave", () => this.resumeItem(item.id));
        this.host.appendChild(node);
        this.nodes.set(item.id, node);
      }

      const progress = clamp(age / item.duration, 0, 1);
      const x = item.startX - progress * item.distance;
      const hasReplies = Boolean(item.comment && (item.comment.replyContinuationToken || item.comment.hasReplies));

      node.classList.toggle("has-replies", hasReplies);
      node.style.fontSize = `${this.settings.fontSize}px`;
      node.style.opacity = `${this.settings.opacity}`;
      node.style.top = `${item.track * this.trackHeight}px`;
      node.style.transform = `translate3d(${x}px, 0, 0)`;
    }

    pauseItem(id, event = null) {
      const item = this.findLayoutItem(id);
      if (!item || !this.settings.enabled) {
        return;
      }

      const state = this.getPauseState(id);
      if (state.paused) {
        return;
      }

      const pausedAge = clamp(this.getEffectiveAge(item, this.lastCurrentTime), 0, item.duration);
      state.paused = true;
      state.pausedAt = this.lastCurrentTime;
      state.pausedAge = pausedAge;

      const node = this.nodes.get(id);
      if (node) {
        node.classList.add("is-hover-paused");
      }

      this.renderItem(item, state.pausedAge);
      this.expandReplies(item, event && event.clientX);
    }

    resumeItem(id) {
      const state = this.pauseStates.get(id);
      if (!state || !state.paused) {
        return;
      }

      this.hideReplies(id);
      state.totalPausedSeconds += Math.max(0, this.lastCurrentTime - state.pausedAt);
      state.paused = false;
      state.pausedAt = 0;

      const node = this.nodes.get(id);
      if (node) {
        node.classList.remove("is-hover-paused");
      }

      this.renderAt(this.lastCurrentTime);
    }

    getPauseState(id) {
      let state = this.pauseStates.get(id);
      if (!state) {
        state = {
          totalPausedSeconds: 0,
          paused: false,
          pausedAt: 0,
          pausedAge: 0
        };
        this.pauseStates.set(id, state);
      }

      return state;
    }

    findLayoutItem(id) {
      return this.layoutItems.find((item) => item.id === id) || null;
    }

    prunePauseStates() {
      if (!this.pauseStates.size) {
        return;
      }

      const timelineIds = new Set(this.timeline.map((item) => item.id));
      for (const id of this.pauseStates.keys()) {
        if (!timelineIds.has(id)) {
          this.pauseStates.delete(id);
        }
      }
    }

    hasReplyList(item) {
      return Boolean(item && item.comment && item.comment.replyContinuationToken && this.onReplyRequest);
    }

    expandReplies(item, anchorClientX = null) {
      if (!this.hasReplyList(item)) {
        return;
      }

      const state = this.getReplyState(item.id);
      state.expanded = true;
      if (isFiniteNumber(anchorClientX)) {
        state.anchorClientX = anchorClientX;
      }

      if (state.status === "done" || state.status === "failed") {
        this.renderReplyPanel(item, state);
        return;
      }

      state.status = "loading";
      this.renderReplyPanel(item, state);

      if (state.request) {
        return;
      }

      state.request = Promise.resolve(this.onReplyRequest(item.comment))
        .then((result) => {
          state.request = null;
          if (result && result.status === "failed") {
            state.status = "failed";
            state.message = result.message || "";
            if (state.expanded && this.isItemPaused(item.id)) {
              this.renderReplyPanel(item, state);
            }
            return;
          }

          state.status = "done";
          state.replies = Array.isArray(result && result.replies) ? result.replies : [];
          state.hasMore = Boolean(result && result.hasMore);
          state.replyCountText = result && result.replyCountText ? result.replyCountText : item.comment.replyCountText || "";

          if (state.expanded && this.isItemPaused(item.id)) {
            this.renderReplyPanel(item, state);
          }
        })
        .catch((error) => {
          state.request = null;
          state.status = "failed";
          state.message = error && error.message ? error.message : String(error || "failed");

          if (state.expanded && this.isItemPaused(item.id)) {
            this.renderReplyPanel(item, state);
          }
        });
    }

    hideReplies(id) {
      const state = this.replyStates.get(id);
      if (state) {
        state.expanded = false;
      }

      const node = this.nodes.get(id);
      const panel = node && node.querySelector(".ytbm-replies");
      if (panel) {
        panel.remove();
      }
    }

    renderReplyPanel(item, state) {
      const node = this.nodes.get(item.id);
      if (!node || !state.expanded) {
        return;
      }

      const panel = this.ensureReplyPanel(node);
      const children = [];

      if (state.status === "loading") {
        children.push(this.createReplyStatus(t("replyLoading", null, "Loading replies...")));
      } else if (state.status === "failed") {
        children.push(this.createReplyStatus(t("replyFailed", null, "Failed to load replies")));
      } else if (!state.replies.length) {
        children.push(this.createReplyStatus(t("replyEmpty", null, "No replies")));
      } else {
        const headerText = state.replyCountText || t("replyCount", state.replies.length, "$1 replies");
        const header = document.createElement("div");
        header.className = "ytbm-replies-header";
        header.textContent = headerText;
        children.push(header);

        const thread = document.createElement("div");
        thread.className = "ytbm-reply-thread";

        state.replies.forEach((reply, index) => {
          thread.appendChild(this.createThreadNode(reply, {
            className: this.getReplyDepthClass(reply, state.replies, index, item.comment)
          }));
        });
        children.push(thread);

        if (state.hasMore) {
          children.push(this.createReplyStatus(t("replyMore", null, "More replies available")));
        }
      }

      panel.replaceChildren(...children);
      this.positionReplyPanel(node, panel, state);
    }

    positionReplyPanel(node, panel, state) {
      if (!node || !panel || !state || !isFiniteNumber(state.anchorClientX)) {
        if (panel) {
          panel.style.left = "";
        }
        return;
      }

      const nodeRect = node.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const hostRect = this.host ? this.host.getBoundingClientRect() : null;
      let left = state.anchorClientX - nodeRect.left;

      if (hostRect && panelRect.width > 0) {
        const margin = 8;
        const minLeft = hostRect.left - nodeRect.left + margin;
        const maxLeft = hostRect.right - nodeRect.left - panelRect.width - margin;
        left = maxLeft >= minLeft ? clamp(left, minLeft, maxLeft) : minLeft;
      }

      panel.style.left = `${Math.round(left)}px`;
    }

    ensureReplyPanel(node) {
      let panel = node.querySelector(".ytbm-replies");
      if (!panel) {
        panel = document.createElement("div");
        panel.className = "ytbm-replies";
        node.appendChild(panel);
      }

      return panel;
    }

    createThreadNode(comment, options = {}) {
      const node = document.createElement("div");
      node.className = ["ytbm-thread-node", options.className].filter(Boolean).join(" ");

      const content = document.createElement("div");
      content.className = "ytbm-thread-text";
      const authorLabel = this.getAuthorLabel(comment);
      if (authorLabel) {
        const author = document.createElement("span");
        author.className = "ytbm-thread-author";
        author.textContent = authorLabel;
        content.append(author, document.createTextNode(": "));
      }
      this.appendTextWithMention(content, comment.text, comment.replyToHandle);

      node.append(content);

      return node;
    }

    getAuthorLabel(comment) {
      return cleanText(comment.authorHandle || comment.authorName);
    }

    appendTextWithMention(node, text, mention) {
      const normalized = cleanText(text);
      if (!mention || !normalized.startsWith(mention)) {
        node.append(document.createTextNode(normalized));
        return;
      }

      const mentionNode = document.createElement("span");
      mentionNode.className = "ytbm-thread-mention";
      mentionNode.textContent = mention;

      node.append(mentionNode, document.createTextNode(normalized.slice(mention.length)));
    }

    getReplyDepthClass(reply, replies, index, parentComment) {
      const replyTo = this.normalizeHandle(reply.replyToHandle);
      const parentHandle = this.normalizeHandle(parentComment.authorHandle || parentComment.authorName);
      const referencesPeer = replyTo && replyTo !== parentHandle && replies
        .slice(0, index)
        .some((candidate) => this.normalizeHandle(candidate.authorHandle || candidate.authorName) === replyTo);

      return referencesPeer ? "is-nested" : "";
    }

    normalizeHandle(value) {
      const text = String(value || "").trim().toLowerCase();
      const match = text.match(/@[\p{L}\p{N}_.-]+/u);
      return match ? match[0] : text;
    }

    createReplyStatus(text) {
      const node = document.createElement("div");
      node.className = "ytbm-replies-status";
      node.textContent = text;
      return node;
    }

    getReplyState(id) {
      let state = this.replyStates.get(id);
      if (!state) {
        state = {
          status: "idle",
          expanded: false,
          request: null,
          replies: [],
          hasMore: false,
          replyCountText: "",
          anchorClientX: null,
          message: ""
        };
        this.replyStates.set(id, state);
      }

      return state;
    }

    isItemPaused(id) {
      const state = this.pauseStates.get(id);
      return Boolean(state && state.paused);
    }

    pruneReplyStates() {
      if (!this.replyStates.size) {
        return;
      }

      const timelineIds = new Set(this.timeline.map((item) => item.id));
      for (const id of this.replyStates.keys()) {
        if (!timelineIds.has(id)) {
          this.replyStates.delete(id);
        }
      }
    }

    pause() {
      this.renderAt(this.lastCurrentTime);
    }

    resume() {
      this.renderAt(this.lastCurrentTime);
    }

    clearHoverPauses() {
      this.pauseStates.clear();
      for (const state of this.replyStates.values()) {
        state.expanded = false;
      }
      for (const node of this.nodes.values()) {
        node.classList.remove("is-hover-paused");
        const panel = node.querySelector(".ytbm-replies");
        if (panel) {
          panel.remove();
        }
      }
    }

    clearActive() {
      for (const node of this.nodes.values()) {
        node.remove();
      }

      this.nodes.clear();
      this.pauseStates.clear();
      this.replyStates.clear();
    }

    dispose() {
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
      }

      if (this.hostObserver) {
        this.hostObserver.disconnect();
      }

      this.clearActive();

      if (this.host) {
        this.host.remove();
      }

      this.host = null;
      this.hostObserver = null;
      this.resizeObserver = null;
      this.playerElement = null;
      this.onTimingChange = null;
      this.onReplyRequest = null;
      this.timeline = [];
      this.layoutItems = [];
      this.pauseStates.clear();
      this.replyStates.clear();
      this.metricsCache.clear();
    }
  }

  window.YoutubiDanmakuLayer = DanmakuLayer;
})();
