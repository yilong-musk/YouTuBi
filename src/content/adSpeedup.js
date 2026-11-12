(() => {
  const AD_PLAYBACK_RATE = 16;
  const TICK_INTERVAL_MS = 250;
  const SKIP_BUTTON_SELECTORS = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-container button"
  ];

  /**
   * 广告加速：广告期间把播放倍速拉到 16x、静音，并自动点「跳过」。
   * 只改播放层，不拦截任何网络请求，避免触发 YouTube 的反广告拦截。
   */
  class AdSpeedup {
    constructor({ player, video, settings }) {
      this.player = player;
      this.video = video;
      this.settings = settings || {};
      this.adShowing = false;
      this.tickTimer = 0;
      this.saved = null;
      this.boundRateChange = () => this.enforceRate();
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

    apply() {
      if (!this.adShowing || !this.isEnabled() || !this.video) {
        return;
      }

      if (!this.saved) {
        this.saved = {
          playbackRate: this.video.playbackRate,
          muted: this.video.muted,
          volume: this.video.volume
        };
        this.video.addEventListener("ratechange", this.boundRateChange);
      }

      this.enforceRate();
      this.video.muted = true;

      if (!this.tickTimer) {
        this.tickTimer = window.setInterval(() => this.tick(), TICK_INTERVAL_MS);
      }

      this.tick();
    }

    tick() {
      if (!this.adShowing || !this.isEnabled()) {
        this.stopTimer();
        return;
      }

      this.enforceRate();
      this.clickSkipButton();
    }

    enforceRate() {
      if (!this.adShowing || !this.video) {
        return;
      }

      if (Math.abs(this.video.playbackRate - AD_PLAYBACK_RATE) > 0.01) {
        try {
          this.video.playbackRate = AD_PLAYBACK_RATE;
        } catch (error) {
          // 某些环境下播放速率不可写，跳过即可
        }
      }
    }

    clickSkipButton() {
      if (!this.player || typeof this.player.querySelector !== "function") {
        return;
      }

      for (const selector of SKIP_BUTTON_SELECTORS) {
        const button = this.player.querySelector(selector);
        if (!button || typeof button.click !== "function") {
          continue;
        }

        if (button.offsetParent === null || button.disabled) {
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

    restore() {
      this.stopTimer();

      if (!this.saved) {
        return;
      }

      const { playbackRate, muted, volume } = this.saved;
      this.saved = null;

      if (!this.video) {
        return;
      }

      this.video.removeEventListener("ratechange", this.boundRateChange);

      try {
        this.video.playbackRate = playbackRate;
        this.video.muted = muted;
        this.video.volume = volume;
      } catch (error) {
        // 视频元素可能已被替换
      }
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
