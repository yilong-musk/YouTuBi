const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CONTENT = path.join(__dirname, "..", "src", "content");

function loadAdSpeedup() {
  let timerId = 0;
  const window = {
    setInterval: () => {
      timerId += 1;
      return timerId;
    },
    clearInterval: () => {}
  };

  const context = vm.createContext({
    window,
    console,
    Math,
    Number,
    Boolean,
    Object,
    String
  });

  vm.runInContext(fs.readFileSync(path.join(CONTENT, "adSpeedup.js"), "utf8"), context, {
    filename: "adSpeedup.js"
  });

  return window;
}

function createVideo() {
  const listeners = new Map();
  return {
    playbackRate: 1,
    muted: false,
    volume: 0.8,
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
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    }
  };
}

function createPlayer({ skipVisible = true } = {}) {
  const skipButton = {
    offsetParent: {},
    disabled: false,
    clicks: 0,
    click() {
      this.clicks += 1;
    }
  };

  return {
    skipButton,
    querySelector(selector) {
      if (selector === ".ytp-ad-skip-button" && skipVisible) {
        return skipButton;
      }
      return null;
    }
  };
}

function testSpeedsUpAndRestores() {
  const window = loadAdSpeedup();
  const video = createVideo();
  const player = createPlayer();
  const speedup = new window.YoutubiAdSpeedup({ player, video, settings: { adSpeedup: true } });

  speedup.setAdShowing(true);
  assert.strictEqual(video.playbackRate, 16, "广告期间应设为 16 倍速");
  assert.strictEqual(video.muted, true, "广告期间应静音");
  assert(player.skipButton.clicks >= 1, "广告期间应点击跳过按钮");

  speedup.setAdShowing(false);
  assert.strictEqual(video.playbackRate, 1, "广告结束后应恢复原倍速");
  assert.strictEqual(video.muted, false, "广告结束后应恢复原静音状态");
  assert.strictEqual(video.listenerCount("ratechange"), 0, "广告结束后应移除 ratechange 监听");

  speedup.dispose();
  console.log("PASS adSpeedup: 广告 16 倍速 + 静音 + 点跳过，结束后恢复");
}

function testRespectsDisabledSetting() {
  const window = loadAdSpeedup();
  const video = createVideo();
  const player = createPlayer();
  const speedup = new window.YoutubiAdSpeedup({ player, video, settings: { adSpeedup: false } });

  speedup.setAdShowing(true);
  assert.strictEqual(video.playbackRate, 1, "开关关闭时不应改倍速");
  assert.strictEqual(video.muted, false, "开关关闭时不应静音");
  assert.strictEqual(player.skipButton.clicks, 0, "开关关闭时不应点跳过");

  speedup.dispose();
  console.log("PASS adSpeedup: 开关关闭时完全不介入");
}

function testMidAdDisableRestores() {
  const window = loadAdSpeedup();
  const video = createVideo();
  const player = createPlayer();
  const settings = { adSpeedup: true };
  const speedup = new window.YoutubiAdSpeedup({ player, video, settings });

  speedup.setAdShowing(true);
  assert.strictEqual(video.playbackRate, 16, "广告期间应加速");

  settings.adSpeedup = false;
  speedup.setSettings(settings);
  assert.strictEqual(video.playbackRate, 1, "广告中途关闭开关应立即恢复原倍速");
  assert.strictEqual(video.muted, false, "广告中途关闭开关应立即取消静音");

  speedup.dispose();
  console.log("PASS adSpeedup: 广告中途关闭开关立即恢复");
}

function testDoesNotClickHiddenSkipButton() {
  const window = loadAdSpeedup();
  const video = createVideo();
  const player = createPlayer({ skipVisible: false });
  const speedup = new window.YoutubiAdSpeedup({ player, video, settings: { adSpeedup: true } });

  speedup.setAdShowing(true);
  assert.strictEqual(player.skipButton.clicks, 0, "跳过按钮不可见时不应点击");
  assert.strictEqual(video.playbackRate, 16, "跳过按钮不可得时仍应加速");

  speedup.setAdShowing(false);
  speedup.dispose();
  console.log("PASS adSpeedup: 跳过按钮不可见时不点击");
}

testSpeedsUpAndRestores();
testRespectsDisabledSetting();
testMidAdDisableRestores();
testDoesNotClickHiddenSkipButton();
console.log("全部广告加速测试通过");
