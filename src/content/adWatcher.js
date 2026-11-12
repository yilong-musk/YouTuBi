(() => {
  const AD_CLASS_NAMES = ["ad-showing", "ad-interrupting"];
  const AD_OVERLAY_SELECTOR = [
    ".ytp-ad-player-overlay",
    ".ytp-ad-player-overlay-layout",
    ".ytp-ad-module .ytp-ad-overlay-container",
    ".ytp-ad-image-overlay"
  ].join(",");
  const POLL_INTERVAL_MS = 250;

  /**
   * 广告检测：YouTube 广告复用同一个 <video> 元素，广告期间
   * `video.duration`/`video.currentTime` 会变成广告的时长与进度，
   * 直接驱动弹幕排期会被压缩成「广告时长内全部放完」。
   * 这里只做一件事：稳定地报告「现在是否处于广告」。
   */
  class AdWatcher {
    constructor({ player, video, onChange, pollIntervalMs = POLL_INTERVAL_MS }) {
      this.player = player;
      this.video = video;
      this.onChange = onChange;
      this.pollIntervalMs = pollIntervalMs;
      this.adShowing = false;
      this.observer = null;
      this.pollTimer = 0;
      this.boundEvaluate = () => this.evaluate();
    }

    isAdShowing() {
      if (!this.player) {
        return false;
      }

      if (AD_CLASS_NAMES.some((name) => this.player.classList && this.player.classList.contains(name))) {
        return true;
      }

      return Boolean(this.player.querySelector && this.player.querySelector(AD_OVERLAY_SELECTOR));
    }

    start() {
      if (!this.player || this.observer || this.pollTimer) {
        return;
      }

      if (typeof window.MutationObserver === "function" && this.player.addEventListener) {
        this.observer = new window.MutationObserver(this.boundEvaluate);
        this.observer.observe(this.player, { attributes: true, attributeFilter: ["class"] });
      }

      this.pollTimer = window.setInterval(this.boundEvaluate, this.pollIntervalMs);
      this.evaluate();
    }

    evaluate() {
      const showing = this.isAdShowing();
      if (showing === this.adShowing) {
        return;
      }

      this.adShowing = showing;
      if (this.onChange) {
        this.onChange(showing);
      }
    }

    dispose() {
      if (this.observer) {
        this.observer.disconnect();
      }

      if (this.pollTimer) {
        window.clearInterval(this.pollTimer);
      }

      this.observer = null;
      this.pollTimer = 0;
      this.player = null;
      this.video = null;
      this.onChange = null;
    }
  }

  window.YoutubiAdWatcher = AdWatcher;
})();
