(() => {
  const DEFAULTS = window.YoutubiSettings.DEFAULT_SETTINGS;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const cleanText = (text) =>
    String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);

  class DanmakuLayer {
    constructor(playerElement, settings) {
      this.playerElement = playerElement;
      this.settings = { ...DEFAULTS, ...settings };
      this.queue = [];
      this.activeNodes = new Set();
      this.trackAvailableAt = [];
      this.timer = 0;
      this.width = 0;
      this.height = 0;
      this.trackHeight = 32;
      this.trackCount = 1;

      this.mount();
      this.setSettings(this.settings);
    }

    mount() {
      this.host = document.createElement("div");
      this.host.className = "youtubi-layer";
      this.host.setAttribute("aria-hidden", "true");

      const position = getComputedStyle(this.playerElement).position;
      if (position === "static") {
        this.playerElement.classList.add("youtubi-player-host");
      }

      this.playerElement.appendChild(this.host);

      this.resizeObserver = new ResizeObserver(() => this.updateLayout());
      this.resizeObserver.observe(this.playerElement);
      this.updateLayout();
    }

    setSettings(settings) {
      this.settings = { ...this.settings, ...settings };

      if (this.host) {
        this.host.hidden = !this.settings.enabled;
      }

      this.updateLayout();

      if (this.settings.enabled) {
        this.start();
      } else {
        this.stop();
        this.clearActive();
      }
    }

    updateLayout() {
      if (!this.host) {
        return;
      }

      this.width = this.host.clientWidth || this.playerElement.clientWidth || 640;
      this.height = this.host.clientHeight || this.playerElement.clientHeight || 360;
      this.trackHeight = Math.max(24, Math.ceil(this.settings.fontSize * 1.55));

      const usableHeight = Math.max(this.trackHeight, this.height * this.settings.trackRatio);
      this.trackCount = Math.max(1, Math.floor(usableHeight / this.trackHeight));

      while (this.trackAvailableAt.length < this.trackCount) {
        this.trackAvailableAt.push(0);
      }

      if (this.trackAvailableAt.length > this.trackCount) {
        this.trackAvailableAt.length = this.trackCount;
      }
    }

    enqueue(text, meta = {}) {
      const normalized = cleanText(text);
      if (!normalized || !this.settings.enabled) {
        return;
      }

      this.queue.push({ text: normalized, meta, createdAt: performance.now() });

      if (this.queue.length > 240) {
        this.queue.splice(0, this.queue.length - 240);
      }

      this.start();
    }

    start() {
      if (this.timer || !this.settings.enabled) {
        return;
      }

      this.timer = window.setInterval(() => this.flush(), 260);
      this.flush();
    }

    stop() {
      if (!this.timer) {
        return;
      }

      window.clearInterval(this.timer);
      this.timer = 0;
    }

    flush() {
      if (!this.host || !this.settings.enabled || !this.queue.length) {
        return;
      }

      if (this.activeNodes.size >= this.settings.maxOnScreen) {
        return;
      }

      const track = this.pickTrack(performance.now());
      if (track === -1) {
        return;
      }

      const item = this.queue.shift();
      this.spawn(item, track);
    }

    pickTrack(now) {
      let bestTrack = -1;
      let bestTime = Number.POSITIVE_INFINITY;

      for (let index = 0; index < this.trackCount; index += 1) {
        const availableAt = this.trackAvailableAt[index] || 0;
        if (availableAt <= now) {
          return index;
        }

        if (availableAt < bestTime) {
          bestTime = availableAt;
          bestTrack = index;
        }
      }

      return bestTime - now < 350 ? bestTrack : -1;
    }

    spawn(item, track) {
      const node = document.createElement("div");
      node.className = "youtubi-item";
      node.textContent = item.text;
      node.style.fontSize = `${this.settings.fontSize}px`;
      node.style.opacity = `${this.settings.opacity}`;
      node.style.top = `${track * this.trackHeight}px`;

      this.host.appendChild(node);

      const textWidth = Math.ceil(node.getBoundingClientRect().width || 160);
      const startX = this.width + 24;
      const endX = -textWidth - 24;
      const distance = startX - endX;
      const duration = clamp((distance / this.settings.speed) * 1000, 4500, 22000);

      node.style.transform = `translate3d(${startX}px, 0, 0)`;

      const freeAfter = ((textWidth + 96) / this.settings.speed) * 1000;
      this.trackAvailableAt[track] = performance.now() + Math.max(450, freeAfter);

      const animation = node.animate(
        [
          { transform: `translate3d(${startX}px, 0, 0)` },
          { transform: `translate3d(${endX}px, 0, 0)` }
        ],
        {
          duration,
          easing: "linear",
          fill: "forwards"
        }
      );

      const remove = () => {
        this.activeNodes.delete(node);
        node.remove();
      };

      this.activeNodes.add(node);
      animation.onfinish = remove;
      animation.oncancel = remove;
    }

    clearActive() {
      for (const node of this.activeNodes) {
        const animations = node.getAnimations ? node.getAnimations() : [];
        animations.forEach((animation) => animation.cancel());
        node.remove();
      }

      this.activeNodes.clear();
      this.queue.length = 0;
      this.trackAvailableAt.fill(0);
    }

    dispose() {
      this.stop();

      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
      }

      this.clearActive();

      if (this.host) {
        this.host.remove();
      }

      this.host = null;
      this.playerElement = null;
    }
  }

  window.YoutubiDanmakuLayer = DanmakuLayer;
})();
