const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const CONTENT = path.join(ROOT, "src", "content");

function loadContext() {
  let now = 0;
  const window = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const sandbox = {
    window,
    document: {},
    console,
    performance: { now: () => now },
    Math,
    Number,
    Set,
    Map,
    Boolean,
    Array,
    Object,
    String,
    isFinite,
    Infinity,
    NaN
  };

  const context = vm.createContext(sandbox);
  for (const file of ["adWatcher.js", "timelineScheduler.js", "realtimeScheduler.js"]) {
    const code = fs.readFileSync(path.join(CONTENT, file), "utf8");
    vm.runInContext(code, context, { filename: file });
  }

  return {
    window,
    advance: (ms) => {
      now += ms;
    }
  };
}

function createVideo({ duration = 600, currentTime = 0, paused = false } = {}) {
  const listeners = new Map();
  return {
    duration,
    currentTime,
    paused,
    ended: false,
    addEventListener(type, handler) {
      if (!listeners.has(type)) {
        listeners.set(type, []);
      }
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index >= 0) {
        list.splice(index, 1);
      }
    },
    dispatch(type) {
      for (const handler of listeners.get(type) || []) {
        handler({ type });
      }
    }
  };
}

function createLayer() {
  return {
    timeline: [],
    setTimeline(items) {
      this.timeline = items.slice();
    },
    renderAt() {
      return 0;
    },
    clearActive() {},
    clearHoverPauses() {},
    getTravelDuration() {
      return 8;
    }
  };
}

function createPlayer(isAd = false) {
  const classes = new Set(isAd ? ["ad-showing"] : []);
  return {
    classes,
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name)
    },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {}
  };
}

function createComments(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    text: `弹幕 ${index}`,
    source: "comment",
    order: index
  }));
}

function testTimelineNotCompressedByAds() {
  const { window } = loadContext();
  const video = createVideo({ duration: 600 });
  const layer = createLayer();
  const scheduler = new window.YoutubiTimelineScheduler({
    layer,
    video,
    autoRelease: false,
    suppressInitialBacklog: false
  });

  for (const comment of createComments(60)) {
    scheduler.addComment(comment);
  }
  scheduler.completeInitialLoad("test");

  const before = scheduler.timeline.map((item) => item.appearAt);
  const lastBefore = Math.max(...before);
  assert(lastBefore > 550, `内容时间线应铺满 600s，实际最晚 ${lastBefore}`);

  // 广告开始：同一个 <video> 的 duration / currentTime 变成广告自己的
  scheduler.setAdShowing(true);
  video.duration = 20;
  video.currentTime = 0;
  video.dispatch("durationchange");
  scheduler.renderNow();

  const duringAd = scheduler.timeline.map((item) => item.appearAt);
  assert.deepStrictEqual(
    duringAd,
    before,
    "广告期间不应按广告时长重建时间线（否则弹幕会被压缩进广告时段）"
  );
  assert(
    Math.max(...duringAd) > 550,
    "广告期间时间线仍应保持内容时长，而不是被压到 20s 内"
  );

  // 广告结束：恢复内容时长，时间线恢复正常
  scheduler.setAdShowing(false);
  video.duration = 600;
  video.currentTime = 300;
  video.dispatch("durationchange");

  const afterAd = scheduler.timeline.map((item) => item.appearAt);
  assert(
    Math.max(...afterAd) > 550,
    "广告结束后时间线应恢复到内容时长"
  );

  scheduler.dispose();
  console.log("PASS timeline: 广告不会压缩弹幕时间线");
}

function testPreRollAdDoesNotCompressInitialTimeline() {
  const { window } = loadContext();
  const video = createVideo({ duration: 20 });
  const layer = createLayer();
  const scheduler = new window.YoutubiTimelineScheduler({
    layer,
    video,
    autoRelease: false,
    suppressInitialBacklog: false
  });

  scheduler.setAdShowing(true);
  for (const comment of createComments(30)) {
    scheduler.addComment(comment);
  }
  scheduler.completeInitialLoad("test");

  assert.strictEqual(scheduler.initialReleased, false, "前置广告期间不应以广告时长释放时间线");
  assert.strictEqual(scheduler.timeline.length, 0, "前置广告期间不应生成压缩时间线");

  video.duration = 600;
  video.currentTime = 0;
  scheduler.setAdShowing(false);

  assert.strictEqual(scheduler.initialReleased, true, "广告结束后应释放时间线");
  assert(
    Math.max(...scheduler.timeline.map((item) => item.appearAt)) > 550,
    "广告结束后应按内容时长铺开，而不是按广告时长压缩"
  );

  scheduler.dispose();
  console.log("PASS timeline: 前置广告不会压缩初始时间线");
}

function testRealtimeClockFrozenDuringAds() {
  const { window, advance } = loadContext();
  const video = createVideo({ duration: 600, paused: false });
  const layer = createLayer();
  const scheduler = new window.YoutubiRealtimeScheduler({ layer, video });

  advance(60000);
  assert(Math.abs(scheduler.getCurrentTime() - 60) < 0.01, "初始时钟应为 60s");

  scheduler.setAdShowing(true);
  advance(30000);
  assert(
    Math.abs(scheduler.getCurrentTime() - 60) < 0.01,
    "广告期间实时时钟应冻结在 60s"
  );

  const droppedBefore = scheduler.droppedCount;
  scheduler.addComment({ id: "ad-comment", text: "广告期间的聊天", order: 1 });
  assert.strictEqual(scheduler.droppedCount, droppedBefore + 1, "广告期间的新聊天应被丢弃而不是排队");

  scheduler.setAdShowing(false);
  assert(
    Math.abs(scheduler.getCurrentTime() - 60) < 0.01,
    "广告结束后实时时钟不应把广告时长计入播放时间"
  );

  scheduler.dispose();
  console.log("PASS realtime: 广告期间时钟冻结、聊天不堆积");
}

function testAdWatcherReportsTransitions() {
  const { window } = loadContext();
  const player = createPlayer(false);
  const events = [];
  const watcher = new window.YoutubiAdWatcher({
    player,
    video: createVideo(),
    onChange: (showing) => events.push(showing)
  });

  watcher.start();
  assert.strictEqual(watcher.isAdShowing(), false, "初始不应误判为广告");

  player.classList.add("ad-showing");
  watcher.evaluate();
  assert.strictEqual(watcher.isAdShowing(), true, "广告 class 出现时应识别为广告");

  player.classList.remove("ad-showing");
  watcher.evaluate();

  assert.deepStrictEqual(events, [true, false], "应只在状态切换时回调一次");

  watcher.dispose();
  console.log("PASS adWatcher: 正确上报广告开始/结束");
}

testTimelineNotCompressedByAds();
testPreRollAdDoesNotCompressInitialTimeline();
testRealtimeClockFrozenDuringAds();
testAdWatcherReportsTransitions();
console.log("全部广告兼容测试通过");
