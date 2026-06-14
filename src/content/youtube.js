(() => {
  const APP_KEY = "__youtubiContentApp";

  if (window[APP_KEY]) {
    window[APP_KEY].dispose();
  }

  const PLAYER_SELECTORS = [
    "#movie_player.html5-video-player",
    "#movie_player",
    ".html5-video-player"
  ];

  const ACTION_BUTTON_CONTAINER_SELECTORS = [
    "ytd-watch-metadata #top-level-buttons-computed",
    "ytd-video-primary-info-renderer #top-level-buttons-computed",
    "ytd-watch-metadata yt-flexible-actions-view-model",
    "yt-flexible-actions-view-model",
    "ytd-watch-metadata #actions-inner",
    "ytd-watch-metadata #actions",
    "#top-level-buttons-computed"
  ];

  const LIKE_BUTTON_SELECTORS = [
    "segmented-like-dislike-button-view-model",
    "ytd-segmented-like-dislike-button-renderer",
    "like-button-view-model",
    "toggle-button-view-model:first-child",
    "ytd-toggle-button-renderer:first-child",
    "button[aria-label^='Like' i]",
    "button[aria-label^='I like' i]",
    "button[aria-label*='喜欢']",
    "button[aria-label*='赞']",
    "button[aria-label*='喜歡']"
  ];

  const t = (key, substitutions, fallback) =>
    window.YoutubiI18n ? window.YoutubiI18n.t(key, substitutions, fallback) : fallback;

  class YoutubiApp {
    constructor() {
      this.settings = window.YoutubiSettings.DEFAULT_SETTINGS;
      this.layer = null;
      this.commentSource = null;
      this.apiCommentSource = null;
      this.timelineScheduler = null;
      this.toggleButton = null;
      this.toggleButtonLabel = null;
      this.toggleMountTimer = 0;
      this.toggleVisibilityTimer = 0;
      this.toggleMountAttempts = 0;
      this.toggleObserver = null;
      this.toggleObserverTarget = null;
      this.unsubscribeSettings = null;
      this.routeTimer = 0;
      this.retryTimer = 0;
      this.retryCount = 0;
      this.lastUrl = "";
      this.activeVideoId = "";
      this.debugState = null;
      this.boundRouteChanged = () => this.scheduleRebuild(300);
    }

    async start() {
      this.settings = await window.YoutubiSettings.load();
      this.unsubscribeSettings = window.YoutubiSettings.subscribe((settings) => {
        this.settings = settings;
        this.applySettings("settings-updated");
      });

      this.installRouteWatchers();
      this.scheduleRebuild(0);
    }

    installRouteWatchers() {
      window.addEventListener("yt-navigate-start", this.boundRouteChanged);
      window.addEventListener("yt-navigate", this.boundRouteChanged);
      window.addEventListener("yt-navigate-finish", this.boundRouteChanged);
      window.addEventListener("yt-page-data-updated", this.boundRouteChanged);
      window.addEventListener("yt-page-type-changed", this.boundRouteChanged);
      window.addEventListener("popstate", this.boundRouteChanged);

      this.routeTimer = window.setInterval(() => {
        if (this.lastUrl !== location.href) {
          this.scheduleRebuild(250);
        } else if (this.shouldRecoverWatchPage()) {
          this.scheduleRebuild(0);
        } else if (this.activeVideoId) {
          if (this.toggleButton && this.toggleButton.classList.contains("is-floating")) {
            this.scheduleToggleVisibilityCheck();
          } else {
            this.scheduleToggleMount(0);
          }
        }
      }, 1000);
    }

    shouldRecoverWatchPage() {
      if (location.pathname !== "/watch") {
        return false;
      }

      const videoId = this.getVideoId();
      if (!videoId) {
        return false;
      }

      if (!this.activeVideoId || videoId !== this.activeVideoId || !this.layer || !this.timelineScheduler) {
        return true;
      }

      if (!this.layer.host || !this.layer.host.isConnected) {
        return true;
      }

      if (!this.layer.playerElement || !this.layer.playerElement.isConnected) {
        return true;
      }

      const player = this.findPlayer();
      if (player && player !== this.layer.playerElement) {
        return true;
      }

      const video = player && this.findVideo(player);
      return Boolean(video && this.timelineScheduler.video && video !== this.timelineScheduler.video);
    }

    scheduleRebuild(delay) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = window.setTimeout(() => this.rebuild(), delay);
    }

    rebuild() {
      const currentUrl = location.href;
      const shouldRun = location.hostname.includes("youtube.com") && location.pathname === "/watch";

      if (!shouldRun) {
        this.lastUrl = currentUrl;
        this.disposePage();
        return;
      }

      const player = this.findPlayer();
      const video = player && this.findVideo(player);
      if (!player || !video) {
        this.retryCount += 1;

        if (this.retryCount <= 40) {
          this.scheduleRebuild(250);
        }

        return;
      }

      if (
        this.layer &&
        this.timelineScheduler &&
        this.layer.host &&
        this.layer.host.isConnected &&
        this.layer.playerElement === player &&
        this.timelineScheduler.video === video &&
        this.lastUrl === currentUrl
      ) {
        return;
      }

      this.disposePage();
      this.retryCount = 0;
      this.lastUrl = currentUrl;
      const videoId = this.getVideoId();
      this.activeVideoId = videoId;
      this.resetDebugState(videoId);
      this.layer = new window.YoutubiDanmakuLayer(player, this.settings, {
        onTimingChange: (event) => {
          if (this.timelineScheduler) {
            this.timelineScheduler.handleLayoutTimingChange(event.reason);
          }
        },
        onReplyRequest: (comment) => {
          if (!this.isCurrentVideo(videoId)) {
            return Promise.resolve({ status: "stale", replies: [] });
          }

          return this.loadRepliesForComment(videoId, comment);
        }
      });
      this.timelineScheduler = new window.YoutubiTimelineScheduler({
        layer: this.layer,
        video,
        autoRelease: false,
        onStateChange: (updates) => this.updateDebugState(updates)
      });
      this.updateDebugState({ status: "mounted" });
      this.apiCommentSource = new window.YoutubiYouTubeCommentApiSource({
        videoId,
        maxComments: this.settings.preloadLimit,
        onComment: (comment) => {
          if (!this.isCurrentVideo(videoId)) {
            return;
          }

          this.recordComment("api");
          if (this.timelineScheduler) {
            this.timelineScheduler.addComment(comment);
            this.updateDebugState({ status: "api-comment" });
          }
        },
        onStatus: (status) => {
          if (!this.isCurrentVideo(videoId)) {
            return;
          }

          this.updateDebugState({
            apiStatus: status.status,
            apiLoaded: status.loadedCount,
            apiError: status.message || ""
          });

          if (this.shouldUseDomFallback(status)) {
            this.startDomFallback(videoId, status.status);
            return;
          }

          if (this.timelineScheduler && this.isApiSuccessTerminalStatus(status.status)) {
            this.timelineScheduler.completeInitialLoad(status.status);
          }
        }
      });
      this.apiCommentSource.start();
      this.scheduleToggleMount(0);
    }

    findPlayer() {
      for (const selector of PLAYER_SELECTORS) {
        const node = document.querySelector(selector);
        if (node) {
          return node;
        }
      }

      return null;
    }

    findVideo(player) {
      return player.querySelector("video") || document.querySelector("video.html5-main-video") || document.querySelector("video");
    }

    getVideoId() {
      try {
        return new URL(location.href).searchParams.get("v") || "";
      } catch (error) {
        return "";
      }
    }

    isCurrentVideo(videoId) {
      return Boolean(videoId) && videoId === this.activeVideoId && videoId === this.getVideoId();
    }

    applySettings(status) {
      if (this.layer) {
        this.layer.setSettings(this.settings);
        this.updateDebugState({ status });
      }

      this.updateToggleButton();
    }

    scheduleToggleMount(delay) {
      window.clearTimeout(this.toggleMountTimer);
      this.toggleMountTimer = window.setTimeout(() => this.mountToggleButton(), delay);
    }

    mountToggleButton() {
      this.toggleMountTimer = 0;

      if (!this.activeVideoId || location.pathname !== "/watch") {
        return;
      }

      const target = this.findToggleMountTarget();
      if (!target) {
        this.toggleMountAttempts += 1;
        if (this.toggleMountAttempts <= 40) {
          this.scheduleToggleMount(250);
        }
        return;
      }

      this.toggleMountAttempts = 0;

      if (!this.toggleButton) {
        this.createToggleButton();
      }

      this.attachToggleToTarget(target);
    }

    findToggleMountTarget() {
      const likeButton = this.findVisibleLikeButton();
      if (likeButton) {
        const container = this.findActionContainerFor(likeButton);
        const anchor = container && this.getTopLevelActionButton(container, likeButton);
        if (container && anchor && anchor !== this.toggleButton) {
          return { container, anchor };
        }
      }

      for (const container of this.findVisibleActionContainers()) {
        const anchor = Array.from(container.children).find((child) => child !== this.toggleButton && this.isVisibleElement(child));
        if (anchor) {
          return { container, anchor };
        }
      }

      return null;
    }

    findVisibleLikeButton() {
      const scopes = [
        document.querySelector("ytd-watch-metadata"),
        document.querySelector("ytd-video-primary-info-renderer"),
        document
      ].filter(Boolean);

      for (const scope of scopes) {
        for (const selector of LIKE_BUTTON_SELECTORS) {
          const nodes = Array.from(scope.querySelectorAll(selector));
          const node = nodes.find((candidate) => this.isVisibleElement(candidate));
          if (node) {
            return node;
          }
        }
      }

      return null;
    }

    findVisibleActionContainers() {
      const containers = [];
      for (const selector of ACTION_BUTTON_CONTAINER_SELECTORS) {
        document.querySelectorAll(selector).forEach((container) => {
          if (!containers.includes(container) && this.isVisibleElement(container)) {
            containers.push(container);
          }
        });
      }

      return containers;
    }

    findActionContainerFor(node) {
      const candidates = [
        node.closest("#top-level-buttons-computed"),
        node.closest("yt-flexible-actions-view-model"),
        node.closest("#actions-inner"),
        node.closest("#actions")
      ];

      for (const container of candidates) {
        if (container && this.isVisibleElement(container)) {
          return container;
        }
      }

      for (const container of this.findVisibleActionContainers()) {
        if (container.contains(node)) {
          return container;
        }
      }

      return null;
    }

    isVisibleElement(node) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE || !node.isConnected) {
        return false;
      }

      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }

      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
        return false;
      }

      return true;
    }

    getTopLevelActionButton(container, node) {
      let current = node;

      while (current && current.parentElement !== container) {
        current = current.parentElement;
      }

      return current || node;
    }

    createToggleButton() {
      this.toggleButton = document.createElement("button");
      this.toggleButton.type = "button";
      this.toggleButton.className = "ytbm-watch-toggle";
      this.toggleButton.setAttribute("aria-label", t("watchToggleAria", null, "Toggle danmaku"));

      this.toggleButtonLabel = document.createElement("span");
      this.toggleButtonLabel.className = "ytbm-watch-toggle-label";
      this.toggleButtonLabel.textContent = t("watchToggleLabel", null, "Danmaku");

      const toggleTrack = document.createElement("span");
      toggleTrack.className = "ytbm-watch-toggle-track";

      const toggleThumb = document.createElement("span");
      toggleThumb.className = "ytbm-watch-toggle-thumb";

      toggleTrack.append(toggleThumb);
      this.toggleButton.append(this.toggleButtonLabel, toggleTrack);
      this.toggleButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.toggleDanmakuFromWatchButton();
      });
    }

    attachToggleToTarget(target) {
      if (!this.toggleButton || !target || !target.container || !target.anchor) {
        return false;
      }

      this.clearFloatingTogglePosition();

      if (this.toggleButton.parentElement !== target.container || this.toggleButton.nextElementSibling !== target.anchor) {
        target.container.insertBefore(this.toggleButton, target.anchor);
      }

      this.observeToggleContainer(target.container);
      this.updateToggleButton();
      this.scheduleToggleVisibilityCheck();

      return true;
    }

    async toggleDanmakuFromWatchButton() {
      const enabled = !this.settings.enabled;
      this.settings = { ...this.settings, enabled };
      this.applySettings("watch-toggle");

      const saved = await window.YoutubiSettings.save({ enabled });
      this.settings = saved;
      this.applySettings("watch-toggle-saved");
    }

    updateToggleButton() {
      if (!this.toggleButton) {
        return;
      }

      const enabled = Boolean(this.settings.enabled);
      this.toggleButton.classList.toggle("is-off", !enabled);
      this.toggleButton.classList.toggle("is-on", enabled);
      this.toggleButton.setAttribute("aria-pressed", String(enabled));
      this.toggleButton.title = enabled
        ? t("watchToggleOffTitle", null, "Turn off danmaku")
        : t("watchToggleOnTitle", null, "Turn on danmaku");
    }

    scheduleToggleVisibilityCheck() {
      window.clearTimeout(this.toggleVisibilityTimer);
      this.toggleVisibilityTimer = window.setTimeout(() => this.ensureToggleVisible(), 50);
    }

    ensureToggleVisible() {
      this.toggleVisibilityTimer = 0;

      if (!this.toggleButton || !this.toggleButton.isConnected || !this.activeVideoId) {
        return;
      }

      if (this.toggleButton.classList.contains("is-floating")) {
        if (this.restoreFloatingToggle()) {
          return;
        }

        this.updateFloatingTogglePosition();
        return;
      }

      if (this.isVisibleElement(this.toggleButton)) {
        this.clearFloatingTogglePosition();
        return;
      }

      this.enableFloatingToggle();
    }

    restoreFloatingToggle() {
      const target = this.findToggleMountTarget();
      if (!target) {
        return false;
      }

      this.attachToggleToTarget(target);
      if (this.isVisibleElement(this.toggleButton)) {
        return true;
      }

      this.enableFloatingToggle();
      return false;
    }

    enableFloatingToggle() {
      if (!this.toggleButton) {
        return;
      }

      if (this.toggleButton.parentElement !== document.body) {
        document.body.appendChild(this.toggleButton);
      }

      this.toggleButton.classList.add("is-floating");
      this.updateFloatingTogglePosition();
    }

    updateFloatingTogglePosition() {
      if (!this.toggleButton) {
        return;
      }

      const likeButton = this.findVisibleLikeButton();
      if (!likeButton) {
        return;
      }

      const likeRect = likeButton.getBoundingClientRect();
      const width = 78;
      const height = Math.max(36, Math.min(40, likeRect.height || 36));
      const left = Math.max(8, likeRect.left - width - 8);
      const top = Math.max(8, likeRect.top + (likeRect.height - height) / 2);

      this.toggleButton.style.left = `${Math.round(left)}px`;
      this.toggleButton.style.top = `${Math.round(top)}px`;
      this.toggleButton.style.width = `${width}px`;
      this.toggleButton.style.height = `${height}px`;
    }

    clearFloatingTogglePosition() {
      if (!this.toggleButton || !this.toggleButton.classList.contains("is-floating")) {
        return;
      }

      this.toggleButton.classList.remove("is-floating");
      this.toggleButton.style.left = "";
      this.toggleButton.style.top = "";
      this.toggleButton.style.width = "";
      this.toggleButton.style.height = "";
    }

    observeToggleContainer(container) {
      if (this.toggleObserverTarget === container) {
        return;
      }

      if (this.toggleObserver) {
        this.toggleObserver.disconnect();
      }

      this.toggleObserverTarget = container;
      this.toggleObserver = new MutationObserver(() => {
        if (this.toggleButton && this.toggleButton.classList.contains("is-floating")) {
          this.scheduleToggleVisibilityCheck();
          return;
        }

        if (!this.toggleButton || !this.toggleButton.isConnected || this.toggleButton.parentElement !== container) {
          this.scheduleToggleMount(100);
          return;
        }

        const target = this.findToggleMountTarget();
        if (target && target.anchor && this.toggleButton.nextElementSibling !== target.anchor) {
          this.scheduleToggleMount(100);
        }

        this.scheduleToggleVisibilityCheck();
      });
      this.toggleObserver.observe(container, { childList: true });
    }

    isApiSuccessTerminalStatus(status) {
      return (
        status === "done" ||
        status === "continuation-missing"
      );
    }

    shouldUseDomFallback(status) {
      if (!status || typeof status !== "object") {
        return false;
      }

      return (
        status.status === "failed" ||
        status.status === "config-missing" ||
        (status.status === "continuation-missing" && !status.loadedCount)
      );
    }

    async loadRepliesForComment(videoId, comment) {
      if (!this.isCurrentVideo(videoId) || !comment || !comment.replyContinuationToken) {
        return { status: "unavailable", replies: [] };
      }

      if (!this.apiCommentSource || typeof this.apiCommentSource.loadReplies !== "function") {
        return { status: "unavailable", replies: [] };
      }

      try {
        const result = await this.apiCommentSource.loadReplies(comment);
        if (!this.isCurrentVideo(videoId)) {
          return { status: "stale", replies: [] };
        }

        return result;
      } catch (error) {
        if (this.isCurrentVideo(videoId)) {
          console.info(t("logReplyCommentsFailed", null, "[Youtubi] Reply comments failed"), error);
        }

        return {
          status: "failed",
          message: error && error.message ? error.message : String(error),
          replies: []
        };
      }
    }

    startDomFallback(videoId, reason) {
      if (!this.isCurrentVideo(videoId) || this.commentSource) {
        return;
      }

      if (this.apiCommentSource) {
        this.apiCommentSource.dispose();
        this.apiCommentSource = null;
      }

      if (this.timelineScheduler && typeof this.timelineScheduler.reset === "function") {
        this.timelineScheduler.reset("dom-fallback", { autoRelease: true });
      }

      this.updateDebugState({
        status: "dom-fallback",
        apiStatus: reason || "fallback",
        apiLoaded: 0,
        apiComments: 0,
        domComments: 0
      });

      this.commentSource = new window.YoutubiCommentSource({
        videoId,
        onComment: (comment) => {
          if (!this.isCurrentVideo(videoId)) {
            return;
          }

          this.recordComment("dom");
          if (this.timelineScheduler) {
            this.timelineScheduler.addComment(comment);
            this.updateDebugState({ status: "dom-comment" });
          }
        }
      });
      this.commentSource.start();
    }

    resetDebugState(videoId) {
      this.debugState = {
        status: "starting",
        videoId,
        apiStatus: "idle",
        apiLoaded: 0,
        apiComments: 0,
        domComments: 0,
        totalComments: 0,
        timelineItems: 0,
        layoutItems: 0,
        renderedItems: 0,
        enabled: this.settings.enabled,
        apiError: ""
      };
    }

    recordComment(source) {
      if (!this.debugState) {
        return;
      }

      if (source === "api") {
        this.debugState.apiComments += 1;
      } else if (source === "dom") {
        this.debugState.domComments += 1;
      }
    }

    updateDebugState(updates = {}) {
      if (!this.debugState) {
        return;
      }

      const timelineComments = this.timelineScheduler && this.timelineScheduler.comments
        ? this.timelineScheduler.comments.size
        : 0;
      const timelineItems = this.timelineScheduler && this.timelineScheduler.timeline
        ? this.timelineScheduler.timeline.length
        : 0;
      const layoutItems = this.layer && this.layer.layoutItems ? this.layer.layoutItems.length : 0;
      const renderedItems = this.layer && this.layer.nodes ? this.layer.nodes.size : 0;

      this.debugState = {
        ...this.debugState,
        totalComments: timelineComments,
        timelineItems,
        layoutItems,
        renderedItems,
        enabled: this.settings.enabled,
        ...updates
      };

      if (this.layer && typeof this.layer.setDebugStatus === "function") {
        this.layer.setDebugStatus(this.debugState);
      }
    }

    disposePage() {
      this.disposeToggleButton();

      if (this.commentSource) {
        this.commentSource.dispose();
      }

      if (this.apiCommentSource) {
        this.apiCommentSource.dispose();
      }

      if (this.timelineScheduler) {
        this.timelineScheduler.dispose();
      }

      if (this.layer) {
        this.layer.dispose();
      }

      this.commentSource = null;
      this.apiCommentSource = null;
      this.timelineScheduler = null;
      this.layer = null;
      this.debugState = null;
      this.activeVideoId = "";
    }

    disposeToggleButton() {
      window.clearTimeout(this.toggleMountTimer);
      window.clearTimeout(this.toggleVisibilityTimer);
      this.toggleMountTimer = 0;
      this.toggleVisibilityTimer = 0;
      this.toggleMountAttempts = 0;

      if (this.toggleObserver) {
        this.toggleObserver.disconnect();
      }

      if (this.toggleButton) {
        this.toggleButton.remove();
      }

      this.toggleButton = null;
      this.toggleButtonLabel = null;
      this.toggleObserver = null;
      this.toggleObserverTarget = null;
    }

    dispose() {
      window.clearInterval(this.routeTimer);
      window.clearTimeout(this.retryTimer);
      window.removeEventListener("yt-navigate-start", this.boundRouteChanged);
      window.removeEventListener("yt-navigate", this.boundRouteChanged);
      window.removeEventListener("yt-navigate-finish", this.boundRouteChanged);
      window.removeEventListener("yt-page-data-updated", this.boundRouteChanged);
      window.removeEventListener("yt-page-type-changed", this.boundRouteChanged);
      window.removeEventListener("popstate", this.boundRouteChanged);

      if (this.unsubscribeSettings) {
        this.unsubscribeSettings();
      }

      this.disposePage();
    }
  }

  const app = new YoutubiApp();
  window[APP_KEY] = app;
  app.start();
})();
