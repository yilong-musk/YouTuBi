(() => {
  const START_OFFSET_SECONDS = 3;
  const END_OFFSET_SECONDS = 5;
  const TICK_MS = 250;
  const SEEK_THRESHOLD_SECONDS = 1.5;
  const LOAD_WINDOW_BACK_SECONDS = 3.5;
  const LOAD_WINDOW_FORWARD_SECONDS = 1.5;
  const SEEK_WINDOW_BACK_SECONDS = 3.5;
  const SEEK_WINDOW_FORWARD_SECONDS = 2;
  const MAX_EMIT_PER_TICK = 6;
  const MAX_EMIT_PER_WINDOW_SYNC = 12;

  const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  class TimelineScheduler {
    constructor({ layer, video }) {
      this.layer = layer;
      this.video = video;
      this.comments = new Map();
      this.timeline = [];
      this.fired = new Set();
      this.timer = 0;
      this.buildTimer = 0;
      this.lastCurrentTime = null;
      this.lastDuration = 0;
      this.pendingWindowSync = null;

      this.start();
    }

    addComment(comment) {
      if (!comment || !comment.id || this.comments.has(comment.id)) {
        return;
      }

      this.comments.set(comment.id, comment);
      this.scheduleBuild();
    }

    start() {
      if (this.timer) {
        return;
      }

      this.timer = window.setInterval(() => this.tick(), TICK_MS);
      this.scheduleBuild();
    }

    scheduleBuild() {
      window.clearTimeout(this.buildTimer);
      this.buildTimer = window.setTimeout(() => {
        this.buildTimer = 0;
        this.rebuildTimeline();
      }, 120);
    }

    rebuildTimeline() {
      const duration = this.getDuration();
      if (!duration) {
        return;
      }

      const comments = Array.from(this.comments.values());
      const validTimedComments = comments.filter((comment) => isFiniteNumber(comment.publishedAt));
      const firstCommentTime = validTimedComments.length
        ? Math.min(...validTimedComments.map((comment) => comment.publishedAt))
        : null;
      const lastCommentTime = validTimedComments.length
        ? Math.max(...validTimedComments.map((comment) => comment.publishedAt))
        : null;
      const hasCommentTimeRange =
        isFiniteNumber(firstCommentTime) && isFiniteNumber(lastCommentTime) && lastCommentTime > firstCommentTime;
      const sorted = comments.slice().sort((left, right) => this.compareComments(left, right));
      const usableDuration = Math.max(1, duration - START_OFFSET_SECONDS - END_OFFSET_SECONDS);

      this.timeline = sorted
        .map((comment, index) => {
          const ratio = hasCommentTimeRange && isFiniteNumber(comment.publishedAt)
            ? (comment.publishedAt - firstCommentTime) / (lastCommentTime - firstCommentTime)
            : this.fallbackRatio(index, sorted.length);

          return {
            id: comment.id,
            text: comment.text,
            comment,
            appearAt: START_OFFSET_SECONDS + clamp(ratio, 0, 1) * usableDuration
          };
        })
        .sort((left, right) => left.appearAt - right.appearAt || left.comment.order - right.comment.order);

      this.lastDuration = duration;
      this.syncToWindow(
        this.getCurrentTime(),
        LOAD_WINDOW_BACK_SECONDS,
        LOAD_WINDOW_FORWARD_SECONDS,
        MAX_EMIT_PER_WINDOW_SYNC,
        false
      );
    }

    compareComments(left, right) {
      const leftTime = isFiniteNumber(left.publishedAt) ? left.publishedAt : Number.POSITIVE_INFINITY;
      const rightTime = isFiniteNumber(right.publishedAt) ? right.publishedAt : Number.POSITIVE_INFINITY;

      return leftTime - rightTime || left.order - right.order;
    }

    fallbackRatio(index, total) {
      if (total <= 1) {
        return 0;
      }

      return index / (total - 1);
    }

    tick() {
      const duration = this.getDuration();
      if (!duration) {
        return;
      }

      if (Math.abs(duration - this.lastDuration) > 1) {
        this.rebuildTimeline();
      }

      const currentTime = this.getCurrentTime();
      if (!isFiniteNumber(currentTime)) {
        return;
      }

      if (this.lastCurrentTime === null) {
        this.lastCurrentTime = currentTime;
        this.syncToWindow(
          currentTime,
          LOAD_WINDOW_BACK_SECONDS,
          LOAD_WINDOW_FORWARD_SECONDS,
          MAX_EMIT_PER_WINDOW_SYNC,
          false
        );
        return;
      }

      const delta = currentTime - this.lastCurrentTime;

      if (Math.abs(delta) > SEEK_THRESHOLD_SECONDS) {
        this.clearLayer();
        this.syncToWindow(
          currentTime,
          SEEK_WINDOW_BACK_SECONDS,
          SEEK_WINDOW_FORWARD_SECONDS,
          MAX_EMIT_PER_WINDOW_SYNC,
          true
        );
        this.lastCurrentTime = currentTime;
        return;
      }

      if (this.video.paused) {
        this.lastCurrentTime = currentTime;
        return;
      }

      if (this.pendingWindowSync) {
        const pending = this.pendingWindowSync;
        this.pendingWindowSync = null;
        this.emitDue(pending.fromTime, pending.toTime, pending.maxCount);
      }

      this.emitDue(this.lastCurrentTime - 0.15, currentTime + 0.25, MAX_EMIT_PER_TICK);
      this.lastCurrentTime = currentTime;
    }

    emitDue(fromTime, toTime, maxCount = MAX_EMIT_PER_TICK) {
      if (!this.layer || !this.timeline.length) {
        return;
      }

      let emitted = 0;

      for (const item of this.timeline) {
        if (this.fired.has(item.id)) {
          continue;
        }

        if (item.appearAt < fromTime) {
          this.fired.add(item.id);
          continue;
        }

        if (item.appearAt > toTime) {
          break;
        }

        if (emitted >= maxCount) {
          break;
        }

        this.fired.add(item.id);
        emitted += 1;
        this.layer.enqueue(item.text, {
          publishedAt: item.comment.publishedAt,
          publishedText: item.comment.publishedText,
          appearAt: item.appearAt
        });
      }
    }

    syncToWindow(currentTime, backSeconds, forwardSeconds, maxCount, resetWindow) {
      if (!isFiniteNumber(currentTime)) {
        return;
      }

      const fromTime = Math.max(0, currentTime - backSeconds);
      const toTime = currentTime + forwardSeconds;
      this.markPastAsFired(fromTime);

      if (resetWindow) {
        this.resetBetween(fromTime, toTime);
      }

      if (!this.video || this.video.paused) {
        this.pendingWindowSync = { fromTime, toTime, maxCount };
        return;
      }

      this.pendingWindowSync = null;
      this.emitDue(fromTime, toTime, maxCount);
    }

    markPastAsFired(currentTime) {
      if (!isFiniteNumber(currentTime)) {
        return;
      }

      for (const item of this.timeline) {
        if (item.appearAt <= currentTime) {
          this.fired.add(item.id);
        } else {
          break;
        }
      }
    }

    resetBetween(fromTime, toTime) {
      if (!isFiniteNumber(fromTime) || !isFiniteNumber(toTime)) {
        return;
      }

      for (const item of this.timeline) {
        if (item.appearAt > toTime) {
          break;
        }

        if (item.appearAt >= fromTime) {
          this.fired.delete(item.id);
        }
      }
    }

    clearLayer() {
      if (this.layer && typeof this.layer.clearActive === "function") {
        this.layer.clearActive();
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
      window.clearInterval(this.timer);
      window.clearTimeout(this.buildTimer);

      this.timer = 0;
      this.buildTimer = 0;
      this.comments.clear();
      this.timeline = [];
      this.fired.clear();
      this.pendingWindowSync = null;
      this.layer = null;
      this.video = null;
    }
  }

  window.YoutubiTimelineScheduler = TimelineScheduler;
})();
