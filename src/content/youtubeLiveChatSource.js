(() => {
  const LIVE_ENDPOINT = "live_chat/get_live_chat";
  const REPLAY_ENDPOINT = "live_chat/get_live_chat_replay";
  const LIVE_BASELINE_DELAY_MS = 800;
  const LIVE_DEFAULT_POLL_MS = 1500;
  const LIVE_MIN_POLL_MS = 750;
  const LIVE_MAX_POLL_MS = 10000;
  const REPLAY_PAGE_DELAY_MS = 120;
  const REPLAY_BUFFER_AHEAD_SECONDS = 30;
  const REPLAY_POLL_MS = 750;
  const REPLAY_REQUEST_BUCKET_MS = 2000;
  const INITIAL_CONTINUATION_RETRY_MS = 500;
  const INITIAL_CONTINUATION_RETRY_COUNT = 16;
  const FETCH_RETRY_BASE_MS = 1000;
  const FETCH_RETRY_MAX_MS = 30000;
  const CHAT_FRAME_SELECTORS = [
    "iframe#chatframe",
    "ytd-live-chat-frame iframe",
    "iframe[src*='/live_chat']"
  ].join(",");

  const innertube = window.YoutubiInnertube;
  const commentTime = window.YoutubiCommentTime || {
    normalizeText: (text) => String(text || "").replace(/\s+/g, " ").trim()
  };

  const normalizeText = commentTime.normalizeText;
  const {
    sleep,
    isAbortError,
    getNested,
    textFrom,
    firstText,
    firstUrl,
    getHandle,
    walk
  } = innertube;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const readOffsetSeconds = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) {
        return number / 1000;
      }
    }

    return null;
  };

  const readTimestamp = (renderer) => {
    const timestampUsec = Number(renderer && renderer.timestampUsec);
    if (Number.isFinite(timestampUsec) && timestampUsec > 0) {
      return Math.floor(timestampUsec / 1000);
    }

    const timestampMsec = Number(renderer && renderer.timestampMsec);
    if (Number.isFinite(timestampMsec) && timestampMsec > 0) {
      return timestampMsec;
    }

    const timestampSeconds = Number(renderer && renderer.timestampSeconds);
    if (Number.isFinite(timestampSeconds) && timestampSeconds > 0) {
      return timestampSeconds * 1000;
    }

    return null;
  };

  const findRenderer = (item) => {
    if (!item || typeof item !== "object") {
      return null;
    }

    return (
      item.liveChatTextMessageRenderer ||
      item.liveChatPaidMessageRenderer ||
      item.liveChatPaidStickerRenderer ||
      item.liveChatMembershipItemRenderer ||
      item.liveChatViewerEngagementMessageRenderer ||
      item.liveChatPlaceholderItemRenderer ||
      item
    );
  };

  const normalizeImageUrl = (url) => {
    try {
      const parsed = new URL(String(url || ""), location.href);
      return /^https?:$/.test(parsed.protocol) ? parsed.href : "";
    } catch (error) {
      return "";
    }
  };

  const createTextFragment = (text) => {
    const normalized = String(text || "").replace(/\s+/g, " ");
    return normalized ? { type: "text", text: normalized } : null;
  };

  const createImageFragment = (url, alt) => {
    const normalizedUrl = normalizeImageUrl(url);
    if (!normalizedUrl) {
      return null;
    }

    return {
      type: "image",
      url: normalizedUrl,
      alt: normalizeText(alt || "")
    };
  };

  const getEmojiAlt = (emoji) =>
    firstText(
      Array.isArray(emoji && emoji.shortcuts) ? emoji.shortcuts[0] : emoji && emoji.shortcuts,
      getNested(emoji, ["accessibility", "accessibilityData", "label"]),
      emoji && emoji.emojiId,
      Array.isArray(emoji && emoji.searchTerms) ? emoji.searchTerms[0] : emoji && emoji.searchTerms
    );

  const getEmojiUrl = (emoji) =>
    firstUrl(
      getNested(emoji, ["image", "thumbnails"]),
      getNested(emoji, ["image", "sources"]),
      emoji && emoji.image,
      emoji
    );

  const fragmentsFromRuns = (runs) => {
    const fragments = [];

    (runs || []).forEach((run) => {
      if (!run || typeof run !== "object") {
        return;
      }

      if (run.emoji) {
        const image = createImageFragment(getEmojiUrl(run.emoji), getEmojiAlt(run.emoji));
        if (image) {
          fragments.push(image);
          return;
        }
      }

      const text = createTextFragment(run.text || run.content || textFrom(run));
      if (text) {
        fragments.push(text);
      }
    });

    return fragments;
  };

  const fragmentsFromValue = (value) => {
    if (!value) {
      return [];
    }

    if (typeof value === "string") {
      const text = createTextFragment(value);
      return text ? [text] : [];
    }

    if (Array.isArray(value)) {
      return value.flatMap(fragmentsFromValue);
    }

    if (typeof value !== "object") {
      return [];
    }

    if (Array.isArray(value.runs)) {
      return fragmentsFromRuns(value.runs);
    }

    if (Array.isArray(value.commandRuns)) {
      return fragmentsFromRuns(value.commandRuns);
    }

    const text = createTextFragment(value.simpleText || value.content || value.text || "");
    return text ? [text] : [];
  };

  const firstFragments = (...values) => {
    for (const value of values) {
      const fragments = fragmentsFromValue(value);
      if (fragments.length) {
        return fragments;
      }
    }

    return [];
  };

  const getStickerFragment = (renderer) => {
    if (!renderer || (!renderer.sticker && !renderer.stickerImage)) {
      return null;
    }

    const url = firstUrl(
      getNested(renderer, ["sticker", "thumbnails"]),
      getNested(renderer, ["sticker", "image", "sources"]),
      renderer && renderer.sticker,
      renderer && renderer.stickerImage
    );
    const alt = firstText(
      getNested(renderer, ["sticker", "accessibility", "accessibilityData", "label"]),
      getNested(renderer, ["sticker", "accessibilityText"]),
      renderer && renderer.tooltip,
      "sticker"
    );

    return createImageFragment(url, alt);
  };

  const joinFragments = (...groups) => {
    const fragments = [];

    groups.filter((group) => group && group.length).forEach((group) => {
      if (fragments.length) {
        fragments.push({ type: "text", text: " " });
      }
      fragments.push(...group);
    });

    return fragments;
  };

  const getMessageFragments = (renderer) => {
    if (!renderer || typeof renderer !== "object") {
      return [];
    }

    const amount = fragmentsFromValue(renderer.purchaseAmountText);
    const message = firstFragments(
      renderer.message,
      renderer.text,
      renderer.headerPrimaryText,
      renderer.headerSubtext,
      getNested(renderer, ["lowerBumper", "liveChatItemBumperViewModel", "content"]),
      renderer.tooltip
    );
    const sticker = getStickerFragment(renderer);
    const media = sticker ? [sticker] : [];

    return joinFragments(amount, message, media);
  };

  const fragmentsToText = (fragments) => {
    const text = (fragments || [])
      .map((fragment) => fragment.type === "image" ? fragment.alt || "emoji" : fragment.text || "")
      .join("");

    return normalizeText(text);
  };

  const parseChatAction = (action, options = {}) => {
    const addAction = action && (
      action.addChatItemAction ||
      action.addLiveChatTickerItemAction ||
      action.replaceChatItemAction ||
      action.markChatItemAsDeletedAction
    );
    const item = addAction && (addAction.item || addAction.tickerItem);
    const renderer = findRenderer(item);
    if (!renderer) {
      return null;
    }

    const fragments = getMessageFragments(renderer);
    const text = fragmentsToText(fragments);
    if (!text) {
      return null;
    }

    const authorName = firstText(
      renderer.authorName,
      renderer.authorExternalChannelId,
      getNested(renderer, ["author", "displayName"])
    );
    const timestamp = readTimestamp(renderer);
    const appearAt = readOffsetSeconds(
      options.videoOffsetTimeMsec,
      getNested(addAction, ["videoOffsetTimeMsec"]),
      getNested(renderer, ["videoOffsetTimeMsec"])
    );
    const id =
      renderer.id ||
      renderer.clientId ||
      addAction.clientId ||
      [
        authorName,
        text.slice(0, 160),
        timestamp || "",
        Number.isFinite(appearAt) ? appearAt : "",
        options.order
      ].join("|");

    return {
      id,
      text,
      fragments,
      order: options.order,
      authorName,
      authorHandle: getHandle(authorName),
      avatarUrl: firstUrl(
        getNested(renderer, ["authorPhoto", "thumbnails"]),
        renderer.authorPhoto,
        getNested(renderer, ["author", "avatarThumbnailUrl"])
      ),
      publishedAt: timestamp,
      publishedText: firstText(renderer.timestampText),
      appearAt: Number.isFinite(appearAt) ? appearAt : null,
      source: options.mode === "liveReplay" ? "live-chat-replay" : "live-chat"
    };
  };

  const extractChatActions = (data) => {
    const actions = [];

    walk(data, (node) => {
      if (node.replayChatItemAction) {
        const replayAction = node.replayChatItemAction;
        const videoOffsetTimeMsec = replayAction.videoOffsetTimeMsec;
        (replayAction.actions || []).forEach((action) => {
          actions.push({ action, videoOffsetTimeMsec });
        });
        return false;
      }

      if (
        node.addChatItemAction ||
        node.addLiveChatTickerItemAction ||
        node.replaceChatItemAction ||
        node.markChatItemAsDeletedAction
      ) {
        actions.push({
          action: node,
          videoOffsetTimeMsec: getNested(node, ["addChatItemAction", "videoOffsetTimeMsec"])
        });
        return false;
      }

      return undefined;
    });

    return actions;
  };

  const extractChats = (data, startOrder, mode) => {
    const chats = [];
    const seen = new Set();
    let order = startOrder;

    extractChatActions(data).forEach(({ action, videoOffsetTimeMsec }) => {
      const chat = parseChatAction(action, {
        mode,
        order,
        videoOffsetTimeMsec
      });

      if (!chat || seen.has(chat.id)) {
        return;
      }

      seen.add(chat.id);
      chats.push(chat);
      order += 1;
    });

    return chats;
  };

  class YouTubeLiveChatSource {
    constructor({ videoId, mode, continuation, maxItems, initialContinuationRetryCount, video, onChat, onStatus }) {
      this.videoId = videoId;
      this.mode = mode === "liveReplay" ? "liveReplay" : "live";
      this.initialContinuation = continuation || "";
      this.maxItems = maxItems || 500;
      this.initialContinuationRetryCount = Number.isFinite(Number(initialContinuationRetryCount))
        ? Math.max(1, Math.floor(Number(initialContinuationRetryCount)))
        : INITIAL_CONTINUATION_RETRY_COUNT;
      this.video = video || null;
      this.onChat = onChat;
      this.onStatus = onStatus;
      this.abortController = null;
      this.disposed = false;
      this.started = false;
      this.config = null;
      this.loadedCount = 0;
      this.order = 0;
      this.fetchFailureCount = 0;
      this.seen = new Set();
      this.baselinePending = this.mode === "live";
      this.replayContinuation = "";
      this.replaySeenRequestKeys = new Set();
      this.replayBufferedUntil = 0;
      this.replayEpoch = 0;
      this.replayReady = false;
      this.lastContinuationDiagnostics = null;
      this.lastContinuationFrameStatus = null;
      this.lastContinuationWatchStatus = null;
      this.lastContinuationNextStatus = null;
      this.boundReplaySeek = () => this.handleReplaySeek();
    }

    start() {
      if (this.started) {
        return;
      }

      this.started = true;
      if (this.mode === "liveReplay" && this.video) {
        this.video.addEventListener("seeking", this.boundReplaySeek);
        this.video.addEventListener("seeked", this.boundReplaySeek);
      }
      this.run();
    }

    async run() {
      try {
        const config = await innertube.waitForConfig(() => this.disposed);
        if (!config || !config.apiKey || !config.context || !this.videoId) {
          this.reportStatus("config-missing", {
            hasApiKey: Boolean(config && config.apiKey),
            hasContext: Boolean(config && config.context),
            hasVideoId: Boolean(this.videoId)
          });
          return;
        }

        if (!this.isCurrentPage()) {
          return;
        }

        this.config = config;
        this.abortController = new AbortController();
        const continuationInfo = await this.resolveInitialContinuation();
        const continuation = continuationInfo && continuationInfo.token;
        if (!continuation) {
          this.reportStatus("continuation-missing", this.getContinuationDiagnostics());
          return;
        }

        this.initialContinuation = continuation;
        this.reportStatus("ready", {
          continuation: "found",
          continuationSource: continuationInfo.source || "",
          maxItems: this.maxItems
        });

        if (this.mode === "liveReplay") {
          await this.runReplay(continuation);
        } else {
          await this.runLive(continuation);
        }
      } catch (error) {
        if (this.disposed || isAbortError(error)) {
          return;
        }

        if (this.loadedCount === 0 && this.isInvalidContinuationError(error)) {
          this.reportStatus("continuation-rejected", {
            message: error && error.message ? error.message : String(error)
          });
          return;
        }

        this.reportStatus("failed", { message: error && error.message ? error.message : String(error) });
        console.info("[Youtubi] YouTube live chat source failed", error);
      }
    }

    async runLive(firstContinuation) {
      let continuation = firstContinuation;

      while (!this.disposed && continuation) {
        const response = await this.fetchChatWithRecovery(continuation);
        if (this.disposed || !response || !this.isCurrentPage()) {
          return;
        }

        const chats = extractChats(response, this.order, this.mode);
        if (this.baselinePending) {
          chats.forEach((chat) => this.seen.add(chat.id));
          this.order += chats.length;
          this.baselinePending = false;
          this.reportStatus("baseline", {
            baselineCount: chats.length,
            loadedCount: this.loadedCount
          });
          await sleep(LIVE_BASELINE_DELAY_MS);
        } else {
          this.emitChats(chats);
        }

        const continuationInfo = innertube.getLiveChatContinuation(response, { replay: false });
        continuation = continuationInfo.token;
        const delay = clamp(
          Number(continuationInfo.timeoutMs) || LIVE_DEFAULT_POLL_MS,
          LIVE_MIN_POLL_MS,
          LIVE_MAX_POLL_MS
        );

        this.reportStatus("polling", {
          loadedCount: this.loadedCount,
          timeoutMs: delay
        });

        if (continuation) {
          await sleep(delay);
        }
      }

      this.reportStatus("done", { loadedCount: this.loadedCount });
    }

    async runReplay(firstContinuation) {
      this.replayContinuation = firstContinuation;

      while (!this.disposed) {
        if (!this.isCurrentPage()) {
          return;
        }

        const targetBufferedUntil = this.getVideoTime() + REPLAY_BUFFER_AHEAD_SECONDS;
        while (
          !this.disposed &&
          this.replayContinuation &&
          (!this.replayReady || this.replayBufferedUntil < targetBufferedUntil)
        ) {
          const epoch = this.replayEpoch;
          const continuation = this.replayContinuation;
          const playerOffsetMs = Math.floor(this.getVideoTime() * 1000);
          const requestKey = this.getReplayRequestKey(continuation, playerOffsetMs);
          if (this.replaySeenRequestKeys.has(requestKey)) {
            break;
          }

          const response = await this.fetchChatWithRecovery(continuation, {
            playerOffsetMs
          });
          if (this.disposed || !response || !this.isCurrentPage()) {
            return;
          }

          if (epoch !== this.replayEpoch) {
            break;
          }

          this.replaySeenRequestKeys.add(requestKey);
          this.trimReplaySeenRequestKeys();

          const chats = extractChats(response, this.order, this.mode)
            .filter((chat) => Number.isFinite(chat.appearAt));
          const maxAppearAt = this.getMaxAppearAt(chats);
          if (Number.isFinite(maxAppearAt)) {
            this.replayBufferedUntil = Math.max(this.replayBufferedUntil, maxAppearAt);
          }

          this.emitChats(chats);

          const continuationInfo = innertube.getLiveChatContinuation(response, { replay: true });
          this.replayContinuation = continuationInfo.token || innertube.findNextContinuation(response, { replay: true });
          this.reportReplayReady(targetBufferedUntil);
          this.reportStatus("replay-buffer", {
            loadedCount: this.loadedCount,
            bufferedUntil: Math.round(this.replayBufferedUntil),
            playerTime: Math.round(this.getVideoTime())
          });

          if (
            this.replayContinuation &&
            this.replayBufferedUntil < targetBufferedUntil
          ) {
            await sleep(REPLAY_PAGE_DELAY_MS);
          }
        }

        if (!this.replayContinuation && this.replayReady) {
          this.reportStatus("replay-waiting-for-seek", {
            loadedCount: this.loadedCount,
            bufferedUntil: Math.round(this.replayBufferedUntil),
            playerTime: Math.round(this.getVideoTime())
          });
        }

        await sleep(REPLAY_POLL_MS);
      }
    }

    reportReplayReady(targetBufferedUntil) {
      if (this.replayReady) {
        return;
      }

      if (
        this.replayContinuation &&
        Number.isFinite(targetBufferedUntil) &&
        this.replayBufferedUntil < targetBufferedUntil
      ) {
        return;
      }

      this.replayReady = true;
      this.reportStatus("replay-ready", {
        loadedCount: this.loadedCount,
        bufferedUntil: Math.round(this.replayBufferedUntil),
        playerTime: Math.round(this.getVideoTime())
      });
    }

    getMaxAppearAt(chats) {
      return chats.reduce((max, chat) =>
        Number.isFinite(chat.appearAt) ? Math.max(max, chat.appearAt) : max,
        Number.NEGATIVE_INFINITY
      );
    }

    handleReplaySeek() {
      if (this.mode !== "liveReplay" || this.disposed) {
        return;
      }

      this.replayEpoch += 1;
      this.replayContinuation = this.initialContinuation || this.findInitialContinuation();
      this.replaySeenRequestKeys.clear();
      this.replayBufferedUntil = this.getVideoTime();
      this.replayReady = false;
      this.reportStatus("replay-seek", {
        loadedCount: this.loadedCount,
        playerTime: Math.round(this.getVideoTime())
      });
    }

    getReplayRequestKey(continuation, playerOffsetMs) {
      const bucket = Math.floor(Math.max(0, Number(playerOffsetMs) || 0) / REPLAY_REQUEST_BUCKET_MS);
      return `${continuation || ""}|${bucket}`;
    }

    trimReplaySeenRequestKeys() {
      if (this.replaySeenRequestKeys.size <= 1200) {
        return;
      }

      const overflow = this.replaySeenRequestKeys.size - 900;
      const iterator = this.replaySeenRequestKeys.values();
      for (let index = 0; index < overflow; index += 1) {
        const next = iterator.next();
        if (next.done) {
          break;
        }

        this.replaySeenRequestKeys.delete(next.value);
      }
    }

    getVideoTime() {
      return this.video && Number.isFinite(this.video.currentTime) ? Math.max(0, this.video.currentTime) : 0;
    }

    emitChats(chats) {
      for (const chat of chats) {
        this.order += 1;
        if (this.seen.has(chat.id)) {
          continue;
        }

        this.seen.add(chat.id);
        this.trimSeen();
        this.loadedCount += 1;

        if (this.onChat) {
          this.onChat(chat);
        }
      }
    }

    async fetchChatWithRecovery(continuation, options = {}) {
      while (!this.disposed && this.isCurrentPage()) {
        try {
          const response = await this.fetchChat(continuation, options);
          if (this.fetchFailureCount > 0) {
            this.reportStatus("recovered", {
              retryCount: this.fetchFailureCount,
              loadedCount: this.loadedCount
            });
          }
          this.fetchFailureCount = 0;
          return response;
        } catch (error) {
          if (this.disposed || isAbortError(error) || !this.isCurrentPage()) {
            return null;
          }

          if (!this.isRecoverableFetchError(error)) {
            throw error;
          }

          this.fetchFailureCount += 1;
          const retryDelayMs = this.getFetchRetryDelay(this.fetchFailureCount);
          this.reportStatus("recovering", {
            retryCount: this.fetchFailureCount,
            retryDelayMs,
            message: error && error.message ? error.message : String(error)
          });
          await sleep(retryDelayMs);
        }
      }

      return null;
    }

    isRecoverableFetchError(error) {
      const status = this.getHttpStatusFromError(error);
      if (Number.isFinite(status)) {
        return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
      }

      if (error && error.name === "TypeError") {
        return true;
      }

      const message = String(error && error.message ? error.message : error || "").toLowerCase();
      return (
        message.includes("failed to fetch") ||
        message.includes("network") ||
        message.includes("load failed") ||
        message.includes("timeout") ||
        message.includes("timed out") ||
        message.includes("offline")
      );
    }

    isInvalidContinuationError(error) {
      return this.getHttpStatusFromError(error) === 400;
    }

    getHttpStatusFromError(error) {
      const message = String(error && error.message ? error.message : error || "");
      const match =
        message.match(/\bfailed:\s*(\d{3})\b/i) ||
        message.match(/\bstatus\s*[:=]?\s*(\d{3})\b/i);
      return match ? Number(match[1]) : Number.NaN;
    }

    getFetchRetryDelay(attempt) {
      const exponent = Math.min(5, Math.max(0, attempt - 1));
      return clamp(FETCH_RETRY_BASE_MS * (2 ** exponent), FETCH_RETRY_BASE_MS, FETCH_RETRY_MAX_MS);
    }

    async fetchChat(continuation, options = {}) {
      const endpoint = this.mode === "liveReplay" ? REPLAY_ENDPOINT : LIVE_ENDPOINT;
      const body = { continuation };
      if (this.mode === "live") {
        body.webClientInfo = {
          isDocumentHidden: typeof document !== "undefined" ? Boolean(document.hidden) : false
        };
      } else if (Number.isFinite(options.playerOffsetMs)) {
        body.currentPlayerState = {
          playerOffsetMs: Math.max(0, Math.floor(options.playerOffsetMs))
        };
      }

      try {
        return await innertube.fetchEndpoint(
          endpoint,
          this.config,
          body,
          this.abortController && this.abortController.signal
        );
      } catch (error) {
        if (this.mode !== "liveReplay" || !body.currentPlayerState || !/400/.test(error && error.message || "")) {
          throw error;
        }

        delete body.currentPlayerState;
        return innertube.fetchEndpoint(
          endpoint,
          this.config,
          body,
          this.abortController && this.abortController.signal
        );
      }
    }

    async resolveInitialContinuation() {
      if (this.initialContinuation) {
        return {
          token: this.initialContinuation,
          source: "provided"
        };
      }

      for (let attempt = 0; attempt < this.initialContinuationRetryCount; attempt += 1) {
        if (this.disposed || !this.isCurrentPage()) {
          return null;
        }

        this.lastContinuationDiagnostics = this.getContinuationDiagnostics({
          attempt,
          attempts: this.initialContinuationRetryCount
        });

        const chatFrameInfo = await this.findChatFrameContinuation({
          includeFallback: attempt === 0 || attempt === this.initialContinuationRetryCount - 1
        });
        if (chatFrameInfo && chatFrameInfo.token) {
          return chatFrameInfo;
        }

        const topPageInfo = this.findInitialContinuationInfo();
        if (topPageInfo && topPageInfo.token) {
          return topPageInfo;
        }

        if (attempt === 0 || attempt === this.initialContinuationRetryCount - 1) {
          const watchNextInfo = await this.findWatchNextContinuationInfo();
          if (watchNextInfo && watchNextInfo.token) {
            return watchNextInfo;
          }
        }

        if (this.mode === "liveReplay" && (attempt === 0 || attempt === this.initialContinuationRetryCount - 1)) {
          const watchPageInfo = await this.findWatchPageContinuationInfo();
          if (watchPageInfo && watchPageInfo.token) {
            return watchPageInfo;
          }
        }

        if (attempt === 0) {
          this.reportStatus("continuation-waiting");
        }

        if (attempt < this.initialContinuationRetryCount - 1) {
          await sleep(INITIAL_CONTINUATION_RETRY_MS);
        }
      }

      return null;
    }

    getContinuationDiagnostics(details = {}) {
      const currentPageData = this.getCurrentPageData();
      const initialData = innertube.extractInitialData();
      const playerResponse = innertube.extractPlayerResponse();
      const chatFrameUrl = this.findChatFrameUrl({ includeFallback: false });

      return {
        ...details,
        currentPageDataCount: currentPageData.length,
        hasCurrentPageData: currentPageData.length > 0,
        hasTopInitialDataForVideo: this.hasCurrentVideoEvidence(initialData),
        hasPlayerResponseForVideo: this.isPlayerResponseForCurrentVideo(playerResponse),
        hasChatFrame: Boolean(chatFrameUrl),
        lastFrameStatus: this.lastContinuationFrameStatus || null,
        lastNextStatus: this.lastContinuationNextStatus || null,
        lastWatchStatus: this.lastContinuationWatchStatus || null,
        lastProbe: Object.prototype.hasOwnProperty.call(details, "attempt")
          ? null
          : this.lastContinuationDiagnostics || null
      };
    }

    findInitialContinuation() {
      const info = this.findInitialContinuationInfo();
      return info && info.token ? info.token : "";
    }

    findInitialContinuationInfo() {
      const currentPageInfo = this.findCurrentPageContinuationInfo();
      if (currentPageInfo && currentPageInfo.token) {
        return currentPageInfo;
      }

      const initialData = innertube.extractInitialData();
      const playerResponse = innertube.extractPlayerResponse();
      return (
        this.findContinuationInfoIn(this.isPlayerResponseForCurrentVideo(playerResponse) ? playerResponse : null, "top-player-response") ||
        this.findContinuationInfoIn(this.hasCurrentVideoEvidence(initialData) ? initialData : null, "top-initial-data") ||
        null
      );
    }

    findContinuationInfoIn(data, source) {
      if (!data || !innertube.findLiveChatContinuation) {
        return null;
      }

      const result = innertube.findLiveChatContinuation(data, {
        replay: this.mode === "liveReplay",
        allowContinuationData: source === "chatframe" || source === "watch-page"
      });
      return result && result.token
        ? {
            token: result.token,
            source: result.source || source || ""
          }
        : null;
    }

    findCurrentPageContinuationInfo() {
      for (const data of this.getCurrentPageData()) {
        const info = this.findContinuationInfoIn(data, "current-page-data");
        if (info && info.token) {
          return info;
        }
      }

      return null;
    }

    getCurrentPageData() {
      const data = [];
      const watchFlexy = this.getCurrentWatchFlexy();
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
            // YouTube custom element properties can be temporarily unavailable during SPA transitions.
          }
        });
      });

      return data;
    }

    getCurrentWatchFlexy() {
      const watchFlexies = Array.from(document.querySelectorAll("ytd-watch-flexy"));
      const exact = watchFlexies.find((node) => node.getAttribute("video-id") === this.videoId);
      if (exact) {
        return exact;
      }

      if (!this.isCurrentPage()) {
        return null;
      }

      return watchFlexies.find((node) => {
        const nodeVideoId = node.getAttribute("video-id") || "";
        return node.isConnected && (!nodeVideoId || nodeVideoId === this.videoId);
      }) || null;
    }

    async findWatchNextContinuationInfo() {
      if (!this.config || !innertube.fetchNext) {
        return null;
      }

      try {
        const response = await innertube.fetchNext(
          this.config,
          {
            videoId: this.videoId,
            contentCheckOk: true,
            racyCheckOk: true
          },
          this.abortController && this.abortController.signal
        );
        const info = this.findContinuationInfoIn(response, "watch-next");
        this.lastContinuationNextStatus = {
          status: "ok",
          hasContinuation: Boolean(info && info.token)
        };
        return info;
      } catch (error) {
        if (isAbortError(error)) {
          return null;
        }

        this.lastContinuationNextStatus = {
          status: "failed",
          message: error && error.message ? error.message : String(error)
        };
        return null;
      }
    }

    async findWatchPageContinuationInfo() {
      try {
        const watchUrl = new URL("/watch", location.origin);
        watchUrl.searchParams.set("v", this.videoId);
        const response = await fetch(watchUrl.href, {
          credentials: "include",
          signal: this.abortController && this.abortController.signal
        });
        this.lastContinuationWatchStatus = {
          status: response.ok ? "http-ok" : "http-failed",
          httpStatus: response.status
        };
        if (!response.ok) {
          return null;
        }

        const html = await response.text();
        if (this.disposed || !this.isCurrentPage()) {
          return null;
        }

        const initialData = this.extractInitialDataFromHtml(html);
        const initialHasVideoEvidence = this.hasCurrentVideoEvidence(initialData);
        const initialInfo = initialHasVideoEvidence
          ? this.findContinuationInfoIn(initialData, "watch-page")
          : null;
        this.lastContinuationWatchStatus = {
          ...this.lastContinuationWatchStatus,
          hasInitialData: Boolean(initialData),
          initialHasVideoEvidence,
          hasInitialContinuation: Boolean(initialInfo && initialInfo.token)
        };
        if (initialInfo && initialInfo.token) {
          return initialInfo;
        }

        const playerResponse = this.extractPlayerResponseFromHtml(html);
        const playerResponseForVideo = this.isPlayerResponseForCurrentVideo(playerResponse);
        const playerInfo = playerResponseForVideo
          ? this.findContinuationInfoIn(playerResponse, "watch-page")
          : null;
        this.lastContinuationWatchStatus = {
          ...this.lastContinuationWatchStatus,
          hasPlayerResponse: Boolean(playerResponse),
          playerResponseForVideo,
          hasPlayerContinuation: Boolean(playerInfo && playerInfo.token)
        };
        return playerInfo;
      } catch (error) {
        if (isAbortError(error)) {
          return null;
        }

        this.lastContinuationWatchStatus = {
          status: "fetch-failed",
          message: error && error.message ? error.message : String(error)
        };
        return null;
      }
    }

    isPlayerResponseForCurrentVideo(playerResponse) {
      const videoId = getNested(playerResponse, ["videoDetails", "videoId"]);
      return Boolean(videoId && videoId === this.videoId);
    }

    hasCurrentVideoEvidence(data) {
      if (!data || !this.videoId) {
        return false;
      }

      let found = false;
      walk(data, (node) => {
        const candidates = [
          getNested(node, ["videoDetails", "videoId"]),
          getNested(node, ["currentVideoEndpoint", "watchEndpoint", "videoId"]),
          getNested(node, ["watchEndpoint", "videoId"])
        ].filter(Boolean);

        if (candidates.includes(this.videoId)) {
          found = true;
          return false;
        }

        return undefined;
      });

      return found;
    }

    async findChatFrameContinuation(options = {}) {
      const frameUrl = this.findChatFrameUrl(options);
      if (!frameUrl) {
        this.lastContinuationFrameStatus = {
          status: "missing-url",
          includeFallback: Boolean(options.includeFallback)
        };
        return null;
      }

      const urlInfo = this.findContinuationInChatFrameUrl(frameUrl);
      if (urlInfo) {
        this.lastContinuationFrameStatus = {
          status: "url-token",
          includeFallback: Boolean(options.includeFallback)
        };
        return urlInfo;
      }

      try {
        const response = await fetch(frameUrl, {
          credentials: "include",
          signal: this.abortController && this.abortController.signal
        });
        this.lastContinuationFrameStatus = {
          status: response.ok ? "http-ok" : "http-failed",
          httpStatus: response.status,
          includeFallback: Boolean(options.includeFallback)
        };
        if (!response.ok) {
          return null;
        }

        const html = await response.text();
        if (this.disposed || !this.isCurrentPage()) {
          return null;
        }

        const data = this.extractInitialDataFromHtml(html);
        const info = this.findContinuationInfoIn(data, "chatframe");
        return info && info.token
          ? {
              ...info,
              source: info.source || "chatframe"
            }
          : null;
      } catch (error) {
        if (isAbortError(error)) {
          return null;
        }

        this.lastContinuationFrameStatus = {
          status: "fetch-failed",
          includeFallback: Boolean(options.includeFallback),
          message: error && error.message ? error.message : String(error)
        };
        this.reportStatus("continuation-frame-failed", {
          message: error && error.message ? error.message : String(error)
        });
        return null;
      }
    }

    findChatFrameUrl(options = {}) {
      const frames = Array.from(document.querySelectorAll(CHAT_FRAME_SELECTORS));

      for (const frame of frames) {
        const src = frame.getAttribute("src") || frame.src || "";
        if (!src || !this.isChatFrameForCurrentVideo(frame, src)) {
          continue;
        }

        try {
          const parsed = new URL(src, location.href);
          const isReplayFrame = parsed.pathname.includes("live_chat_replay");
          const isLiveFrame = parsed.pathname.includes("live_chat") && !isReplayFrame;
          if (this.mode === "liveReplay" ? isReplayFrame : isLiveFrame) {
            return parsed.href;
          }
        } catch (error) {
          const isReplayFrame = src.includes("live_chat_replay");
          const isLiveFrame = src.includes("live_chat") && !isReplayFrame;
          if (this.mode === "liveReplay" ? isReplayFrame : isLiveFrame) {
            return src;
          }
        }
      }

      if (options.includeFallback && this.videoId) {
        return this.getFallbackChatFrameUrl();
      }

      return "";
    }

    getFallbackChatFrameUrl() {
      if (this.mode === "liveReplay") {
        return "";
      }

      const fallbackUrl = new URL("/live_chat", location.origin);
      fallbackUrl.searchParams.set("is_popout", "1");
      fallbackUrl.searchParams.set("v", this.videoId);
      fallbackUrl.searchParams.set("embed_domain", location.hostname);
      return fallbackUrl.href;
    }

    isChatFrameForCurrentVideo(frame, src) {
      try {
        const parsed = new URL(src, location.href);
        const frameVideoId = parsed.searchParams.get("v") || "";
        if (frameVideoId) {
          return frameVideoId === this.videoId;
        }
      } catch (error) {
        // Fall back to the enclosing watch page below.
      }

      const frameWatchFlexy = frame.closest && frame.closest("ytd-watch-flexy");
      if (frameWatchFlexy && frameWatchFlexy.getAttribute("video-id")) {
        return frameWatchFlexy.getAttribute("video-id") === this.videoId;
      }

      const watchFlexy = this.getCurrentWatchFlexy();
      if (watchFlexy) {
        return watchFlexy.contains(frame);
      }

      return this.isCurrentPage() && frame.isConnected;
    }

    findContinuationInChatFrameUrl(frameUrl) {
      try {
        const parsed = new URL(frameUrl, location.href);
        const token =
          parsed.searchParams.get("continuation") ||
          parsed.searchParams.get("c") ||
          "";
        return token
          ? {
              token,
              source: "chatframe-url"
            }
          : null;
      } catch (error) {
        return null;
      }
    }

    extractInitialDataFromHtml(html) {
      if (!html || typeof html !== "string" || !innertube.parseJsonAfter) {
        return null;
      }

      return (
        innertube.parseJsonAfter(html, "ytInitialData =") ||
        innertube.parseJsonAfter(html, "var ytInitialData =") ||
        innertube.parseJsonAfter(html, "window[\"ytInitialData\"] =") ||
        innertube.parseJsonAfter(html, "window.ytInitialData =") ||
        innertube.parseJsonAfter(html, "\"ytInitialData\":") ||
        null
      );
    }

    extractPlayerResponseFromHtml(html) {
      if (!html || typeof html !== "string" || !innertube.parseJsonAfter) {
        return null;
      }

      return (
        innertube.parseJsonAfter(html, "ytInitialPlayerResponse =") ||
        innertube.parseJsonAfter(html, "var ytInitialPlayerResponse =") ||
        innertube.parseJsonAfter(html, "window[\"ytInitialPlayerResponse\"] =") ||
        innertube.parseJsonAfter(html, "window.ytInitialPlayerResponse =") ||
        innertube.parseJsonAfter(html, "\"playerResponse\":") ||
        null
      );
    }

    reportStatus(status, details = {}) {
      const payload = {
        status,
        mode: this.mode,
        loadedCount: this.loadedCount,
        ...details
      };

      if (this.onStatus) {
        this.onStatus(payload);
      }

      if (status === "failed" || status === "config-missing" || status === "continuation-missing") {
        console.info(`[Youtubi] live chat ${status}`, payload);
      }
    }

    isCurrentPage() {
      try {
        return new URL(location.href).searchParams.get("v") === this.videoId;
      } catch (error) {
        return false;
      }
    }

    trimSeen() {
      if (this.seen.size <= 2500) {
        return;
      }

      const overflow = this.seen.size - 2000;
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
      this.disposed = true;

      if (this.mode === "liveReplay" && this.video) {
        this.video.removeEventListener("seeking", this.boundReplaySeek);
        this.video.removeEventListener("seeked", this.boundReplaySeek);
      }

      if (this.abortController) {
        this.abortController.abort();
      }

      this.abortController = null;
      this.onChat = null;
      this.onStatus = null;
      this.config = null;
      this.video = null;
      this.seen.clear();
      this.replaySeenRequestKeys.clear();
    }
  }

  window.YoutubiYouTubeLiveChatSource = YouTubeLiveChatSource;
})();
