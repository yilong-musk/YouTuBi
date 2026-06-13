(() => {
  const DEFAULTS = window.YoutubiSettings.DEFAULT_SETTINGS;
  const PLAYER_HOST_CLASS = "ytbm-player-anchor";
  const LAYER_CLASS = "ytbm-surface";
  const ITEM_CLASS = "ytbm-line";
  const HORIZONTAL_PADDING = 24;
  const MIN_TRAVEL_SECONDS = 4.5;
  const MAX_TRAVEL_SECONDS = 22;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
      this.host = null;
      this.hostObserver = null;
      this.resizeObserver = null;
      this.nodes = new Map();
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

        const age = this.lastCurrentTime - item.appearAt;
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
        }
      }

      return activeCount;
    }

    renderItem(item, age) {
      let node = this.nodes.get(item.id);

      if (!node) {
        node = document.createElement("div");
        node.className = ITEM_CLASS;
        node.textContent = item.text;
        this.host.appendChild(node);
        this.nodes.set(item.id, node);
      }

      const progress = clamp(age / item.duration, 0, 1);
      const x = item.startX - progress * item.distance;

      node.style.fontSize = `${this.settings.fontSize}px`;
      node.style.opacity = `${this.settings.opacity}`;
      node.style.top = `${item.track * this.trackHeight}px`;
      node.style.transform = `translate3d(${x}px, 0, 0)`;
    }

    pause() {
      this.renderAt(this.lastCurrentTime);
    }

    resume() {
      this.renderAt(this.lastCurrentTime);
    }

    clearActive() {
      for (const node of this.nodes.values()) {
        node.remove();
      }

      this.nodes.clear();
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
      this.timeline = [];
      this.layoutItems = [];
      this.metricsCache.clear();
    }
  }

  window.YoutubiDanmakuLayer = DanmakuLayer;
})();
