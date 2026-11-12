(() => {
  const AD_PLAYBACK_RATE = 16;
  const TICK_INTERVAL_MS = 250;
  const SKIP_BUTTON_SELECTORS = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-container button"
  ];
  const MEDIA_EVENTS = ["loadedmetadata", "durationchange", "play", "playing", "ratechange"];

  /**
   * 广告加速：广告期间把播放倍速拉到 16x、静音，并自动点「跳过」。
   * 只改播放层，不拦截任何网络请求，避免触发 YouTube 的反广告拦截。
   *
   * 广告连播（ad pod）时 YouTube 可能换 <video> 元素或把倍速重置为 1，
   * 所以不能只记住入场时那一个 video——每次 tick 都重新解析当前在播的元素。
   */
  class AdSpeedup {
    constructor({ player, video, settings }) {
      this.player = player;
      this.video = video;
      this.settings = settings || {};
      this.adShowing = false;
      this.tickTimer = 0;
      this.saved = new Map();
      this.mediaBound = false;
      this.boundReapply = () => this.reapply();
    }

    isEnabled() {
      return Boolean(this.settings && this.settings.adSpeedup);
    }

    setSettings(settings) {
      this.settings = settings || {};
      if (!this.isEnabled() && this.adShowing) {
        this.restore();
      }
    }

    setAdShowing(active) {
      const next = Boolean(active);
      if (this.adShowing === next) {
        return;
      }

      this.adShowing = next;

      if (next) {
        this.apply();
        return;
      }

      this.restore();
    }

    candidates() {
      const list = [];

      if (this.player && typeof this.player.querySelectorAll === "function") {
        for (const node of this.player.querySelectorAll(".video-ads video")) {
          list.push(node);
        }

        const main = this.player.querySelector("video.html5-main-video, video");
        if (main) {
          list.push(main);
        }
      }

      if (!list.length && this.video) {
        list.push(this.video);
      }

      return Array.from(new Set(list));
    }

    apply() {
      if (!this.adShowing || !this.isEnabled()) {
        return;
      }

      this.bindMediaEvents();
      this.reapply();

      if (!this.tickTimer) {
        this.tickTimer = window.setInterval(() => this.tick(), TICK_INTERVAL_MS);
      }

      this.tick();
    }

    reapply() {
      if (!this.adShowing || !this.isEnabled()) {
        return;
      }

      for (const video of this.candidates()) {
        if (!this.saved.has(video)) {
          this.saved.set(video, {
            playbackRate: video.playbackRate,
            muted: video.muted,
            volume: video.volume
          });
        }

        this.enforceRate(video);

        if (!video.muted) {
          video.muted = true;
        }
      }
    }

    tick() {
      if (!this.adShowing || !this.isEnabled()) {
        this.stopTimer();
        return;
      }

      this.reapply();
      this.clickSkipButton();
    }

    enforceRate(video) {
      if (!video) {
        return;
      }

      if (Math.abs(video.playbackRate - AD_PLAYBACK_RATE) > 0.01) {
        try {
          video.playbackRate = AD_PLAYBACK_RATE;
        } catch (error) {
          // 某些环境下播放速率不可写，跳过即可
        }
      }
    }

    clickSkipButton() {
      if (!this.player || typeof this.player.querySelector !== "function") {
        return;
      }

      const scopes = [];
      const adModule = this.player.querySelector(".video-ads");
      if (adModule && typeof adModule.querySelector === "function") {
        scopes.push(adModule);
      }
      scopes.push(this.player);

      for (const scope of scopes) {
        for (const selector of SKIP_BUTTON_SELECTORS) {
          const button = scope.querySelector(selector);
          if (!button || typeof button.click !== "function") {
            continue;
          }

          const rects = typeof button.getClientRects === "function" ? button.getClientRects() : null;
          const visible = rects ? rects.length > 0 : button.offsetParent !== null;
          if (!visible || button.disabled) {
            continue;
          }

          try {
            button.click();
          } catch (error) {
            // 按钮可能已随广告结束被移除
          }
          return;
        }
      }
    }

    bindMediaEvents() {
      if (this.mediaBound || !this.player || typeof this.player.addEventListener !== "function") {
        return;
      }

      this.mediaBound = true;
      for (const event of MEDIA_EVENTS) {
        this.player.addEventListener(event, this.boundReapply, true);
      }
    }

    unbindMediaEvents() {
      if (!this.mediaBound || !this.player || typeof this.player.removeEventListener !== "function") {
        return;
      }

      this.mediaBound = false;
      for (const event of MEDIA_EVENTS) {
        this.player.removeEventListener(event, this.boundReapply, true);
      }
    }

    restore() {
      this.stopTimer();
      this.unbindMediaEvents();

      for (const [video, state] of this.saved) {
        try {
          video.playbackRate = state.playbackRate;
          video.muted = state.muted;
          video.volume = state.volume;
        } catch (error) {
          // 视频元素可能已被替换
        }
      }

      this.saved.clear();
    }

    stopTimer() {
      if (this.tickTimer) {
        window.clearInterval(this.tickTimer);
      }
      this.tickTimer = 0;
    }

    dispose() {
      this.adShowing = false;
      this.restore();
      this.player = null;
      this.video = null;
      this.settings = null;
    }
  }

  window.YoutubiAdSpeedup = AdSpeedup;
})();