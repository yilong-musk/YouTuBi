(() => {
  const TIMELINE_RELEASE_TIMEOUT_MS = 5000;

  class DanmakuPlaybackController {
    constructor({ layer, video, onStateChange }) {
      this.layer = layer;
      this.realtimeLayer = layer && layer.playerElement
        ? new window.YoutubiDanmakuLayer(layer.playerElement, layer.settings || {})
        : null;
      this.video = video;
      this.onStateChange = onStateChange;
      this.timelineSources = new Set();
      this.completedTimelineSources = new Set();
      this.timelineScheduler = new window.YoutubiTimelineScheduler({
        layer,
        video,
        autoRelease: true,
        suppressInitialBacklog: true,
        onStateChange: (updates) => this.notifyState(updates)
      });
      this.realtimeScheduler = new window.YoutubiRealtimeScheduler({
        layer: this.realtimeLayer || layer,
        video,
        onStateChange: (updates) => this.notifyState(updates)
      });

      this.timelineScheduler.startInitialReleaseTimer(
        TIMELINE_RELEASE_TIMEOUT_MS,
        "source-timeout"
      );
    }

    addTimelineSource(sourceName) {
      if (!sourceName || this.completedTimelineSources.has(sourceName)) {
        return;
      }

      this.timelineSources.add(sourceName);
      this.notifyState({
        status: `${sourceName}-pending`,
        timelineSourcesPending: this.timelineSources.size
      });
    }

    completeTimelineSource(sourceName, reason = "done") {
      if (!sourceName || this.completedTimelineSources.has(sourceName)) {
        return;
      }

      this.completedTimelineSources.add(sourceName);
      this.timelineSources.delete(sourceName);
      this.notifyState({
        status: `${sourceName}-done`,
        timelineSourcesPending: this.timelineSources.size
      });

      if (!this.timelineSources.size && this.timelineScheduler) {
        this.timelineScheduler.completeInitialLoad(`${sourceName}:${reason}`);
      }
    }

    addTimelineItem(item) {
      if (this.timelineScheduler) {
        this.timelineScheduler.addComment(item);
      }
    }

    addRealtimeItem(item) {
      if (this.realtimeScheduler) {
        this.realtimeScheduler.addComment(item);
      }
    }

    handleLayoutTimingChange(reason = "playback-layout-updated") {
      if (this.timelineScheduler && typeof this.timelineScheduler.handleLayoutTimingChange === "function") {
        this.timelineScheduler.handleLayoutTimingChange(reason);
      }

      if (this.realtimeScheduler && typeof this.realtimeScheduler.handleLayoutTimingChange === "function") {
        this.realtimeScheduler.handleLayoutTimingChange(reason);
      }
    }

    setSettings(settings) {
      if (this.layer && typeof this.layer.setSettings === "function") {
        this.layer.setSettings(settings);
      }

      if (this.realtimeLayer && typeof this.realtimeLayer.setSettings === "function") {
        this.realtimeLayer.setSettings(settings);
      }

      this.handleLayoutTimingChange("settings-updated");
    }

    resetTimeline(reason = "timeline-reset", options = {}) {
      if (this.timelineScheduler && typeof this.timelineScheduler.reset === "function") {
        this.timelineScheduler.reset(reason, options);
      }
    }

    countFutureItems(now) {
      return this.realtimeScheduler && typeof this.realtimeScheduler.countFutureItems === "function"
        ? this.realtimeScheduler.countFutureItems(now)
        : 0;
    }

    getCurrentTime() {
      return this.realtimeScheduler && typeof this.realtimeScheduler.getCurrentTime === "function"
        ? this.realtimeScheduler.getCurrentTime()
        : 0;
    }

    get comments() {
      return this.timelineScheduler ? this.timelineScheduler.comments : null;
    }

    get timeline() {
      return this.timelineScheduler ? this.timelineScheduler.timeline : [];
    }

    get droppedCount() {
      return this.realtimeScheduler && typeof this.realtimeScheduler.droppedCount === "number"
        ? this.realtimeScheduler.droppedCount
        : 0;
    }

    notifyState(updates = {}) {
      if (this.onStateChange) {
        this.onStateChange(updates);
      }
    }

    dispose() {
      if (this.timelineScheduler) {
        this.timelineScheduler.dispose();
      }

      if (this.realtimeScheduler) {
        this.realtimeScheduler.dispose();
      }

      if (this.realtimeLayer) {
        this.realtimeLayer.dispose();
      }

      this.timelineSources.clear();
      this.completedTimelineSources.clear();
      this.timelineScheduler = null;
      this.realtimeScheduler = null;
      this.realtimeLayer = null;
      this.layer = null;
      this.video = null;
      this.onStateChange = null;
    }
  }

  window.YoutubiDanmakuPlaybackController = DanmakuPlaybackController;
})();
