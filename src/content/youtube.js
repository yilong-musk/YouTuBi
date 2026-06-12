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

  class YoutubiApp {
    constructor() {
      this.settings = window.YoutubiSettings.DEFAULT_SETTINGS;
      this.layer = null;
      this.commentSource = null;
      this.apiCommentSource = null;
      this.timelineScheduler = null;
      this.unsubscribeSettings = null;
      this.routeTimer = 0;
      this.retryTimer = 0;
      this.retryCount = 0;
      this.lastUrl = "";
      this.boundRouteChanged = () => this.scheduleRebuild(300);
    }

    async start() {
      this.settings = await window.YoutubiSettings.load();
      this.unsubscribeSettings = window.YoutubiSettings.subscribe((settings) => {
        this.settings = settings;

        if (this.layer) {
          this.layer.setSettings(settings);
        }
      });

      this.installRouteWatchers();
      this.scheduleRebuild(0);
    }

    installRouteWatchers() {
      window.addEventListener("yt-navigate-finish", this.boundRouteChanged);
      window.addEventListener("yt-page-data-updated", this.boundRouteChanged);
      window.addEventListener("popstate", this.boundRouteChanged);

      this.routeTimer = window.setInterval(() => {
        if (this.lastUrl !== location.href) {
          this.scheduleRebuild(250);
        }
      }, 1000);
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

      if (this.layer && this.layer.playerElement === player && this.lastUrl === currentUrl) {
        return;
      }

      this.disposePage();
      this.retryCount = 0;
      this.lastUrl = currentUrl;
      this.layer = new window.YoutubiDanmakuLayer(player, this.settings);
      this.timelineScheduler = new window.YoutubiTimelineScheduler({
        layer: this.layer,
        video
      });
      this.apiCommentSource = new window.YoutubiYouTubeCommentApiSource({
        videoId: this.getVideoId(),
        maxComments: this.settings.preloadLimit,
        onComment: (comment) => {
          if (this.timelineScheduler) {
            this.timelineScheduler.addComment(comment);
          }
        }
      });
      this.commentSource = new window.YoutubiCommentSource({
        onComment: (comment) => {
          if (this.timelineScheduler) {
            this.timelineScheduler.addComment(comment);
          }
        }
      });
      this.apiCommentSource.start();
      this.commentSource.start();
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

    disposePage() {
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
    }

    dispose() {
      window.clearInterval(this.routeTimer);
      window.clearTimeout(this.retryTimer);
      window.removeEventListener("yt-navigate-finish", this.boundRouteChanged);
      window.removeEventListener("yt-page-data-updated", this.boundRouteChanged);
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
