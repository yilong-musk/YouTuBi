const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CONTENT = path.join(__dirname, "..", "src", "content");

class FakeXhr {
  constructor() {
    this.readyState = 0;
    this.responseType = "";
    this.responseText = "";
    this.response = "";
    this.listeners = new Map();
  }

  open(method, url) {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  send() {}

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  finish(payload) {
    this.readyState = 4;
    this.responseText = JSON.stringify(payload);
    this.response = this.responseText;
    for (const handler of this.listeners.get("readystatechange") || []) {
      handler.call(this);
    }
  }
}

function playerPayload() {
  return {
    playabilityStatus: { status: "OK" },
    videoDetails: { videoId: "abc123", title: "demo" },
    adPlacements: [{ adPlacementRenderer: { config: "start" } }],
    playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
    adSlots: [{ adSlotRenderer: {} }],
    playerResponse: { adPlacements: [{ x: 1 }], videoDetails: { videoId: "abc123" } }
  };
}

function loadAdBlock(fetchImpl = null, storedValue = null) {
  const messages = [];
  const window = {
    fetch: fetchImpl,
    localStorage: {
      getItem: () => storedValue,
      setItem: () => {}
    },
    XMLHttpRequest: FakeXhr,
    addEventListener: (type, handler) => {
      if (type === "message") {
        messages.push(handler);
      }
    },
    postMessage: () => {}
  };

  const sandbox = {
    window,
    Response,
    JSON,
    Object,
    Array,
    Boolean,
    String,
    Math,
    console
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(CONTENT, "adblockMain.js"), "utf8"), sandbox, {
    filename: "adblockMain.js"
  });

  return { window, messages };
}

function assertClean(payload, label) {
  assert.strictEqual(payload.adPlacements, undefined, `${label}: adPlacements 应被删除`);
  assert.strictEqual(payload.playerAds, undefined, `${label}: playerAds 应被删除`);
  assert.strictEqual(payload.adSlots, undefined, `${label}: adSlots 应被删除`);
  assert.strictEqual(payload.playerResponse.adPlacements, undefined, `${label}: 嵌套 playerResponse 也应清理`);
  assert.strictEqual(payload.videoDetails.videoId, "abc123", `${label}: 其他字段必须保留`);
  assert.strictEqual(payload.playabilityStatus.status, "OK", `${label}: 播放状态必须保留`);
}

async function testFetchStripsPlayerAds() {
  const { window } = loadAdBlock(async () => new Response(JSON.stringify(playerPayload()), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  }), "1");

  const response = await window.fetch("https://www.youtube.com/youtubei/v1/player?key=k");
  assertClean(await response.json(), "fetch");
  console.log("PASS adblock: fetch 播放器响应去广告字段");
}

async function testFetchLeavesOtherRequestsAlone() {
  const { window } = loadAdBlock(async () => new Response(JSON.stringify(playerPayload()), { status: 200 }), "1");

  const response = await window.fetch("https://www.youtube.com/youtubei/v1/next?key=k");
  const payload = await response.json();
  assert.ok(payload.adPlacements, "非 player 请求不应被改动");
  console.log("PASS adblock: 非播放器请求不受影响");
}

async function testDisableSwitch() {
  const { window, messages } = loadAdBlock(async () => new Response(JSON.stringify(playerPayload()), { status: 200 }), "1");

  for (const handler of messages) {
    handler({ source: window, data: { __youtubiAdBlock: false } });
  }

  const response = await window.fetch("https://www.youtube.com/youtubei/v1/player?key=k");
  const payload = await response.json();
  assert.ok(payload.adPlacements, "关闭开关后不应清理广告字段");

  window.__youtubiAdBlock.setEnabled(true);
  const again = await window.fetch("https://www.youtube.com/youtubei/v1/player?key=k");
  assertClean(await again.json(), "re-enabled");
  console.log("PASS adblock: 开关可关闭/恢复");
}

function testXhrStripsPlayerAds() {
  const { window } = loadAdBlock(null, "1");
  const xhr = new window.XMLHttpRequest();
  xhr.open("POST", "https://www.youtube.com/youtubei/v1/player?key=k");
  xhr.send();
  xhr.finish(playerPayload());

  const payload = JSON.parse(xhr.responseText);
  assertClean(payload, "xhr");
  console.log("PASS adblock: XHR 播放器响应去广告字段");
}

function testInitialPlayerResponseStripped() {
  const { window } = loadAdBlock(null, "1");
  window.ytInitialPlayerResponse = playerPayload();
  assertClean(window.ytInitialPlayerResponse, "ytInitialPlayerResponse");
  console.log("PASS adblock: 首屏 ytInitialPlayerResponse 去广告字段");
}

async function testDefaultDisabled() {
  const { window } = loadAdBlock(async () => new Response(JSON.stringify(playerPayload()), { status: 200 }));
  const response = await window.fetch("https://www.youtube.com/youtubei/v1/player?key=k");
  const payload = await response.json();
  assert.ok(payload.adPlacements, "默认关闭时不应清理广告字段");
  console.log("PASS adblock: 默认关闭（未选择启用时不介入）");
}

async function testStoredDisabledValue() {
  const { window } = loadAdBlock(async () => new Response(JSON.stringify(playerPayload()), { status: 200 }), "0");
  const response = await window.fetch("https://www.youtube.com/youtubei/v1/player?key=k");
  const payload = await response.json();
  assert.ok(payload.adPlacements, "localStorage 标记关闭时首屏不应清理");
  console.log("PASS adblock: localStorage 关闭状态在首屏生效");
}

(async () => {
  await testFetchStripsPlayerAds();
  await testDefaultDisabled();
  await testStoredDisabledValue();
  await testFetchLeavesOtherRequestsAlone();
  await testDisableSwitch();
  testXhrStripsPlayerAds();
  testInitialPlayerResponseStripped();
  console.log("全部去广告测试通过");
})();