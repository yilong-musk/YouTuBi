(() => {
  const START_OFFSET_SECONDS = 3;
  const END_MARGIN_SECONDS = 0.25;
  const INITIAL_RELEASE_TIMEOUT_MS = 5000;
  const RETRY_RELEASE_MS = 250;
  const LATE_COMMENT_LEAD_SECONDS = 1.25;
  const MIN_LATE_INTERVAL_SECONDS = 0.35;
  const MAX_LATE_INTERVAL_SECONDS = 2;
  const INITIAL_BACKLOG_MIN_TIME_SECONDS = 0.75;

  const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  class TimelineScheduler {
    constructor({ layer, video, onStateChange, autoRelease = true, suppressInitialBacklog = false }) {
      this.layer = layer;
      this.video = video;
      this.onStateChange = onStateChange;
      this.autoReleaseDelay = autoRelease ? INITIAL_RELEASE_TIMEOUT_MS : 0;
      this.suppressInitialBacklog = Boolean(suppressInitialBacklog);
      this.comments = new Map();
      this.timeline = [];
      this.initialReleased = false;
      this.initialReleaseTimer = 0;
      this.frameRequest = 0;
      this.lastDuration = 0;
      this.lastRenderedItems = 0;
      this.nextLateAppearAt = null;
      this.initialReleaseRequested = false;
      this.initiallySuppressedIds = new Set();
      this.initialSuppressionCutoff = null;
      this.boundRender = () => this.renderNow();
      this.boundPlay = () => this.resumePlayback();
      this.boundSeek = () => this.handleSeek();
      this.boundEnded = () => this.finishAtEnd();
      this.boundDurationChange = () => this.handleDurationChange();

      this.start();
    }

    addComment(comment) {
      if (!comment || !comment.id || this.comments.has(comment.id)) {
        return;
      }

      this.comments.set(comment.id, comment);

      if (!this.initialReleased) {
        this.notifyState({ status: "buffering-comments" });
        return;
      }

      this.timeline.push(this.createTimelineItem(comment));
      this.timeline.sort((left, right) => left.appearAt - right.appearAt || this.compareOrder(left, right));
      this.publishTimeline("timeline-updated");
    }

    start() {
      if (!this.video) {
        return;
      }

      this.video.addEventListener("play", this.boundPlay);
      this.video.addEventListener("playing", this.boundPlay);
      this.video.addEventListener("pause", this.boundRender);
      this.video.addEventListener("seeking", this.boundSeek);
      this.video.addEventListener("seeked", this.boundRender);
      this.video.addEventListener("timeupdate", this.boundRender);
      this.video.addEventListener("ended", this.boundEnded);
      this.video.addEventListener("durationchange", this.boundDurationChange);

      if (this.autoReleaseDelay > 0) {
        this.startInitialReleaseTimer(this.autoReleaseDelay, "timeout");
      }
      this.renderNow();
      this.startFrameLoop();
    }

    startInitialReleaseTimer(delay, reason = "timeout") {
      if (this.initialReleased) {
        return;
      }

      window.clearTimeout(this.initialReleaseTimer);
      this.initialReleaseTimer = window.setTimeout(() => {
        this.initialReleaseTimer = 0;
        this.initialReleaseRequested = true;
        this.releaseInitialTimeline(reason);
      }, delay);
    }

    completeInitialLoad(reason = "source-done") {
      this.initialReleaseRequested = true;
      this.releaseInitialTimeline(reason);
    }

    releaseInitialTimeline(reason) {
      if (this.initialReleased) {
        return;
      }

      const duration = this.getDuration();
      if (!duration) {
        this.startInitialReleaseTimer(RETRY_RELEASE_MS, reason);
        return;
      }

      window.clearTimeout(this.initialReleaseTimer);
      this.initialReleaseTimer = 0;

      this.timeline = this.buildTimeline(duration);
      this.suppressInitialBacklogItems();
      this.initialReleased = true;
      this.lastDuration = duration;
      this.nextLateAppearAt = this.getFutureStartTime();
      this.publishTimeline(`timeline-ready:${reason}`);
    }

    rebuildTimeline(reason = "timeline-rebuilt") {
      if (!this.initialReleased) {
        if (this.initialReleaseRequested) {
          this.releaseInitialTimeline(reason);
        }
        return;
      }

      const duration = this.getDuration();
      if (!duration) {
        return;
      }

      this.timeline = this.buildTimeline(duration);
      this.initiallySuppressedIds.clear();
      this.initialSuppressionCutoff = null;
      this.lastDuration = duration;
      this.nextLateAppearAt = this.getFutureStartTime();
      this.publishTimeline(reason);
    }

    suppressInitialBacklogItems() {
      this.initiallySuppressedIds.clear();

      if (!this.suppressInitialBacklog) {
        return;
      }

      const currentTime = this.getCurrentTime();
      if (!isFiniteNumber(currentTime) || currentTime < INITIAL_BACKLOG_MIN_TIME_SECONDS) {
        return;
      }

      this.initialSuppressionCutoff = currentTime;
      this.timeline.forEach((item) => {
        if (!item || !item.comment) {
          return;
        }

        const travelDuration = this.getTravelDuration(item.comment);
        if (
          item.comment.source === "live-chat-replay" &&
          isFiniteNumber(item.appearAt) &&
          isFiniteNumber(travelDuration) &&
          item.appearAt + travelDuration < currentTime
        ) {
          this.initiallySuppressedIds.add(item.id);
        }
      });
    }

    buildTimeline(duration) {
      const sorted = Array.from(this.comments.values()).sort((left, right) => this.compareComments(left, right));

      return sorted
        .map((comment, index) => {
          if (isFiniteNumber(comment.appearAt)) {
            return this.createTimelineItem(comment, duration);
          }

          const travelDuration = this.getTravelDuration(comment);
          const latestAppearAt = this.getLatestAppearAt(duration, travelDuration);
          const ratio = this.fallbackRatio(index, sorted.length);
          const firstAppearAt = Math.min(START_OFFSET_SECONDS, latestAppearAt);
          const firstFinishAt = firstAppearAt + travelDuration;
          const latestFinishAt = Math.max(firstFinishAt, duration - END_MARGIN_SECONDS);
          const targetFinishAt = firstFinishAt + clamp(ratio, 0, 1) * (latestFinishAt - firstFinishAt);

          return {
            id: comment.id,
            text: comment.text,
            comment,
            order: comment.order,
            appearAt: Math.min(latestAppearAt, Math.max(0, targetFinishAt - travelDuration))
          };
        })
        .sort((left, right) => left.appearAt - right.appearAt || this.compareOrder(left, right));
    }

    createTimelineItem(comment, duration = null) {
      if (isFiniteNumber(comment.appearAt)) {
        const timelineDuration = duration || this.getDuration() || this.lastDuration || 1;
        const travelDuration = this.getTravelDuration(comment);
        const latestAppearAt = this.getLatestAppearAt(timelineDuration, travelDuration);
        return {
          id: comment.id,
          text: comment.text,
          comment,
          order: comment.order,
          appearAt: clamp(comment.appearAt, 0, latestAppearAt)
        };
      }

      return this.createLateTimelineItem(comment);
    }

    createLateTimelineItem(comment) {
      const duration = this.getDuration() || this.lastDuration || 1;
      const currentTime = this.getCurrentTime() || 0;
      const interval = this.getLateInterval(duration);
      const travelDuration = this.getTravelDuration(comment);
      const latestUsefulTime = this.getLatestAppearAt(duration, travelDuration);
      const preferredTime = Math.max(
        Math.min(START_OFFSET_SECONDS, latestUsefulTime),
        currentTime + LATE_COMMENT_LEAD_SECONDS,
        isFiniteNumber(this.nextLateAppearAt) ? this.nextLateAppearAt : 0
      );
      const appearAt = Math.min(preferredTime, latestUsefulTime);

      this.nextLateAppearAt = preferredTime + interval;

      return {
        id: comment.id,
        text: comment.text,
        comment,
        order: comment.order,
        appearAt
      };
    }

    getFutureStartTime() {
      const currentTime = this.getCurrentTime() || 0;
      const duration = this.getDuration() || this.lastDuration || 1;
      const latestAppearAt = this.getLatestAppearAt(duration, this.getMaxTravelDuration(this.comments.values()));
      return Math.min(
        latestAppearAt,
        Math.max(Math.min(START_OFFSET_SECONDS, latestAppearAt), currentTime + LATE_COMMENT_LEAD_SECONDS)
      );
    }

    getLateInterval(duration) {
      const latestAppearAt = this.getLatestAppearAt(duration, this.getMaxTravelDuration(this.comments.values()));
      const firstAppearAt = Math.min(START_OFFSET_SECONDS, latestAppearAt);
      const usableDuration = Math.max(1, latestAppearAt - firstAppearAt);
      return clamp(
        usableDuration / Math.max(1, this.comments.size),
        MIN_LATE_INTERVAL_SECONDS,
        MAX_LATE_INTERVAL_SECONDS
      );
    }

    getTravelDuration(value) {
      const text = value && typeof value === "object" ? value.text : value;
      const fragments = value && typeof value === "object" ? value.fragments : null;
      if (this.layer && typeof this.layer.getTravelDuration === "function") {
        return this.layer.getTravelDuration(text, fragments);
      }

      return MAX_LATE_INTERVAL_SECONDS;
    }

    getMaxTravelDuration(comments) {
      return Array.from(comments).reduce((maxDuration, comment) => {
        const travelDuration = this.getTravelDuration(comment);
        return isFiniteNumber(travelDuration) ? Math.max(maxDuration, travelDuration) : maxDuration;
      }, 0);
    }

    getLatestAppearAt(duration, travelDuration) {
      const latestAppearAt = duration - END_MARGIN_SECONDS - Math.max(0, travelDuration || 0);
      return Math.max(0, latestAppearAt);
    }

    publishTimeline(status) {
      if (this.layer && typeof this.layer.setTimeline === "function") {
        this.layer.setTimeline(this.getRenderableTimeline());
      }

      this.renderNow();
      this.notifyState({ status });
    }

    getRenderableTimeline() {
      if (!this.initiallySuppressedIds.size) {
        return this.timeline;
      }

      return this.timeline.filter((item) => !this.initiallySuppressedIds.has(item.id));
    }

    handleDurationChange() {
      const duration = this.getDuration();
      if (!duration) {
        return;
      }

      this.lastDuration = duration;

      if (!this.initialReleased) {
        if (this.initialReleaseRequested) {
          this.releaseInitialTimeline("duration-ready");
        }
        return;
      }

      this.rebuildTimeline("duration-updated");
    }

    handleLayoutTimingChange(reason = "layout-updated") {
      this.rebuildTimeline(reason);
    }

    compareComments(left, right) {
      const leftAppearAt = isFiniteNumber(left.appearAt) ? left.appearAt : Number.POSITIVE_INFINITY;
      const rightAppearAt = isFiniteNumber(right.appearAt) ? right.appearAt : Number.POSITIVE_INFINITY;
      if (leftAppearAt !== Number.POSITIVE_INFINITY || rightAppearAt !== Number.POSITIVE_INFINITY) {
        return leftAppearAt - rightAppearAt || this.compareOrder(left, right);
      }

      const leftTime = isFiniteNumber(left.publishedAt) ? left.publishedAt : Number.POSITIVE_INFINITY;
      const rightTime = isFiniteNumber(right.publishedAt) ? right.publishedAt : Number.POSITIVE_INFINITY;

      return leftTime - rightTime || this.compareOrder(left, right);
    }

    compareOrder(left, right) {
      const leftOrder = isFiniteNumber(left.order) ? left.order : 0;
      const rightOrder = isFiniteNumber(right.order) ? right.order : 0;

      return leftOrder - rightOrder;
    }

    fallbackRatio(index, total) {
      if (total <= 1) {
        return 0;
      }

      return index / (total - 1);
    }

    startFrameLoop() {
      if (this.frameRequest || !this.video) {
        return;
      }

      this.frameRequest = window.requestAnimationFrame(() => this.frame());
    }

    frame() {
      this.frameRequest = 0;
      this.renderNow();

      if (this.video && !this.video.paused && !this.video.ended) {
        this.startFrameLoop();
      }
    }

    resumePlayback() {
      this.startFrameLoop();
    }

    handleSeek() {
      const currentTime = this.getCurrentTime();
      if (
        this.initiallySuppressedIds.size &&
        isFiniteNumber(currentTime) &&
        isFiniteNumber(this.initialSuppressionCutoff) &&
        currentTime <= this.initialSuppressionCutoff
      ) {
        this.clearInitialSuppression();
      }
      this.renderNow();
    }

    clearInitialSuppression() {
      this.initiallySuppressedIds.clear();
      this.initialSuppressionCutoff = null;

      if (this.layer && typeof this.layer.setTimeline === "function") {
        this.layer.setTimeline(this.timeline);
      }
    }

    finishAtEnd() {
      if (this.layer && typeof this.layer.renderAt === "function") {
        const duration = this.getDuration();
        if (typeof this.layer.clearHoverPauses === "function") {
          this.layer.clearHoverPauses();
        }
        this.layer.renderAt((duration || this.lastDuration || 0) + END_MARGIN_SECONDS);
      } else {
        this.clearLayer();
      }

      this.lastRenderedItems = 0;
      this.notifyState({ status: "ended" });
    }

    renderNow() {
      if (!this.layer || !this.video) {
        return;
      }

      const duration = this.getDuration();
      if (duration && this.lastDuration && Math.abs(duration - this.lastDuration) > 1) {
        this.handleDurationChange();
        return;
      }

      const currentTime = this.getCurrentTime();
      if (!isFiniteNumber(currentTime)) {
        return;
      }

      if (typeof this.layer.renderAt === "function") {
        const renderedItems = this.layer.renderAt(currentTime);
        if (renderedItems !== this.lastRenderedItems) {
          this.lastRenderedItems = renderedItems;
          this.notifyState({ status: "rendered" });
        }
      }
    }

    clearLayer() {
      if (this.layer && typeof this.layer.clearActive === "function") {
        this.layer.clearActive();
      }
    }

    pauseLayer() {
      if (this.layer && typeof this.layer.pause === "function") {
        this.layer.pause();
      }
    }

    resumeLayer() {
      if (this.layer && typeof this.layer.resume === "function") {
        this.layer.resume();
      }
    }

    reset(reason = "reset", options = {}) {
      window.clearTimeout(this.initialReleaseTimer);
      if (Object.prototype.hasOwnProperty.call(options, "autoRelease")) {
        this.autoReleaseDelay = options.autoRelease ? INITIAL_RELEASE_TIMEOUT_MS : 0;
      }

      this.comments.clear();
      this.timeline = [];
      this.initialReleased = false;
      this.initialReleaseRequested = false;
      this.initialReleaseTimer = 0;
      this.lastRenderedItems = 0;
      this.nextLateAppearAt = null;
      this.initiallySuppressedIds.clear();
      this.initialSuppressionCutoff = null;

      if (this.layer && typeof this.layer.setTimeline === "function") {
        this.layer.setTimeline([]);
      } else {
        this.clearLayer();
      }

      if (this.autoReleaseDelay > 0) {
        this.startInitialReleaseTimer(this.autoReleaseDelay, "timeout");
      }
      this.renderNow();
      this.notifyState({ status: reason });
    }

    notifyState(updates = {}) {
      if (this.onStateChange) {
        this.onStateChange(updates);
      }
    }

    getCurrentTime() {
      return this.video && isFiniteNumber(this.video.currentTime) ? this.video.currentTime : null;
    }

    getDuration() {
      const duration = this.video && this.video.duration;
      return isFiniteNumber(duration) && duration > 0 ? duration : null;
    }

    dispose() {
      window.clearTimeout(this.initialReleaseTimer);

      if (this.frameRequest) {
        window.cancelAnimationFrame(this.frameRequest);
      }

      if (this.video) {
        this.video.removeEventListener("play", this.boundPlay);
        this.video.removeEventListener("playing", this.boundPlay);
        this.video.removeEventListener("pause", this.boundRender);
        this.video.removeEventListener("seeking", this.boundSeek);
        this.video.removeEventListener("seeked", this.boundRender);
        this.video.removeEventListener("timeupdate", this.boundRender);
        this.video.removeEventListener("ended", this.boundEnded);
        this.video.removeEventListener("durationchange", this.boundDurationChange);
      }

      this.initialReleaseTimer = 0;
      this.frameRequest = 0;
      this.comments.clear();
      this.timeline = [];
      this.initiallySuppressedIds.clear();
      this.initialSuppressionCutoff = null;
      this.clearLayer();
      this.layer = null;
      this.video = null;
      this.onStateChange = null;
    }
  }

  window.YoutubiTimelineScheduler = TimelineScheduler;
})();
