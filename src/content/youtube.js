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

  const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const isTrueFlag = (value) => value === true || value === "true" || value === 1 || value === "1";
  const MODE_DETECTION_RETRY_MS = 250;
  const NORMAL_MODE_DETECTION_RETRY_COUNT = 20;
  const LIVE_CHAT_RETRY_LIMIT = 4;
  const LIVE_CHAT_RETRY_BASE_MS = 2000;
  const LIVE_CHAT_RETRY_MAX_MS = 30000;
  const LIVE_REPLAY_PENDING_CHAT_RETRY_COUNT = 4;

  class YoutubiApp {
    constructor() {
      this.settings = window.YoutubiSettings.DEFAULT_SETTINGS;
      this.layer = null;
      this.commentSource = null;
      this.apiCommentSource = null;
      this.liveChatSource = null;
      this.timelineScheduler = null;
      this.realtimeScheduler = null;
      this.liveReplayLoadState = null;
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
      this.modeRetryCount = 0;
      this.modeRetryVideoId = "";
      this.lastUrl = "";
      this.activeVideoId = "";
      this.activeMode = "normal";
      this.debugState = null;
      this.liveChatRetryState = new Map();
      this.boundRouteChanged = () => this.handleRouteChanged();
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

    handleRouteChanged() {
      const currentVideoId = location.pathname === "/watch" ? this.getVideoId() : "";
      if (this.activeVideoId && (!currentVideoId || currentVideoId !== this.activeVideoId)) {
        this.disposePage();
      }

      this.scheduleRebuild(300);
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

      if (!this.activeVideoId || videoId !== this.activeVideoId || !this.layer || !this.getActiveScheduler()) {
        return true;
      }

      if (!this.layer.host || !this.layer.host.isConnected) {
        return true;
      }

      if (!this.layer.playerElement || !this.layer.playerElement.isConnected) {
        return true;
      }

      if (this.shouldRetryMountedLiveChat()) {
        return true;
      }

      const player = this.findPlayer();
      if (player && player !== this.layer.playerElement) {
        return true;
      }

      if (this.shouldRetryMountedPlaybackMode(player, null, videoId)) {
        return true;
      }

      const video = player && this.findVideo(player);
      const scheduler = this.getActiveScheduler();
      return Boolean(video && scheduler.video && video !== scheduler.video);
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

      const videoId = this.getVideoId();
      if (!videoId) {
        this.lastUrl = currentUrl;
        this.disposePage();
        return;
      }

      if (this.activeVideoId && videoId !== this.activeVideoId) {
        this.disposePage();
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

      const playerVideoId = this.getPlayerVideoId(player);
      if (playerVideoId && playerVideoId !== videoId) {
        this.retryCount += 1;

        if (this.retryCount <= 40) {
          this.scheduleRebuild(250);
        }

        return;
      }

      const activeScheduler = this.getActiveScheduler();
      if (
        this.layer &&
        activeScheduler &&
        this.layer.host &&
        this.layer.host.isConnected &&
        this.layer.playerElement === player &&
        activeScheduler.video === video &&
        this.lastUrl === currentUrl &&
        !this.shouldRetryMountedLiveChat() &&
        !this.shouldRetryMountedPlaybackMode(player, video, videoId)
      ) {
        return;
      }

      this.disposePage();
      const playbackMode = this.detectPlaybackMode(player, video, videoId);
      if (this.shouldDelayNormalMode(playbackMode)) {
        if (this.modeRetryVideoId !== videoId) {
          this.modeRetryVideoId = videoId;
          this.modeRetryCount = 0;
        }

        this.modeRetryCount += 1;
        if (this.modeRetryCount <= NORMAL_MODE_DETECTION_RETRY_COUNT) {
          this.scheduleRebuild(MODE_DETECTION_RETRY_MS);
          return;
        }

        playbackMode.modeReason = "normal-detection-timeout";
      }

      this.retryCount = 0;
      this.modeRetryCount = 0;
      this.modeRetryVideoId = "";
      this.lastUrl = currentUrl;
      this.activeVideoId = videoId;
      this.activeMode = playbackMode.mode;
      this.resetDebugState(videoId, playbackMode);
      this.layer = new window.YoutubiDanmakuLayer(player, this.settings, {
        onTimingChange: (event) => {
          const scheduler = this.getActiveScheduler();
          if (scheduler && typeof scheduler.handleLayoutTimingChange === "function") {
            scheduler.handleLayoutTimingChange(event.reason);
          }
        },
        onReplyRequest: (comment) => {
          if (!this.isCurrentVideo(videoId)) {
            return Promise.resolve({ status: "stale", replies: [] });
          }

          return this.loadRepliesForComment(videoId, comment);
        }
      });
      if (playbackMode.mode === "live") {
        this.startLiveChat(videoId, video, playbackMode);
      } else if (playbackMode.mode === "liveReplay") {
        this.startLiveReplay(videoId, video, playbackMode);
      } else {
        this.startCommentTimeline(videoId, video);
      }
      this.scheduleToggleMount(0);
    }

    startCommentTimeline(videoId, video) {
      this.timelineScheduler = new window.YoutubiTimelineScheduler({
        layer: this.layer,
        video,
        autoRelease: false,
        onStateChange: (updates) => this.updateDebugState(updates)
      });
      this.updateDebugState({ status: "mounted", mode: "normal" });
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
    }

    startLiveChat(videoId, video, playbackMode) {
      this.realtimeScheduler = new window.YoutubiRealtimeScheduler({
        layer: this.layer,
        video,
        onStateChange: (updates) => this.updateDebugState(updates)
      });
      this.updateDebugState({ status: "live-mounted", mode: "live" });
      if (!playbackMode.continuation) {
        this.updateDebugState({
          liveChatStatus: "continuation-pending",
          liveChatError: ""
        });
      }

      this.liveChatSource = new window.YoutubiYouTubeLiveChatSource({
        videoId,
        mode: "live",
        continuation: playbackMode.continuation,
        maxItems: this.settings.preloadLimit,
        onChat: (chat) => {
          if (!this.isCurrentVideo(videoId) || this.activeMode !== "live") {
            return;
          }

          this.recordComment("liveChat");
          if (this.realtimeScheduler) {
            this.realtimeScheduler.addComment(chat);
            this.updateDebugState({ status: "live-chat" });
          }
        },
        onStatus: (status) => {
          if (!this.isCurrentVideo(videoId) || this.activeMode !== "live") {
            return;
          }

          this.updateLiveChatStatus(status);
        }
      });
      this.liveChatSource.start();
    }

    startLiveReplay(videoId, video, playbackMode) {
      this.timelineScheduler = new window.YoutubiTimelineScheduler({
        layer: this.layer,
        video,
        autoRelease: false,
        suppressInitialBacklog: true,
        onStateChange: (updates) => this.updateDebugState(updates)
      });
      this.updateDebugState({ status: "live-replay-mounted", mode: "liveReplay" });
      this.liveReplayLoadState = {
        commentsDone: false,
        chatDone: false,
        completed: false
      };

      this.apiCommentSource = new window.YoutubiYouTubeCommentApiSource({
        videoId,
        maxComments: this.settings.preloadLimit,
        onComment: (comment) => {
          if (!this.isCurrentVideo(videoId) || this.activeMode !== "liveReplay") {
            return;
          }

          this.recordComment("api");
          if (this.timelineScheduler) {
            this.timelineScheduler.addComment(comment);
            this.updateDebugState({ status: "live-replay-comment" });
          }
        },
        onStatus: (status) => {
          if (!this.isCurrentVideo(videoId) || this.activeMode !== "liveReplay") {
            return;
          }

          this.updateDebugState({
            apiStatus: status.status,
            apiLoaded: status.loadedCount,
            apiError: status.message || ""
          });

          if (this.isApiSuccessTerminalStatus(status.status) || status.status === "failed" || status.status === "config-missing") {
            this.markLiveReplaySourceDone("comments", status.status);
          }
        }
      });
      this.apiCommentSource.start();

      if (!playbackMode.continuation) {
        this.updateDebugState({
          liveChatStatus: "continuation-pending",
          liveChatError: ""
        });
      }

      this.liveChatSource = new window.YoutubiYouTubeLiveChatSource({
        videoId,
        mode: "liveReplay",
        continuation: playbackMode.continuation,
        initialContinuationRetryCount: playbackMode.continuation ? undefined : LIVE_REPLAY_PENDING_CHAT_RETRY_COUNT,
        maxItems: this.settings.preloadLimit,
        video,
        onChat: (chat) => {
          if (!this.isCurrentVideo(videoId) || this.activeMode !== "liveReplay") {
            return;
          }

          this.recordComment("liveChat");
          if (this.timelineScheduler) {
            this.timelineScheduler.addComment(chat);
            this.updateDebugState({ status: "live-replay-chat" });
          }
        },
        onStatus: (status) => {
          if (!this.isCurrentVideo(videoId) || this.activeMode !== "liveReplay") {
            return;
          }

          this.updateLiveChatStatus(status);
          if (status.status === "replay-ready") {
            this.markLiveReplaySourceDone("chat", status.status);
          }
          if (this.isLiveChatTerminalStatus(status.status)) {
            this.markLiveReplaySourceDone("chat", status.status);
          }
        }
      });
      this.liveChatSource.start();
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

    getPlayerVideoId(player) {
      const candidates = [
        () => player && typeof player.getVideoData === "function" ? player.getVideoData().video_id : "",
        () => player && player.getAttribute ? player.getAttribute("data-video-id") : "",
        () => {
          const watchFlexy = document.querySelector("ytd-watch-flexy[video-id]");
          return watchFlexy ? watchFlexy.getAttribute("video-id") : "";
        }
      ];

      for (const read of candidates) {
        try {
          const value = read();
          if (value) {
            return String(value);
          }
        } catch (error) {
          // Some YouTube player methods are unavailable during SPA transitions.
        }
      }

      return "";
    }

    getActiveScheduler() {
      return this.timelineScheduler || this.realtimeScheduler;
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

    detectPlaybackMode(player, video, videoId) {
      const innertube = window.YoutubiInnertube;
      const playerData = this.getPlayerVideoData(player);
      const playerVideoId = this.getVideoDataVideoId(playerData);
      const playerResponseFromPlayer = this.getPlayerResponseFromPlayer(player);
      const rawPlayerResponse = playerResponseFromPlayer ||
        (innertube && innertube.extractPlayerResponse ? innertube.extractPlayerResponse() : null);
      const rawPlayerResponseVideoId = this.getPlayerResponseVideoId(rawPlayerResponse);
      const playerResponse = rawPlayerResponseVideoId === videoId ? rawPlayerResponse : null;
      const rawInitialData = innertube && innertube.extractInitialData ? innertube.extractInitialData() : null;
      const initialDataEvidence = this.getInitialDataVideoEvidence(rawInitialData, videoId);
      const initialData = initialDataEvidence.hasCurrentVideo ? rawInitialData : null;
      const currentPageData = this.getCurrentPageData(videoId);
      const domLiveDetails = this.getDomLiveDetails(player, videoId);
      const liveDetails = this.getLiveDetails(playerResponse, playerData, video, domLiveDetails);
      const liveContinuation = this.findChatContinuation(currentPageData, { replay: false }) ||
        this.findChatContinuation(playerResponse, { replay: false });
      const replayContinuation = this.findChatContinuation(currentPageData, { replay: true }) ||
        this.findChatContinuation(playerResponse, { replay: true });
      const diagnostics = {
        playerVideoId,
        playerResponseSource: playerResponseFromPlayer ? "player" : "page",
        playerResponseVideoId: rawPlayerResponseVideoId,
        playerResponseTrusted: Boolean(playerResponse),
        initialDataTrusted: Boolean(initialData),
        initialDataHasCurrentVideo: initialDataEvidence.hasCurrentVideo,
        initialDataHasOtherVideo: initialDataEvidence.hasOtherVideo,
        currentPageDataTrusted: currentPageData.length > 0,
        domLiveSource: domLiveDetails.source,
        domLiveChatType: domLiveDetails.chatType,
        domLiveChatSrc: domLiveDetails.chatSrc,
        domWatchFlexyLive: domLiveDetails.watchFlexyLive,
        domPlayerLive: domLiveDetails.playerLive,
        hasExplicitLiveStatus: liveDetails.hasExplicitLiveStatus,
        hasLiveContinuation: Boolean(liveContinuation && liveContinuation.token),
        hasReplayContinuation: Boolean(replayContinuation && replayContinuation.token)
      };

      if (liveDetails.isLiveNow) {
        return {
          mode: "live",
          modeReason: "player-live-now",
          diagnostics,
          liveDetails,
          continuation: liveContinuation && liveContinuation.token,
          continuationInfo: liveContinuation
        };
      }

      const replayInfo = replayContinuation || (liveDetails.isLiveReplay ? liveContinuation : null);
      if (replayInfo && replayInfo.token) {
        return {
          mode: "liveReplay",
          modeReason: replayContinuation ? "live-replay-continuation" : "ended-live-continuation",
          diagnostics,
          liveDetails,
          continuation: replayInfo.token,
          continuationInfo: replayInfo
        };
      }

      if (liveDetails.isLiveReplay) {
        return {
          mode: "liveReplay",
          modeReason: "ended-live-metadata",
          diagnostics,
          liveDetails,
          continuation: "",
          continuationInfo: null
        };
      }

      if (liveContinuation && liveContinuation.token) {
        return {
          mode: "live",
          modeReason: "live-continuation",
          diagnostics,
          liveDetails: {
            ...liveDetails,
            isLiveNow: true,
            isLiveContent: true
          },
          continuation: liveContinuation.token,
          continuationInfo: liveContinuation
        };
      }

      return {
        mode: "normal",
        modeReason: "normal-video",
        diagnostics,
        liveDetails,
        continuation: "",
        continuationInfo: null
      };
    }

    shouldDelayNormalMode(playbackMode) {
      if (!playbackMode || playbackMode.mode !== "normal") {
        return false;
      }

      const diagnostics = playbackMode.diagnostics || {};
      return !diagnostics.hasExplicitLiveStatus &&
        !diagnostics.hasLiveContinuation &&
        !diagnostics.hasReplayContinuation;
    }

    shouldRetryMountedLiveChat() {
      if (
        this.activeMode !== "live" ||
        !this.debugState ||
        this.debugState.liveChatStatus !== "continuation-missing"
      ) {
        return false;
      }

      const state = this.liveChatRetryState.get(this.activeVideoId);
      if (!state || state.attempts >= LIVE_CHAT_RETRY_LIMIT) {
        return false;
      }

      return Date.now() >= state.nextRetryAt;
    }

    recordLiveChatContinuationMissing() {
      if (!this.activeVideoId || this.activeMode !== "live") {
        return;
      }

      const previous = this.liveChatRetryState.get(this.activeVideoId) || {
        attempts: 0,
        nextRetryAt: 0
      };
      const attempts = previous.attempts + 1;
      const delay = Math.min(
        LIVE_CHAT_RETRY_MAX_MS,
        LIVE_CHAT_RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1))
      );

      this.liveChatRetryState.set(this.activeVideoId, {
        attempts,
        nextRetryAt: Date.now() + delay
      });
      this.trimLiveChatRetryState();
    }

    clearLiveChatContinuationRetry() {
      if (this.activeVideoId) {
        this.liveChatRetryState.delete(this.activeVideoId);
      }
    }

    trimLiveChatRetryState() {
      if (this.liveChatRetryState.size <= 12) {
        return;
      }

      const firstKey = this.liveChatRetryState.keys().next().value;
      if (firstKey) {
        this.liveChatRetryState.delete(firstKey);
      }
    }

    shouldRetryMountedPlaybackMode(player, video, videoId) {
      if (!this.activeVideoId || this.activeVideoId !== videoId || this.activeMode !== "normal") {
        return false;
      }

      const domLiveDetails = this.getDomLiveDetails(player, videoId);
      if (domLiveDetails.isLiveContent) {
        return true;
      }

      const playerData = this.getPlayerVideoData(player);
      const playerResponse = this.getPlayerResponseFromPlayer(player);
      const liveDetails = this.getLiveDetails(playerResponse, playerData, video, domLiveDetails);
      return Boolean(liveDetails.isLiveContent || liveDetails.isLiveNow || liveDetails.isLiveReplay);
    }

    getPlayerVideoData(player) {
      try {
        return player && typeof player.getVideoData === "function" ? player.getVideoData() || {} : {};
      } catch (error) {
        return {};
      }
    }

    getPlayerResponseFromPlayer(player) {
      const candidates = [
        () => player && typeof player.getPlayerResponse === "function" ? player.getPlayerResponse() : null,
        () => {
          const data = this.getPlayerVideoData(player);
          return data && (data.player_response || data.playerResponse) || null;
        }
      ];

      for (const read of candidates) {
        try {
          const value = read();
          if (!value) {
            continue;
          }

          if (typeof value === "string") {
            return JSON.parse(value);
          }

          if (typeof value === "object") {
            return value;
          }
        } catch (error) {
          // Player APIs can be unavailable or partially initialized during navigation.
        }
      }

      return null;
    }

    getVideoDataVideoId(playerData) {
      return playerData && (playerData.video_id || playerData.videoId)
        ? String(playerData.video_id || playerData.videoId)
        : "";
    }

    getLiveDetails(playerResponse, playerData, video, domLiveDetails = {}) {
      const innertube = window.YoutubiInnertube;
      const getNested = innertube && innertube.getNested;
      const videoDetails = getNested ? getNested(playerResponse, ["videoDetails"]) || {} : {};
      const liveBroadcastDetails = getNested
        ? getNested(playerResponse, ["microformat", "playerMicroformatRenderer", "liveBroadcastDetails"]) || {}
        : {};
      const liveStreamability = getNested
        ? getNested(playerResponse, ["playabilityStatus", "liveStreamability"])
        : null;
      const duration = video && video.duration;
      const durationLooksLive = duration != null && !isFiniteNumber(duration);
      const hasEnded = Boolean(liveBroadcastDetails.endTimestamp);
      const hasExplicitLiveStatus = Boolean(
        domLiveDetails.isLiveContent ||
        liveStreamability ||
        liveBroadcastDetails.startTimestamp ||
        liveBroadcastDetails.endTimestamp ||
        videoDetails.isLive !== undefined ||
        videoDetails.isLiveContent !== undefined ||
        playerData.isLive !== undefined ||
        playerData.isLiveContent !== undefined ||
        liveBroadcastDetails.isLiveNow !== undefined
      );
      const isLiveNow = Boolean(
        isTrueFlag(videoDetails.isLive) ||
        isTrueFlag(playerData.isLive) ||
        isTrueFlag(liveBroadcastDetails.isLiveNow) ||
        domLiveDetails.isLiveNow ||
        (liveStreamability && durationLooksLive)
      );
      const isLiveContent = Boolean(
        isLiveNow ||
        isTrueFlag(videoDetails.isLiveContent) ||
        isTrueFlag(playerData.isLiveContent) ||
        domLiveDetails.isLiveContent ||
        liveBroadcastDetails.startTimestamp ||
        hasEnded
      );
      const isLiveReplay = Boolean(domLiveDetails.isLiveReplay || (isLiveContent && !isLiveNow && hasEnded));

      return {
        isLiveNow,
        isLiveContent,
        isLiveReplay,
        hasEnded,
        startTimestamp: liveBroadcastDetails.startTimestamp || "",
        endTimestamp: liveBroadcastDetails.endTimestamp || "",
        durationLooksLive,
        hasExplicitLiveStatus
      };
    }

    findChatContinuation(data, options = {}) {
      const innertube = window.YoutubiInnertube;
      if (!data || !innertube || !innertube.findLiveChatContinuation) {
        return null;
      }

      try {
        return innertube.findLiveChatContinuation(data, options);
      } catch (error) {
        return null;
      }
    }

    getPlayerResponseVideoId(playerResponse) {
      const innertube = window.YoutubiInnertube;
      const getNested = innertube && innertube.getNested;
      return getNested ? getNested(playerResponse, ["videoDetails", "videoId"]) || "" : "";
    }

    getInitialDataVideoEvidence(initialData, videoId) {
      const innertube = window.YoutubiInnertube;
      const evidence = {
        hasCurrentVideo: false,
        hasOtherVideo: false
      };

      if (!initialData || !videoId || !innertube || !innertube.walk) {
        return evidence;
      }

      innertube.walk(initialData, (node) => {
        const candidate = node.watchEndpoint && node.watchEndpoint.videoId;
        if (!candidate) {
          return undefined;
        }

        if (candidate === videoId) {
          evidence.hasCurrentVideo = true;
          return false;
        }

        evidence.hasOtherVideo = true;
        return undefined;
      });

      return evidence;
    }

    getCurrentPageData(videoId) {
      const data = [];
      const watchFlexy = this.getCurrentWatchFlexy(videoId);
      const nodes = [];
      const properties = [
        "data",
        "playerData",
        "playerResponse",
        "watchNextResponse",
        "response"
      ];

      if (watchFlexy) {
        nodes.push(
          watchFlexy,
          ...Array.from(watchFlexy.querySelectorAll([
            "ytd-watch-metadata",
            "ytd-video-primary-info-renderer",
            "ytd-live-chat-frame"
          ].join(",")))
        );
      }

      nodes.forEach((node) => {
        properties.forEach((property) => {
          try {
            const value = node[property];
            if (value && typeof value === "object" && !data.includes(value)) {
              data.push(value);
            }
          } catch (error) {
            // YouTube custom element properties can be temporarily unavailable during navigation.
          }
        });
      });

      return data;
    }

    getDomLiveDetails(player, videoId) {
      const chatFrame = this.getLiveChatFrameInfo(videoId);
      const watchFlexyLive = this.hasLiveWatchFlexy(videoId);
      const playerLive = this.hasVisibleLivePlayerUi(player);
      const isLiveReplay = chatFrame.type === "replay";
      const isLiveNow = chatFrame.type === "live" || watchFlexyLive || playerLive;
      const sources = [];

      if (chatFrame.type) {
        sources.push(chatFrame.source);
      }
      if (watchFlexyLive) {
        sources.push("watch-flexy");
      }
      if (playerLive) {
        sources.push("player-ui");
      }

      return {
        isLiveNow,
        isLiveReplay,
        isLiveContent: isLiveNow || isLiveReplay,
        source: sources.join(","),
        chatType: chatFrame.type,
        chatSrc: chatFrame.src,
        watchFlexyLive,
        playerLive
      };
    }

    getCurrentWatchFlexy(videoId) {
      return Array.from(document.querySelectorAll("ytd-watch-flexy"))
        .find((node) => node.getAttribute("video-id") === videoId) || null;
    }

    hasLiveWatchFlexy(videoId) {
      const watchFlexy = this.getCurrentWatchFlexy(videoId);
      if (!watchFlexy) {
        return false;
      }

      return [
        "is-live",
        "is-live-now",
        "is-live-stream",
        "live"
      ].some((attribute) => watchFlexy.hasAttribute(attribute));
    }

    hasVisibleLivePlayerUi(player) {
      if (!player || typeof player.querySelectorAll !== "function") {
        return false;
      }

      return Array.from(player.querySelectorAll(".ytp-live, .ytp-live-badge, .ytp-time-live"))
        .some((node) => this.isVisibleElement(node));
    }

    getLiveChatFrameInfo(videoId) {
      const frames = Array.from(document.querySelectorAll(
        "iframe#chatframe, ytd-live-chat-frame iframe, iframe[src*='/live_chat']"
      ));

      for (const frame of frames) {
        const src = frame.getAttribute("src") || "";
        if (!src || !this.isLiveChatFrameForVideo(frame, src, videoId)) {
          continue;
        }

        try {
          const parsed = new URL(src, location.href);
          if (parsed.pathname.includes("live_chat_replay")) {
            return { type: "replay", source: "chatframe", src };
          }

          if (parsed.pathname.includes("live_chat")) {
            return { type: "live", source: "chatframe", src };
          }
        } catch (error) {
          if (src.includes("live_chat_replay")) {
            return { type: "replay", source: "chatframe", src };
          }

          if (src.includes("live_chat")) {
            return { type: "live", source: "chatframe", src };
          }
        }
      }

      return { type: "", source: "", src: "" };
    }

    isLiveChatFrameForVideo(frame, src, videoId) {
      try {
        const parsed = new URL(src, location.href);
        const frameVideoId = parsed.searchParams.get("v") || "";
        if (frameVideoId) {
          return frameVideoId === videoId;
        }
      } catch (error) {
        // Fall back to the enclosing watch page below.
      }

      const frameWatchFlexy = frame.closest && frame.closest("ytd-watch-flexy");
      if (frameWatchFlexy && frameWatchFlexy.getAttribute("video-id")) {
        return frameWatchFlexy.getAttribute("video-id") === videoId;
      }

      const watchFlexy = this.getCurrentWatchFlexy(videoId);
      return Boolean(watchFlexy && watchFlexy.contains(frame));
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

    isLiveChatTerminalStatus(status) {
      return (
        status === "done" ||
        status === "max-items" ||
        status === "continuation-missing" ||
        status === "failed" ||
        status === "config-missing"
      );
    }

    markLiveReplaySourceDone(source, reason) {
      if (!this.liveReplayLoadState || this.liveReplayLoadState.completed) {
        return;
      }

      if (source === "comments") {
        this.liveReplayLoadState.commentsDone = true;
      } else if (source === "chat") {
        this.liveReplayLoadState.chatDone = true;
      }

      this.updateDebugState({
        status: `live-replay-${source}-done`,
        liveReplayCommentsDone: this.liveReplayLoadState.commentsDone,
        liveReplayChatDone: this.liveReplayLoadState.chatDone
      });

      if (!this.liveReplayLoadState.commentsDone || !this.liveReplayLoadState.chatDone) {
        return;
      }

      this.liveReplayLoadState.completed = true;
      if (this.timelineScheduler) {
        this.timelineScheduler.completeInitialLoad(`live-replay:${reason || "done"}`);
      }
    }

    updateLiveChatStatus(status = {}) {
      if (status.status === "continuation-missing") {
        this.recordLiveChatContinuationMissing();
      } else if (
        status.status === "ready" ||
        status.status === "baseline" ||
        status.status === "polling" ||
        status.status === "replay-ready" ||
        status.status === "replay-buffer"
      ) {
        this.clearLiveChatContinuationRetry();
      }

      const retryState = this.activeVideoId ? this.liveChatRetryState.get(this.activeVideoId) : null;
      this.updateDebugState({
        liveChatStatus: status.status || "idle",
        liveChatLoaded: status.loadedCount || 0,
        liveChatError: status.message || "",
        liveChatContinuation: status.continuation || this.debugState && this.debugState.liveChatContinuation || "",
        liveChatContinuationSource:
          status.continuationSource || this.debugState && this.debugState.liveChatContinuationSource || "",
        liveChatRetryCount: retryState ? retryState.attempts : 0
      });
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

    resetDebugState(videoId, playbackMode = {}) {
      const diagnostics = playbackMode.diagnostics || {};
      const liveDetails = playbackMode.liveDetails || {};
      this.debugState = {
        status: "starting",
        videoId,
        mode: playbackMode.mode || "normal",
        modeReason: playbackMode.modeReason || "",
        playerVideoId: diagnostics.playerVideoId || "",
        playerResponseSource: diagnostics.playerResponseSource || "",
        playerResponseVideoId: diagnostics.playerResponseVideoId || "",
        playerResponseTrusted: Boolean(diagnostics.playerResponseTrusted),
        initialDataTrusted: Boolean(diagnostics.initialDataTrusted),
        initialDataHasCurrentVideo: Boolean(diagnostics.initialDataHasCurrentVideo),
        initialDataHasOtherVideo: Boolean(diagnostics.initialDataHasOtherVideo),
        currentPageDataTrusted: Boolean(diagnostics.currentPageDataTrusted),
        domLiveSource: diagnostics.domLiveSource || "",
        domLiveChatType: diagnostics.domLiveChatType || "",
        domWatchFlexyLive: Boolean(diagnostics.domWatchFlexyLive),
        domPlayerLive: Boolean(diagnostics.domPlayerLive),
        isLiveNow: Boolean(liveDetails.isLiveNow),
        isLiveContent: Boolean(liveDetails.isLiveContent),
        isLiveReplay: Boolean(liveDetails.isLiveReplay),
        liveHasEnded: Boolean(liveDetails.hasEnded),
        hasExplicitLiveStatus: Boolean(liveDetails.hasExplicitLiveStatus),
        liveStartTimestamp: liveDetails.startTimestamp || "",
        liveEndTimestamp: liveDetails.endTimestamp || "",
        liveChatStatus: "idle",
        liveChatLoaded: 0,
        liveChatQueued: 0,
        liveChatDropped: 0,
        liveChatError: "",
        liveChatContinuation: playbackMode.continuation ? "found" : "",
        liveChatContinuationSource: playbackMode.continuationInfo && playbackMode.continuationInfo.source || "",
        liveChatRetryCount: 0,
        hasLiveContinuation: Boolean(diagnostics.hasLiveContinuation),
        hasReplayContinuation: Boolean(diagnostics.hasReplayContinuation),
        liveReplayCommentsDone: false,
        liveReplayChatDone: false,
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
      } else if (source === "liveChat") {
        this.debugState.liveChatLoaded += 1;
      }
    }

    updateDebugState(updates = {}) {
      if (!this.debugState) {
        return;
      }

      const scheduler = this.getActiveScheduler();
      const timelineComments = scheduler && scheduler.comments
        ? scheduler.comments.size
        : 0;
      const timelineItems = scheduler && scheduler.timeline
        ? scheduler.timeline.length
        : 0;
      const layoutItems = this.layer && this.layer.layoutItems ? this.layer.layoutItems.length : 0;
      const renderedItems = this.layer && this.layer.nodes ? this.layer.nodes.size : 0;
      const liveChatQueued = scheduler && typeof scheduler.countFutureItems === "function"
        ? scheduler.countFutureItems(scheduler.getCurrentTime())
        : this.debugState.liveChatQueued;
      const liveChatDropped = scheduler && typeof scheduler.droppedCount === "number"
        ? scheduler.droppedCount
        : this.debugState.liveChatDropped;

      this.debugState = {
        ...this.debugState,
        totalComments: timelineComments,
        timelineItems,
        layoutItems,
        renderedItems,
        liveChatQueued,
        liveChatDropped,
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

      if (this.liveChatSource) {
        this.liveChatSource.dispose();
      }

      if (this.timelineScheduler) {
        this.timelineScheduler.dispose();
      }

      if (this.realtimeScheduler) {
        this.realtimeScheduler.dispose();
      }

      if (this.layer) {
        this.layer.dispose();
      }

      this.removeOrphanLayers();

      this.commentSource = null;
      this.apiCommentSource = null;
      this.liveChatSource = null;
      this.timelineScheduler = null;
      this.realtimeScheduler = null;
      this.liveReplayLoadState = null;
      this.layer = null;
      this.debugState = null;
      this.activeVideoId = "";
      this.activeMode = "normal";
    }

    removeOrphanLayers() {
      document.querySelectorAll("[data-youtubi-layer='true']").forEach((node) => {
        node.remove();
      });
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

      this.liveChatRetryState.clear();
      this.disposePage();
    }
  }

  const app = new YoutubiApp();
  window[APP_KEY] = app;
  app.start();
})();
