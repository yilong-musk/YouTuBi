const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CONTENT = path.join(__dirname, "..", "src", "content");

function loadBridge(initialSettings) {
  const listeners = [];
  const posted = [];
  const storageWrites = [];
  const root = { dataset: {} };

  const window = {
    localStorage: {
      setItem: (key, value) => storageWrites.push([key, value])
    },
    postMessage: (message) => posted.push(message)
  };

  const chrome = {
    runtime: { lastError: null },
    storage: {
      sync: {
        get: (defaults, callback) => callback({ "youtubi.settings": initialSettings })
      },
      onChanged: { addListener: (handler) => listeners.push(handler) }
    }
  };

  const sandbox = { window, document: { documentElement: root }, chrome, Boolean, JSON, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(CONTENT, "adblockBridge.js"), "utf8"), sandbox, {
    filename: "adblockBridge.js"
  });

  return { root, posted, storageWrites, listeners };
}

function testDisabledByDefault() {
  const { root, posted, storageWrites } = loadBridge({ adBlock: false });
  assert.strictEqual(root.dataset.youtubiAdBlock, "0", "关闭时 dataset 应为 0");
  assert.strictEqual(JSON.stringify(storageWrites[0]), JSON.stringify(["youtubi.adBlock", "0"]), "关闭时 localStorage 应为 0");
  assert.strictEqual(JSON.stringify(posted), JSON.stringify([{ __youtubiAdBlock: false }]), "关闭时应广播 false");
  console.log("PASS bridge: 关闭时正确标记为 0");
}

function testEnabled() {
  const { root, posted, storageWrites } = loadBridge({ adBlock: true });
  assert.strictEqual(root.dataset.youtubiAdBlock, "1", "开启时 dataset 应为 1（CSS 依赖它隐藏占位广告）");
  assert.strictEqual(JSON.stringify(storageWrites[0]), JSON.stringify(["youtubi.adBlock", "1"]), "开启时 localStorage 应为 1");
  assert.strictEqual(JSON.stringify(posted), JSON.stringify([{ __youtubiAdBlock: true }]), "开启时应广播 true");
  console.log("PASS bridge: 开启时正确标记为 1");
}

function testStorageChangeUpdatesState() {
  const { root, listeners, posted } = loadBridge({ adBlock: false });
  assert.strictEqual(listeners.length, 1, "应注册 storage 变更监听");

  listeners[0]({ "youtubi.settings": { newValue: { adBlock: true } } }, "sync");
  assert.strictEqual(root.dataset.youtubiAdBlock, "1", "切换开关后 dataset 应更新为 1");
  assert.strictEqual(JSON.stringify(posted[posted.length - 1]), JSON.stringify({ __youtubiAdBlock: true }));

  listeners[0]({ "youtubi.settings": { newValue: { adBlock: false } } }, "sync");
  assert.strictEqual(root.dataset.youtubiAdBlock, "0", "再次切换应回到 0");
  console.log("PASS bridge: 开关变更实时生效");
}

testDisabledByDefault();
testEnabled();
testStorageChangeUpdatesState();
console.log("全部开关桥接测试通过");