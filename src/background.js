const RULESET_ID = "youtube-page-ads";
const STORAGE_KEY = "youtubi.settings";

const sync = (enabled) => {
  try {
    const options = enabled ? { enableRulesetIds: [RULESET_ID] } : { disableRulesetIds: [RULESET_ID] };
    chrome.declarativeNetRequest.updateEnabledRulesets(options, () => void chrome.runtime.lastError);
  } catch (error) {
    // 规则集不可用时忽略
  }
};

const readAndSync = (callback) => {
  try {
    chrome.storage.sync.get({ [STORAGE_KEY]: null }, (items) => {
      const settings = items[STORAGE_KEY] || {};
      sync(Boolean(settings.adBlock));
      if (callback) {
        callback(settings);
      }
    });
  } catch (error) {
    // 忽略
  }
};

readAndSync();
chrome.runtime.onInstalled.addListener(() => readAndSync());
chrome.runtime.onStartup.addListener(() => readAndSync());

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes[STORAGE_KEY]) {
    return;
  }
  sync(Boolean((changes[STORAGE_KEY].newValue || {}).adBlock));
});