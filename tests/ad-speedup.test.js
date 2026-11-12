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


function createPodPlayer() {
  const player = {
    ads: [],
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll(selector) {
      return selector === ".video-ads video" ? player.ads.slice() : [];
    },
    querySelector(selector) {
      if (selector === ".video-ads") {
        return null;
      }
      if (selector === "video.html5-main-video, video") {
        return player.ads[0] || null;
      }
      return null;
    }
  };
  return player;
}

function testPodSwitchesVideoElement() {
  const window = loadAdSpeedup();
  const player = createPodPlayer();
  const first = createVideo();
  player.ads = [first];
  const speedup = new window.YoutubiAdSpeedup({ player, video: first, settings: { adSpeedup: true } });

  speedup.setAdShowing(true);
  assert.strictEqual(first.playbackRate, 16, "第一条广告应加速");

  // 广告连播：YouTube 换了一个新的 video 元素
  const second = createVideo();
  player.ads = [second];
  speedup.tick();

  assert.strictEqual(second.playbackRate, 16, "第二条广告（新 video 元素）也应被加速");
  assert.strictEqual(second.muted, true, "第二条广告应静音");

  speedup.setAdShowing(false);
  assert.strictEqual(first.playbackRate, 1, "第一条广告元素应恢复原倍速");
  assert.strictEqual(second.playbackRate, 1, "第二条广告元素也应恢复原倍速");
  assert.strictEqual(second.muted, false, "第二条广告元素应恢复声音");

  speedup.dispose();
  console.log("PASS adSpeedup: 广告连播换 video 元素时第二条仍能加速/静音/恢复");
}

function testPodKeepsRateWhenPlayerResetsIt() {
  const window = loadAdSpeedup();
  const player = createPodPlayer();
  const video = createVideo();
  player.ads = [video];
  const speedup = new window.YoutubiAdSpeedup({ player, video, settings: { adSpeedup: true } });

  speedup.setAdShowing(true);
  assert.strictEqual(video.playbackRate, 16);

  // 模拟播放器把倍速重置为 1（广告切换时常见）
  video.playbackRate = 1;
  speedup.tick();
  assert.strictEqual(video.playbackRate, 16, "倍速被播放器重置后应在下一次 tick 恢复");

  speedup.setAdShowing(false);
  speedup.dispose();
  console.log("PASS adSpeedup: 播放器重置倍速后自动恢复 16x");
}

testSpeedsUpAndRestores();
testRespectsDisabledSetting();
testMidAdDisableRestores();
testDoesNotClickHiddenSkipButton();
testPodSwitchesVideoElement();
testPodKeepsRateWhenPlayerResetsIt();
console.log("全部广告加速测试通过");
