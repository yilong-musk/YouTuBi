(() => {
  const PAGE_DELAY_MS = 120;
  const INITIAL_EMPTY_RETRY_MS = 600;
  const INITIAL_EMPTY_RETRY_COUNT = 6;
  const MAX_REPLY_COMMENTS = 50;
  const innertube = window.YoutubiInnertube;

  const commentTime = window.YoutubiCommentTime || {
    normalizeText: (text) => String(text || "").replace(/\s+/g, " ").trim(),
    parsePublishedAt: () => null
  };

  const normalizeText = commentTime.normalizeText;
  const parsePublishedAt = commentTime.parsePublishedAt;
  const {
    sleep,
    isAbortError,
    getNested,
    firstText,
    firstUrl,
    getHandle,
    walk,
    findContinuationToken,
    findNextContinuation
  } = innertube;

  const t = (key, substitutions, fallback) =>
    window.YoutubiI18n ? window.YoutubiI18n.t(key, substitutions, fallback) : fallback;

  const isCommentSection = (section) => {
    const identifier = [
      section.sectionIdentifier,
      section.targetId,
      section.itemSectionSupportedRenderers
    ]
      .filter(Boolean)
      .join(" ");

    if (/comment/i.test(identifier)) {
      return true;
    }

    try {
      return /commentThreadRenderer|commentViewModel|commentEntityPayload|comment-item-section|comments-entry-point/i.test(
        JSON.stringify(section)
      );
    } catch (error) {
      return false;
    }
  };

  const findInitialCommentContinuation = (data) => {
    let token = null;

    walk(data, (node) => {
      if (token) {
        return false;
      }

      if (!node.itemSectionRenderer || !isCommentSection(node.itemSectionRenderer)) {
        return undefined;
      }

      token = findContinuationToken(node.itemSectionRenderer);
      return token ? false : undefined;
    });

    return token;
  };

  const unwrapCommentRenderer = (value) => {
    let current = value;

    for (let depth = 0; depth < 4; depth += 1) {
      if (!current || typeof current !== "object") {
        return null;
      }

      if (current.commentRenderer) {
        current = current.commentRenderer;
        continue;
      }

      if (current.commentViewModel) {
        current = current.commentViewModel;
        continue;
      }

      return current;
    }

    return current;
  };

  const parseCommentRenderer = (renderer, order, extras = {}) => {
    const comment = unwrapCommentRenderer(renderer);
    if (!comment || typeof comment !== "object") {
      return null;
    }

    const text = firstText(
      comment.contentText,
      comment.content,
      getNested(comment, ["properties", "content"]),
      comment.body,
      comment.commentText,
      comment.expandedBody
    );

    if (!text) {
      return null;
    }

    const publishedText = firstText(
      comment.publishedTimeText,
      comment.publishedTime,
      getNested(comment, ["properties", "publishedTime"]),
      comment.timeText,
      comment.timestampText
    );
    const authorName = firstText(
      comment.authorText,
      comment.author,
      comment.authorName,
      getNested(comment, ["author", "displayName"]),
      getNested(comment, ["properties", "authorName"]),
      getNested(comment, ["properties", "authorButtonA11y"]),
      getNested(comment, ["avatar", "accessibilityText"])
    );
    const avatarUrl = firstUrl(
      getNested(comment, ["author", "avatarThumbnailUrl"]),
      getNested(comment, ["avatar", "image", "sources"]),
      getNested(comment, ["authorThumbnail", "thumbnails"]),
      comment.avatar
    );
    const authorHandle = getHandle(authorName);
    const replyToHandle = getHandle(text);
    const replyLevel = Number(getNested(comment, ["properties", "replyLevel"]) || comment.replyLevel || 0) || 0;

    const id =
      comment.commentId ||
      comment.commentKey ||
      getNested(comment, ["properties", "commentId"]) ||
      getNested(comment, ["properties", "commentKey"]) ||
      `${text.slice(0, 180)}|${publishedText}`;

    return {
      id,
      text,
      order,
      authorName,
      authorHandle,
      avatarUrl,
      replyToHandle,
      replyLevel,
      publishedText,
      publishedAt: parsePublishedAt([
        publishedText,
        getNested(comment, ["publishedTimeText", "accessibility", "accessibilityData", "label"]),
        getNested(comment, ["publishedTime", "accessibility", "accessibilityData", "label"]),
        getNested(comment, ["properties", "publishedTime", "accessibility", "accessibilityData", "label"])
      ]),
      source: "youtubei",
      ...extras
    };
  };

  const getThreadCommentCandidates = (threadRenderer) => [
    getNested(threadRenderer, ["comment", "commentRenderer"]),
    getNested(threadRenderer, ["comment", "commentViewModel"]),
    getNested(threadRenderer, ["commentViewModel", "commentViewModel"]),
    threadRenderer.commentViewModel,
    threadRenderer.commentRenderer,
    threadRenderer
  ].filter(Boolean);

  const getThreadCommentId = (threadRenderer) =>
    getNested(threadRenderer, ["comment", "commentRenderer", "commentId"]) ||
    getNested(threadRenderer, ["comment", "commentViewModel", "commentId"]) ||
    getNested(threadRenderer, ["commentViewModel", "commentViewModel", "commentId"]) ||
    getNested(threadRenderer, ["commentViewModel", "commentId"]) ||
    threadRenderer.commentId ||
    "";

  const getReplyRenderer = (threadRenderer) =>
    getNested(threadRenderer, ["replies", "commentRepliesRenderer"]) ||
    getNested(threadRenderer, ["replies", "commentRepliesViewModel"]) ||
    getNested(threadRenderer, ["replies", "commentRepliesExpansionRenderer"]) ||
    threadRenderer.commentRepliesRenderer ||
    threadRenderer.commentRepliesViewModel ||
    threadRenderer.commentRepliesExpansionRenderer ||
    null;

  const hasReplyHint = (value) => {
    if (!value || typeof value !== "object") {
      return false;
    }

    try {
      return /reply|replies|comment-replies|回复|回覆|回復/i.test(JSON.stringify(value));
    } catch (error) {
      return false;
    }
  };

  const getReplyContinuationToken = (threadRenderer) => {
    const replies = getReplyRenderer(threadRenderer);
    const token = replies ? findContinuationToken(replies) : null;
    if (token) {
      return token;
    }

    return hasReplyHint(threadRenderer) ? findContinuationToken(threadRenderer) : null;
  };

  const getReplyCountText = (threadRenderer) => {
    const replies = getReplyRenderer(threadRenderer);
    if (!replies) {
      return "";
    }

    return firstText(
      replies.moreText,
      replies.viewReplies,
      getNested(replies, ["viewReplies", "buttonRenderer", "text"]),
      getNested(replies, ["viewReplies", "buttonRenderer", "accessibility", "label"]),
      getNested(replies, ["viewReplies", "buttonRenderer", "accessibilityData", "label"])
    );
  };

  const extractReplyComments = (data, startOrder, parentId) => {
    const comments = [];
    const seen = new Set();
    let order = startOrder;

    walk(data, (node) => {
      const renderer = node.commentRenderer || node.commentViewModel || node.commentEntityPayload;
      const comment = parseCommentRenderer(renderer, order, {
        parentId,
        isReply: true,
        source: "youtubei-reply"
      });

      if (comment && !seen.has(comment.id)) {
        seen.add(comment.id);
        comments.push(comment);
        order += 1;
      }

      return undefined;
    });

    return comments;
  };

  const extractComments = (data, startOrder) => {
    const comments = [];
    const seen = new Set();
    const threadReplyMeta = new Map();
    let order = startOrder;

    walk(data, (node) => {
      const threadRenderer = node.commentThreadRenderer;
      if (!threadRenderer) {
        return undefined;
      }

      const replyContinuationToken = getReplyContinuationToken(threadRenderer);
      const replyCountText = getReplyCountText(threadRenderer);
      const threadCommentId = getThreadCommentId(threadRenderer);
      const replyMeta = {
        replyContinuationToken,
        replyCountText,
        hasReplies: Boolean(replyContinuationToken)
      };
      if (threadCommentId && (replyContinuationToken || replyCountText)) {
        threadReplyMeta.set(threadCommentId, replyMeta);
      }
      const comment = getThreadCommentCandidates(threadRenderer)
        .map((candidate) => parseCommentRenderer(candidate, order, replyMeta))
        .find(Boolean);

      if (comment && !seen.has(comment.id)) {
        seen.add(comment.id);
        comments.push(comment);
        order += 1;
      }

      return false;
    });

    if (comments.length) {
      return comments;
    }

    walk(data, (node) => {
      const renderer = node.commentRenderer || node.commentViewModel || node.commentEntityPayload;
      const comment = parseCommentRenderer(renderer, order);

      if (comment && !seen.has(comment.id)) {
        const replyMeta = threadReplyMeta.get(comment.id);
        if (replyMeta) {
          Object.assign(comment, replyMeta);
        }

        seen.add(comment.id);
        comments.push(comment);
        order += 1;
      }

      return undefined;
    });

    return comments;
  };

  class YouTubeCommentApiSource {
    constructor({ videoId, maxComments, onComment, onStatus }) {
      this.videoId = videoId;
      this.maxComments = maxComments || 500;
      this.onComment = onComment;
      this.onStatus = onStatus;
      this.abortController = null;
      this.disposed = false;
      this.started = false;
      this.config = null;
      this.loadedCount = 0;
      this.order = 0;
      this.replyOrder = 0;
      this.seen = new Set();
      this.replyCache = new Map();
      this.replyInflight = new Map();
      this.fetchLog = {
        responseCount: 0,
        comments: [],
        extractedCount: 0,
        emittedCount: 0,
        duplicateCount: 0,
        skippedByLimitCount: 0,
        loadedCount: 0
      };
    }

    start() {
      if (this.started) {
        return;
      }

      this.started = true;
      this.run();
    }

    async run() {
      try {
        const config = await this.waitForConfig();
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
        this.reportStatus("ready", {
          videoId: this.videoId,
          maxComments: this.maxComments
        });

        let continuation = "";
        for (let attempt = 0; attempt <= INITIAL_EMPTY_RETRY_COUNT; attempt += 1) {
          this.reportStatus(attempt ? "retrying-watch-next" : "fetching-watch-next", {
            loadedCount: this.loadedCount,
            attempt
          });

          const initial = await this.fetchNext(config, {
            videoId: this.videoId,
            contentCheckOk: true,
            racyCheckOk: true
          });
          if (this.disposed || !initial || !this.isCurrentPage()) {
            return;
          }

          const result = this.emitFromResponse(initial);
          continuation = findInitialCommentContinuation(initial);
          this.accumulateFetchResult(result);

          if (continuation || this.loadedCount > 0 || attempt >= INITIAL_EMPTY_RETRY_COUNT) {
            break;
          }

          await sleep(INITIAL_EMPTY_RETRY_MS);
          if (!this.isCurrentPage()) {
            return;
          }
        }

        if (!continuation) {
          this.logFinalFetchResult("continuation-missing");
          this.reportStatus("continuation-missing", { loadedCount: this.loadedCount });
          return;
        }

        while (!this.disposed && continuation && this.loadedCount < this.maxComments) {
          await sleep(PAGE_DELAY_MS);
          if (!this.isCurrentPage()) {
            return;
          }

          const response = await this.fetchNext(config, { continuation });
          if (this.disposed || !response || !this.isCurrentPage()) {
            return;
          }

          const result = this.emitFromResponse(response);
          continuation = findNextContinuation(response);
          this.accumulateFetchResult(result);
        }

        this.logFinalFetchResult(this.loadedCount >= this.maxComments ? "max-comments" : "done");
        this.reportStatus("done", { loadedCount: this.loadedCount });
      } catch (error) {
        if (this.disposed || isAbortError(error)) {
          return;
        }

        this.reportStatus("failed", { message: error && error.message ? error.message : String(error) });
        console.info("[Youtubi] YouTube internal comment source failed", error);
      }
    }

    reportStatus(status, details = {}) {
      const payload = {
        status,
        loadedCount: this.loadedCount,
        ...details
      };

      if (this.onStatus) {
        this.onStatus(payload);
      }

      if (status === "failed" || status === "config-missing") {
        console.info(`[Youtubi] youtubei ${status}`, payload);
      }
    }

    accumulateFetchResult(result) {
      if (!result) {
        return;
      }

      this.fetchLog.responseCount += 1;
      this.fetchLog.comments.push(...(result.comments || []));
      this.fetchLog.extractedCount += result.extractedCount;
      this.fetchLog.emittedCount += result.emittedCount;
      this.fetchLog.duplicateCount += result.duplicateCount;
      this.fetchLog.skippedByLimitCount += result.skippedByLimitCount;
      this.fetchLog.loadedCount = result.loadedCount;
    }

    logFinalFetchResult(reason) {
      if (!this.isCurrentPage()) {
        return;
      }

      const reasonNames = {
        done: t("logReasonDone", null, "All loaded"),
        "max-comments": t("logReasonMaxComments", null, "Comment limit reached"),
        "continuation-missing": t("logReasonContinuationMissing", null, "Comment continuation not found")
      };
      const comments = this.fetchLog.comments;
      const replyEntryCount = comments.filter((comment) => comment && comment.replyContinuationToken).length;

      console.info(t("logCommentsLoaded", null, "[Youtubi] Comments loaded"), {
        [t("logReason", null, "Reason")]: reasonNames[reason] || reason,
        videoId: this.videoId,
        [t("logCommentCount", null, "Comment count")]: comments.length,
        [t("logReplyEntryCount", null, "Comments with reply entry")]: replyEntryCount,
        [t("logCommentData", null, "Comment data")]: comments
      });
    }

    isCurrentPage() {
      try {
        return new URL(location.href).searchParams.get("v") === this.videoId;
      } catch (error) {
        return false;
      }
    }

    async waitForConfig() {
      return innertube.waitForConfig(() => this.disposed);
    }

    async fetchNext(config, body) {
      return innertube.fetchNext(config, body, this.abortController && this.abortController.signal);
    }

    emitFromResponse(response) {
      const extractedComments = extractComments(response, this.order);
      const result = {
        comments: [],
        extractedCount: extractedComments.length,
        emittedCount: 0,
        duplicateCount: 0,
        skippedByLimitCount: 0,
        loadedCount: this.loadedCount,
        maxComments: this.maxComments
      };

      for (let index = 0; index < extractedComments.length; index += 1) {
        const comment = extractedComments[index];
        if (this.loadedCount >= this.maxComments) {
          result.skippedByLimitCount = extractedComments.length - index;
          break;
        }

        this.order += 1;

        if (this.seen.has(comment.id)) {
          result.duplicateCount += 1;
          continue;
        }

        this.seen.add(comment.id);
        this.loadedCount += 1;
        result.emittedCount += 1;
        result.comments.push(comment);

        if (this.onComment) {
          this.onComment(comment);
        }
      }

      result.loadedCount = this.loadedCount;

      return result;
    }

    async loadReplies(comment, options = {}) {
      const continuation = comment && comment.replyContinuationToken;
      if (!continuation || this.disposed || !this.isCurrentPage()) {
        return {
          status: "unavailable",
          parentId: comment && comment.id,
          replies: []
        };
      }

      const cacheKey = comment.id || continuation;
      if (this.replyCache.has(cacheKey)) {
        return this.replyCache.get(cacheKey);
      }

      if (this.replyInflight.has(cacheKey)) {
        return this.replyInflight.get(cacheKey);
      }

      const request = this.fetchReplyPages(comment, continuation, options)
        .then((result) => {
          this.replyCache.set(cacheKey, result);
          return result;
        })
        .finally(() => {
          this.replyInflight.delete(cacheKey);
        });

      this.replyInflight.set(cacheKey, request);
      return request;
    }

    async fetchReplyPages(comment, firstContinuation, options = {}) {
      const config = this.config || await this.waitForConfig();
      if (!config || !config.apiKey || !config.context) {
        throw new Error("youtubei reply config missing");
      }

      this.config = config;
      if (!this.abortController) {
        this.abortController = new AbortController();
      }

      const maxReplies = Math.min(
        MAX_REPLY_COMMENTS,
        Math.max(1, Number(options.maxReplies) || MAX_REPLY_COMMENTS)
      );
      const replies = [];
      const seen = new Set();
      const seenContinuations = new Set();
      let continuation = firstContinuation;

      while (!this.disposed && continuation && replies.length < maxReplies) {
        if (seenContinuations.has(continuation)) {
          break;
        }
        seenContinuations.add(continuation);

        const response = await this.fetchNext(config, { continuation });
        if (this.disposed || !response || !this.isCurrentPage()) {
          break;
        }

        const extractedReplies = extractReplyComments(response, this.replyOrder, comment.id);
        for (const reply of extractedReplies) {
          if (replies.length >= maxReplies) {
            break;
          }

          if (seen.has(reply.id)) {
            continue;
          }

          seen.add(reply.id);
          replies.push(reply);
          this.replyOrder += 1;
        }

        continuation = findNextContinuation(response);
        if (continuation && replies.length < maxReplies) {
          await sleep(PAGE_DELAY_MS);
        }
      }

      return {
        status: "done",
        parentId: comment.id,
        replyCountText: comment.replyCountText || "",
        replies,
        loadedCount: replies.length,
        hasMore: Boolean(continuation && replies.length >= maxReplies)
      };
    }

    dispose() {
      this.disposed = true;

      if (this.abortController) {
        this.abortController.abort();
      }

      this.abortController = null;
      this.onComment = null;
      this.onStatus = null;
      this.config = null;
      this.seen.clear();
      this.replyCache.clear();
      this.replyInflight.clear();
    }
  }

  window.YoutubiYouTubeCommentApiSource = YouTubeCommentApiSource;
})();
