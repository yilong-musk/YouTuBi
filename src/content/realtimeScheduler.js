(() => {
  const FIRST_APPEAR_DELAY_SECONDS = 0.15;
  const MIN_INTERVAL_SECONDS = 0.18;
  const MAX_INTERVAL_SECONDS = 0.9;
  const MAX_BACKLOG_SECONDS = 14;
  const MAX_FUTURE_ITEMS = 160;
  const MAX_COMMENT_MEMORY = 800;
  const PUBLISH_DELAY_MS = 50;

  const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  class RealtimeScheduler {
    constructor({ layer, video, onStateChange }) {
      this.layer = layer;
      this.video = video;
      this.onStateChange = onStateChange;
      this.comments = new Map();
      this.timeline = [];
      this.frameRequest = 0;
      this.publishTimer = 0;
      this.startedAt = performance.now();
      this.pausedAt = 0;
      this.pausedTotalMs = 0;
      this.paused = Boolean(video && video.paused);
      this.nextAppearAt = 0;
      this.order = 0;
      this.lastRenderedItems = 0;
      this.droppedCount = 0;
      this.boundRender = () => this.renderNow();
      this.boundPlay = () => this.resumePlayback();
      this.boundPause = () => this.pausePlayback();
      this.boundEnded = () => this.clearLayer();

      if (this.paused) {
        this.pausedAt = performance.now();
      }

      this.start();
    }

    start() {
      if (!this.video) {
        return;
      }

      this.video.addEventListener("play", this.boundPlay);
      this.video.addEventListener("playing", this.boundPlay);
      this.video.addEventListener("pause", this.boundPause);
      this.video.addEventListener("ended", this.boundEnded);

      this.publishTimeline("realtime-ready");
      if (!this.paused) {
        this.startFrameLoop();
      }
    }

    addComment(comment) {
      if (!comment || !comment.id || this.comments.has(comment.id)) {
        return;
      }

      const now = this.getCurrentTime();
      const futureCount = this.countFutureItems(now);
      const backlog = Math.max(0, this.nextAppearAt - now);
      if (futureCount >= MAX_FUTURE_ITEMS || backlog >= MAX_BACKLOG_SECONDS) {
        this.droppedCount += 1;
        this.notifyState({
          status: "realtime-dropped",
          liveChatDropped: this.droppedCount,
          liveChatQueued: futureCount
        });
        return;
      }

      const order = isFiniteNumber(comment.order) ? comment.order : this.order;
      this.order = Math.max(this.order + 1, order + 1);
      this.comments.set(comment.id, comment);
      this.trimComments();

      const interval = this.getInterval(futureCount);
      const appearAt = Math.max(
        now + FIRST_APPEAR_DELAY_SECONDS,
        isFiniteNumber(this.nextAppearAt) ? this.nextAppearAt : 0
      );
      this.nextAppearAt = appearAt + interval;
      this.timeline.push({
        id: comment.id,
        text: comment.text,
        comment,
        order,
        appearAt
      });
      this.timeline.sort((left, right) => left.appearAt - right.appearAt || left.order - right.order);
      this.pruneTimeline(now);
      this.schedulePublish("realtime-comment");
    }

    getInterval(futureCount) {
      return clamp(MAX_INTERVAL_SECONDS - futureCount * 0.012, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
    }

    countFutureItems(now) {
      return this.timeline.reduce((count, item) => count + (item.appearAt >= now ? 1 : 0), 0);
    }

    trimComments() {
      if (this.comments.size <= MAX_COMMENT_MEMORY) {
        return;
      }

      const overflow = this.comments.size - MAX_COMMENT_MEMORY;
      const iterator = this.comments.keys();
      for (let index = 0; index < overflow; index += 1) {
        const next = iterator.next();
        if (next.done) {
          break;
        }
        this.comments.delete(next.value);
      }
    }

    pruneTimeline(now = this.getCurrentTime()) {
      const previousLength = this.timeline.length;
      this.timeline = this.timeline.filter((item) => {
        if (item.appearAt >= now) {
          return true;
        }

        const duration = this.getTravelDuration(item.comment || item.text);
        return now - item.appearAt <= duration + 1;
      });

      return previousLength !== this.timeline.length;
    }

    getTravelDuration(value) {
      const text = value && typeof value === "object" ? value.text : value;
      const fragments = value && typeof value === "object" ? value.fragments : null;
      if (this.layer && typeof this.layer.getTravelDuration === "function") {
        return this.layer.getTravelDuration(text, fragments);
      }

      return 8;
    }

    schedulePublish(status) {
      window.clearTimeout(this.publishTimer);
      this.publishTimer = window.setTimeout(() => {
        this.publishTimer = 0;
        this.publishTimeline(status);
      }, PUBLISH_DELAY_MS);
    }

    publishTimeline(status) {
      if (this.layer && typeof this.layer.setTimeline === "function") {
        this.layer.setTimeline(this.timeline);
      }

      this.renderNow();
      this.notifyState({
        status,
        liveChatQueued: this.countFutureItems(this.getCurrentTime()),
        liveChatDropped: this.droppedCount
      });
    }

    handleLayoutTimingChange(reason = "realtime-layout-updated") {
      this.pruneTimeline();
      this.publishTimeline(reason);
    }

    renderNow() {
      if (!this.layer) {
        return;
      }

      const now = this.getCurrentTime();
      const removed = this.pruneTimeline(now);
      if (removed && !this.publishTimer && this.layer && typeof this.layer.setTimeline === "function") {
        this.layer.setTimeline(this.timeline);
      }

      if (typeof this.layer.renderAt === "function") {
        const renderedItems = this.layer.renderAt(now);
        if (renderedItems !== this.lastRenderedItems) {
          this.lastRenderedItems = renderedItems;
          this.notifyState({
            status: "realtime-rendered",
            liveChatQueued: this.countFutureItems(now),
            liveChatDropped: this.droppedCount
          });
        }
      }
    }

    startFrameLoop() {
      if (this.frameRequest || this.paused || !this.video) {
        return;
      }

      this.frameRequest = window.requestAnimationFrame(() => this.frame());
    }

    frame() {
      this.frameRequest = 0;
      this.renderNow();

      if (!this.paused && this.video && !this.video.ended) {
        this.startFrameLoop();
      }
    }

    pausePlayback() {
      if (this.paused) {
        return;
      }

      this.paused = true;
      this.pausedAt = performance.now();
      if (this.frameRequest) {
        window.cancelAnimationFrame(this.frameRequest);
        this.frameRequest = 0;
      }
      this.renderNow();
      this.notifyState({ status: "realtime-paused" });
    }

    resumePlayback() {
      if (this.paused) {
        this.pausedTotalMs += Math.max(0, performance.now() - this.pausedAt);
        this.pausedAt = 0;
        this.paused = false;
      }

      const now = this.getCurrentTime();
      this.timeline = this.timeline.filter((item) =>
        item.appearAt >= now || now - item.appearAt <= this.getTravelDuration(item.comment || item.text)
      );
      this.nextAppearAt = Math.max(now + FIRST_APPEAR_DELAY_SECONDS, this.nextAppearAt);
      this.publishTimeline("realtime-resumed");
      this.startFrameLoop();
    }

    clearLayer() {
      if (this.layer && typeof this.layer.clearHoverPauses === "function") {
        this.layer.clearHoverPauses();
      }
      if (this.layer && typeof this.layer.clearActive === "function") {
        this.layer.clearActive();
      }

      this.lastRenderedItems = 0;
      this.notifyState({ status: "realtime-ended" });
    }

    reset(reason = "realtime-reset") {
      window.clearTimeout(this.publishTimer);
      this.comments.clear();
      this.timeline = [];
      this.nextAppearAt = this.getCurrentTime();
      this.lastRenderedItems = 0;
      this.droppedCount = 0;
      this.clearLayer();
      this.publishTimeline(reason);
    }

    notifyState(updates = {}) {
      if (this.onStateChange) {
        this.onStateChange(updates);
      }
    }

    getCurrentTime() {
      const now = this.paused && this.pausedAt ? this.pausedAt : performance.now();
      return Math.max(0, (now - this.startedAt - this.pausedTotalMs) / 1000);
    }

    dispose() {
      window.clearTimeout(this.publishTimer);

      if (this.frameRequest) {
        window.cancelAnimationFrame(this.frameRequest);
      }

      if (this.video) {
        this.video.removeEventListener("play", this.boundPlay);
        this.video.removeEventListener("playing", this.boundPlay);
        this.video.removeEventListener("pause", this.boundPause);
        this.video.removeEventListener("ended", this.boundEnded);
      }

      this.publishTimer = 0;
      this.frameRequest = 0;
      this.comments.clear();
      this.timeline = [];
      this.clearLayer();
      this.layer = null;
      this.video = null;
      this.onStateChange = null;
    }
  }

  window.YoutubiRealtimeScheduler = RealtimeScheduler;
})();
