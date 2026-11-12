const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

function loadBackground(initialSettings) {
  const calls = [];
  const listeners = { storage: [], installed: [], startup: [] };
  const runtime = {
    lastError: null,
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) }
  };

  const chrome = {
    runtime,
    storage: {
      sync: { get: (defaults, cb) => cb({ "youtubi.settings": initialSettings }) },
      onChanged: { addListener: (fn) => listeners.storage.push(fn) }
    },
    declarativeNetRequest: {
      updateEnabledRulesets: (options, callback) => {
        calls.push(options);
        if (callback) {
          callback();
        }
      }
    }
  };

  const sandbox = { chrome, Boolean, JSON, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "background.js"), "utf8"), sandbox, {
    filename: "background.js"
  });

  return { calls, listeners };
}

function testEnabledOnStartup() {
  const { calls } = loadBackground({ adBlock: true });
  assert.strictEqual(JSON.stringify(calls[0]), JSON.stringify({ enableRulesetIds: ["youtube-page-ads"] }), "开启时应启用规则集");
  console.log("PASS background: 启动时按开关启用规则集");
}

function testDisabledOnStartup() {
  const { calls } = loadBackground({ adBlock: false });
  assert.strictEqual(JSON.stringify(calls[0]), JSON.stringify({ disableRulesetIds: ["youtube-page-ads"] }), "关闭时应禁用规则集");
  console.log("PASS background: 启动时按开关禁用规则集");
}

function testToggleUpdatesRuleset() {
  const { calls, listeners } = loadBackground({ adBlock: false });
  assert.strictEqual(listeners.storage.length, 1, "应监听设置变更");

  listeners.storage[0]({ "youtubi.settings": { newValue: { adBlock: true } } }, "sync");
  assert.strictEqual(JSON.stringify(calls[calls.length - 1]), JSON.stringify({ enableRulesetIds: ["youtube-page-ads"] }));

  listeners.storage[0]({ "youtubi.settings": { newValue: { adBlock: false } } }, "sync");
  assert.strictEqual(JSON.stringify(calls[calls.length - 1]), JSON.stringify({ disableRulesetIds: ["youtube-page-ads"] }));

  listeners.storage[0]({ "youtubi.settings": { newValue: { adBlock: true } } }, "local");
  assert.strictEqual(calls.length, 3, "非 sync 区域的变更不应触发");
  console.log("PASS background: 开关变更实时启停规则集");
}

function testRulesFile() {
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, "rules", "page-ads.json"), "utf8"));
  assert.ok(Array.isArray(rules) && rules.length >= 5, "规则文件应存在且包含多条规则");
  const ids = new Set(rules.map((rule) => rule.id));
  assert.strictEqual(ids.size, rules.length, "规则 id 必须唯一");
  for (const rule of rules) {
    assert.strictEqual(rule.action.type, "block");
    const initiators = rule.condition.initiatorDomains;
    assert.ok(
      !initiators || initiators.includes("youtube.com"),
      "限定 initiator 的规则必须包含 youtube.com"
    );
    assert.ok(Array.isArray(rule.condition.resourceTypes) && rule.condition.resourceTypes.length, "规则应有资源类型");
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const resource = manifest.declarative_net_request.rule_resources[0];
  assert.strictEqual(resource.path, "rules/page-ads.json");
  assert.ok(manifest.permissions.includes("declarativeNetRequest"));
  console.log(`PASS rules: ${rules.length} 条规则合法且仅在 YouTube 生效`);
}

testEnabledOnStartup();
testDisabledOnStartup();
testToggleUpdatesRuleset();
testRulesFile();
console.log("全部规则集测试通过");