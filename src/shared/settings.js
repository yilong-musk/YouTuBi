(() => {
  const STORAGE_KEY = "youtubi.settings";
  let storageUnavailable = false;

  const DEFAULT_SETTINGS = {
    enabled: true,
    fontSize: 22,
    speed: 90,
    opacity: 0.7,
    trackRatio: 2 / 3,
    maxOnScreen: 34,
    preloadLimit: 500
  };

  const TRACK_RATIO_OPTIONS = [1, 2 / 3, 1 / 2, 1 / 3];

  const hasStorage = () => {
    if (storageUnavailable) {
      return false;
    }

    try {
      return (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.sync
      );
    } catch (error) {
      storageUnavailable = true;
      return false;
    }
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const normalizeTrackRatio = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return DEFAULT_SETTINGS.trackRatio;
    }

    return TRACK_RATIO_OPTIONS.reduce((best, option) =>
      Math.abs(option - number) < Math.abs(best - number) ? option : best
    );
  };

  const normalize = (value) => {
    const raw = value && typeof value === "object" ? value : {};

    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
      fontSize: clamp(Number(raw.fontSize) || DEFAULT_SETTINGS.fontSize, 14, 42),
      speed: clamp(Number(raw.speed) || DEFAULT_SETTINGS.speed, 40, 180),
      opacity: clamp(Number(raw.opacity) || DEFAULT_SETTINGS.opacity, 0.25, 1),
      trackRatio: normalizeTrackRatio(raw.trackRatio),
      maxOnScreen: clamp(Number(raw.maxOnScreen) || DEFAULT_SETTINGS.maxOnScreen, 8, 80),
      preloadLimit: clamp(Number(raw.preloadLimit) || DEFAULT_SETTINGS.preloadLimit, 50, 800)
    };
  };

  const load = () =>
    new Promise((resolve) => {
      if (!hasStorage()) {
        resolve({ ...DEFAULT_SETTINGS });
        return;
      }

      try {
        chrome.storage.sync.get({ [STORAGE_KEY]: DEFAULT_SETTINGS }, (items) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve({ ...DEFAULT_SETTINGS });
            return;
          }

          resolve(normalize(items[STORAGE_KEY]));
        });
      } catch (error) {
        storageUnavailable = true;
        resolve({ ...DEFAULT_SETTINGS });
      }
    });

  const save = async (updates) => {
    const current = await load();
    const next = normalize({ ...current, ...updates });

    return new Promise((resolve) => {
      if (!hasStorage()) {
        resolve(next);
        return;
      }

      try {
        chrome.storage.sync.set({ [STORAGE_KEY]: next }, () => {
          resolve(next);
        });
      } catch (error) {
        storageUnavailable = true;
        resolve(next);
      }
    });
  };

  const subscribe = (handler) => {
    if (!hasStorage()) {
      return () => {};
    }

    const listener = (changes, areaName) => {
      if (areaName !== "sync" || !changes[STORAGE_KEY]) {
        return;
      }

      handler(normalize(changes[STORAGE_KEY].newValue));
    };

    try {
      if (!chrome.storage.onChanged) {
        return () => {};
      }

      chrome.storage.onChanged.addListener(listener);
      return () => {
        try {
          chrome.storage.onChanged.removeListener(listener);
        } catch (error) {
          storageUnavailable = true;
        }
      };
    } catch (error) {
      storageUnavailable = true;
      return () => {};
    }
  };

  window.YoutubiSettings = {
    DEFAULT_SETTINGS,
    TRACK_RATIO_OPTIONS,
    load,
    save,
    subscribe
  };
})();
