const t = (key, substitutions, fallback) =>
  window.YoutubiI18n ? window.YoutubiI18n.t(key, substitutions, fallback) : fallback;

if (window.YoutubiI18n) {
  window.YoutubiI18n.localizeDocument();
}

const TRACK_RATIO_LABELS = new Map([
  [1, ["trackFull", "Full"]],
  [2 / 3, ["trackTwoThirds", "2/3"]],
  [1 / 2, ["trackHalf", "Half"]],
  [1 / 3, ["trackOneThird", "1/3"]]
]);

const controls = {
  enabled: document.querySelector("#enabled"),
  trackRatio: document.querySelector("#trackRatio"),
  speed: document.querySelector("#speed"),
  fontSize: document.querySelector("#fontSize"),
  opacity: document.querySelector("#opacity"),
  preloadLimit: document.querySelector("#preloadLimit"),
  trackRatioValue: document.querySelector("#trackRatioValue"),
  speedValue: document.querySelector("#speedValue"),
  fontSizeValue: document.querySelector("#fontSizeValue"),
  opacityValue: document.querySelector("#opacityValue"),
  preloadLimitValue: document.querySelector("#preloadLimitValue")
};

let currentSettings = null;
let saveTimer = 0;
let pendingUpdates = {};
let saveToken = 0;
let saveChain = Promise.resolve();
let unsubscribeSettings = () => {};

const normalizeTrackRatio = (value) =>
  window.YoutubiSettings.TRACK_RATIO_OPTIONS.reduce((best, option) =>
    Math.abs(option - value) < Math.abs(best - value) ? option : best
  );

const getTrackRatioLabel = (value) => {
  const [key, fallback] = TRACK_RATIO_LABELS.get(normalizeTrackRatio(value)) || TRACK_RATIO_LABELS.get(2 / 3);
  return t(key, null, fallback);
};

const renderTrackRatio = (value) => {
  const normalized = normalizeTrackRatio(value);

  controls.trackRatioValue.textContent = getTrackRatioLabel(normalized);

  controls.trackRatio.querySelectorAll("button").forEach((button) => {
    const isSelected = normalizeTrackRatio(Number(button.dataset.trackRatio)) === normalized;
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-checked", String(isSelected));
  });
};

const render = (settings) => {
  currentSettings = settings;
  controls.enabled.checked = settings.enabled;
  controls.speed.value = settings.speed;
  controls.fontSize.value = settings.fontSize;
  controls.opacity.value = settings.opacity;
  controls.preloadLimit.value = settings.preloadLimit;
  renderTrackRatio(settings.trackRatio);
  controls.speedValue.textContent = t("unitSpeed", settings.speed, "$1 px/s");
  controls.fontSizeValue.textContent = t("unitFontSize", settings.fontSize, "$1 px");
  controls.opacityValue.textContent = t("unitOpacity", Math.round(settings.opacity * 100), "$1%");
  controls.preloadLimitValue.textContent = t("unitPreload", settings.preloadLimit, "$1 comments");
};

const hasPendingUpdates = () => Object.keys(pendingUpdates).length > 0;

const persistSettings = (updates) => {
  const request = saveChain.then(() => window.YoutubiSettings.save(updates));
  saveChain = request.catch(() => {});
  return request;
};

const flushSave = async () => {
  if (!currentSettings) {
    return;
  }

  const updates = pendingUpdates;
  pendingUpdates = {};

  if (!Object.keys(updates).length) {
    return;
  }

  const token = ++saveToken;
  const saved = await persistSettings(updates);
  if (token === saveToken) {
    render({ ...saved, ...pendingUpdates });
  }
};

const scheduleSave = (updates, delay = 80) => {
  if (!currentSettings) {
    return;
  }

  pendingUpdates = { ...pendingUpdates, ...updates };
  render({ ...currentSettings, ...pendingUpdates });
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, delay);
};

const saveImmediately = (updates) => {
  if (!currentSettings) {
    return;
  }

  pendingUpdates = { ...pendingUpdates, ...updates };
  render({ ...currentSettings, ...pendingUpdates });
  window.clearTimeout(saveTimer);
  void flushSave();
};

window.YoutubiSettings.load().then((settings) => {
  render(settings);
  unsubscribeSettings = window.YoutubiSettings.subscribe((nextSettings) => {
    render(hasPendingUpdates() ? { ...nextSettings, ...pendingUpdates } : nextSettings);
  });
});

window.addEventListener("pagehide", () => {
  window.clearTimeout(saveTimer);
  if (hasPendingUpdates()) {
    void flushSave();
  }
  unsubscribeSettings();
});

controls.enabled.addEventListener("change", () => saveImmediately({ enabled: controls.enabled.checked }));
controls.trackRatio.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-track-ratio]");
  if (!button || !currentSettings) {
    return;
  }

  saveImmediately({ trackRatio: normalizeTrackRatio(Number(button.dataset.trackRatio)) });
});

const speedUpdate = () => ({ speed: Number(controls.speed.value) });
const fontSizeUpdate = () => ({ fontSize: Number(controls.fontSize.value) });
const opacityUpdate = () => ({ opacity: Number(controls.opacity.value) });
const preloadLimitUpdate = () => ({ preloadLimit: Number(controls.preloadLimit.value) });

controls.speed.addEventListener("input", () => scheduleSave(speedUpdate()));
controls.speed.addEventListener("change", () => saveImmediately(speedUpdate()));
controls.fontSize.addEventListener("input", () => scheduleSave(fontSizeUpdate()));
controls.fontSize.addEventListener("change", () => saveImmediately(fontSizeUpdate()));
controls.opacity.addEventListener("input", () => scheduleSave(opacityUpdate()));
controls.opacity.addEventListener("change", () => saveImmediately(opacityUpdate()));
controls.preloadLimit.addEventListener("input", () => scheduleSave(preloadLimitUpdate()));
controls.preloadLimit.addEventListener("change", () => saveImmediately(preloadLimitUpdate()));
