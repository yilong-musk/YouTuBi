const TRACK_RATIO_LABELS = new Map([
  [1, "\u5168\u5c4f"],
  [2 / 3, "2/3\u5c4f"],
  [1 / 2, "\u534a\u5c4f"],
  [1 / 3, "1/3\u5c4f"]
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

const normalizeTrackRatio = (value) =>
  window.YoutubiSettings.TRACK_RATIO_OPTIONS.reduce((best, option) =>
    Math.abs(option - value) < Math.abs(best - value) ? option : best
  );

const getTrackRatioLabel = (value) => TRACK_RATIO_LABELS.get(normalizeTrackRatio(value)) || "2/3\u5c4f";

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
  controls.speedValue.textContent = `${settings.speed}px/s`;
  controls.fontSizeValue.textContent = `${settings.fontSize}px`;
  controls.opacityValue.textContent = `${Math.round(settings.opacity * 100)}%`;
  controls.preloadLimitValue.textContent = `${settings.preloadLimit} \u6761`;
};

const readControls = () => ({
  enabled: controls.enabled.checked,
  trackRatio: normalizeTrackRatio(currentSettings.trackRatio),
  speed: Number(controls.speed.value),
  fontSize: Number(controls.fontSize.value),
  opacity: Number(controls.opacity.value),
  preloadLimit: Number(controls.preloadLimit.value)
});

const scheduleSave = () => {
  if (!currentSettings) {
    return;
  }

  render({ ...currentSettings, ...readControls() });
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const saved = await window.YoutubiSettings.save(readControls());
    render(saved);
  }, 80);
};

window.YoutubiSettings.load().then(render);

controls.enabled.addEventListener("change", scheduleSave);
controls.trackRatio.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-track-ratio]");
  if (!button || !currentSettings) {
    return;
  }

  currentSettings.trackRatio = normalizeTrackRatio(Number(button.dataset.trackRatio));
  scheduleSave();
});
controls.speed.addEventListener("input", scheduleSave);
controls.fontSize.addEventListener("input", scheduleSave);
controls.opacity.addEventListener("input", scheduleSave);
controls.preloadLimit.addEventListener("input", scheduleSave);
