(() => {
  const ENDPOINT_BASE = "https://www.youtube.com/youtubei/v1";
  const CONFIG_RETRY_MS = 250;
  const CONFIG_RETRY_COUNT = 20;

  const commentTime = window.YoutubiCommentTime || {
    normalizeText: (text) => String(text || "").replace(/\s+/g, " ").trim()
  };

  const normalizeText = commentTime.normalizeText;

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  const isAbortError = (error) =>
    error && (error.name === "AbortError" || error.message === "The user aborted a request.");

  const getNested = (value, path) => {
    let current = value;

    for (const key of path) {
      if (!current || typeof current !== "object") {
        return null;
      }

      current = current[key];
    }

    return current || null;
  };

  const textFrom = (value) => {
    if (!value) {
      return "";
    }

    if (typeof value === "string") {
      return normalizeText(value);
    }

    if (Array.isArray(value)) {
      return normalizeText(value.map(textFrom).filter(Boolean).join(""));
    }

    if (typeof value !== "object") {
      return "";
    }

    if (typeof value.simpleText === "string") {
      return normalizeText(value.simpleText);
    }

    if (typeof value.content === "string") {
      return normalizeText(value.content);
    }

    if (typeof value.text === "string") {
      return normalizeText(value.text);
    }

    if (Array.isArray(value.runs)) {
      return normalizeText(value.runs.map((run) => run.text || run.content || "").join(""));
    }

    if (Array.isArray(value.commandRuns)) {
      return normalizeText(value.commandRuns.map((run) => run.text || run.content || "").join(""));
    }

    return "";
  };

  const firstText = (...values) => {
    for (const value of values) {
      const text = textFrom(value);
      if (text) {
        return text;
      }
    }

    return "";
  };

  const firstUrl = (...values) => {
    for (const value of values) {
      if (typeof value === "string" && value) {
        return value;
      }

      if (Array.isArray(value)) {
        const found = firstUrl(...value);
        if (found) {
          return found;
        }
      }

      if (value && typeof value === "object") {
        const found = firstUrl(
          value.url,
          value.thumbnails,
          value.sources,
          value.image,
          value.avatar
        );
        if (found) {
          return found;
        }
      }
    }

    return "";
  };

  const getHandle = (text) => {
    const match = normalizeText(text).match(/(^|\s)(@[\p{L}\p{N}_.-]+)/u);
    return match ? match[2] : "";
  };

  const walk = (value, visitor) => {
    if (!value || typeof value !== "object") {
      return;
    }

    if (visitor(value) === false) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, visitor));
      return;
    }

    Object.values(value).forEach((item) => walk(item, visitor));
  };

  const extractBalancedJson = (text, startIndex) => {
    const openIndex = text.indexOf("{", startIndex);
    if (openIndex === -1) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = openIndex; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }

        continue;
      }

      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;

        if (depth === 0) {
          return text.slice(openIndex, index + 1);
        }
      }
    }

    return null;
  };

  const parseJsonAfter = (text, marker) => {
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) {
      return null;
    }

    const jsonText = extractBalancedJson(text, markerIndex + marker.length);
    if (!jsonText) {
      return null;
    }

    try {
      return JSON.parse(jsonText);
    } catch (error) {
      return null;
    }
  };

  const getScriptTexts = () =>
    Array.from(document.scripts)
      .map((script) => script.textContent || "")
      .filter((text) =>
        text.includes("INNERTUBE") ||
        text.includes("ytInitialData") ||
        text.includes("ytInitialPlayerResponse")
      );

  const getWindowObject = (name) => {
    try {
      const value = window[name];
      return value && typeof value === "object" ? value : null;
    } catch (error) {
      return null;
    }
  };

  const extractConfig = () => {
    const scripts = getScriptTexts();
    const config = {};
    let apiKey = "";

    for (const text of scripts) {
      const ytcfg = parseJsonAfter(text, "ytcfg.set(");
      if (ytcfg && typeof ytcfg === "object") {
        Object.assign(config, ytcfg);
      }

      if (!apiKey) {
        const match = text.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
        apiKey = match && match[1] ? match[1] : "";
      }
    }

    apiKey = config.INNERTUBE_API_KEY || apiKey;

    const context = config.INNERTUBE_CONTEXT || {
      client: {
        clientName: config.INNERTUBE_CLIENT_NAME || "WEB",
        clientVersion: config.INNERTUBE_CLIENT_VERSION || "",
        hl: config.HL || document.documentElement.lang || "en",
        gl: config.GL || "US",
        visitorData: config.VISITOR_DATA
      }
    };

    return {
      apiKey,
      context,
      clientName: String(config.INNERTUBE_CONTEXT_CLIENT_NAME || "1"),
      clientVersion:
        config.INNERTUBE_CONTEXT_CLIENT_VERSION ||
        getNested(context, ["client", "clientVersion"]) ||
        "",
      visitorData: config.VISITOR_DATA || getNested(context, ["client", "visitorData"]) || ""
    };
  };

  const extractInitialData = () => {
    const windowData = getWindowObject("ytInitialData");
    if (windowData) {
      return windowData;
    }

    for (const text of getScriptTexts()) {
      const data =
        parseJsonAfter(text, "ytInitialData =") ||
        parseJsonAfter(text, "var ytInitialData =") ||
        parseJsonAfter(text, "window[\"ytInitialData\"] =") ||
        parseJsonAfter(text, "window.ytInitialData =");

      if (data) {
        return data;
      }
    }

    return null;
  };

  const extractPlayerResponse = () => {
    const windowResponse = getWindowObject("ytInitialPlayerResponse");
    if (windowResponse) {
      return windowResponse;
    }

    for (const text of getScriptTexts()) {
      const data =
        parseJsonAfter(text, "ytInitialPlayerResponse =") ||
        parseJsonAfter(text, "var ytInitialPlayerResponse =") ||
        parseJsonAfter(text, "window[\"ytInitialPlayerResponse\"] =") ||
        parseJsonAfter(text, "window.ytInitialPlayerResponse =") ||
        parseJsonAfter(text, "\"playerResponse\":");

      if (data) {
        return data;
      }
    }

    return null;
  };

  const getContinuationToken = (value) =>
    getNested(value, ["continuationEndpoint", "continuationCommand", "token"]) ||
    getNested(value, ["continuationEndpoint", "continuationCommand", "continuation"]) ||
    getNested(value, ["command", "continuationCommand", "token"]) ||
    getNested(value, ["command", "continuationCommand", "continuation"]) ||
    getNested(value, ["button", "buttonRenderer", "command", "continuationCommand", "token"]) ||
    getNested(value, ["button", "buttonRenderer", "command", "continuationCommand", "continuation"]) ||
    getNested(value, ["button", "buttonRenderer", "serviceEndpoint", "continuationCommand", "token"]) ||
    getNested(value, ["button", "buttonRenderer", "serviceEndpoint", "continuationCommand", "continuation"]) ||
    getNested(value, ["button", "buttonRenderer", "navigationEndpoint", "continuationCommand", "token"]) ||
    getNested(value, ["button", "buttonRenderer", "navigationEndpoint", "continuationCommand", "continuation"]) ||
    getNested(value, ["buttonRenderer", "command", "continuationCommand", "token"]) ||
    getNested(value, ["buttonRenderer", "command", "continuationCommand", "continuation"]) ||
    getNested(value, ["buttonRenderer", "serviceEndpoint", "continuationCommand", "token"]) ||
    getNested(value, ["buttonRenderer", "serviceEndpoint", "continuationCommand", "continuation"]) ||
    getNested(value, ["buttonRenderer", "navigationEndpoint", "continuationCommand", "token"]) ||
    getNested(value, ["buttonRenderer", "navigationEndpoint", "continuationCommand", "continuation"]) ||
    getNested(value, ["onTap", "innertubeCommand", "continuationCommand", "token"]) ||
    getNested(value, ["onTap", "innertubeCommand", "continuationCommand", "continuation"]) ||
    getNested(value, ["continuationCommand", "token"]) ||
    getNested(value, ["continuationCommand", "continuation"]) ||
    getNested(value, ["getLiveChatEndpoint", "continuation"]) ||
    getNested(value, ["getLiveChatReplayEndpoint", "continuation"]) ||
    getNested(value, ["liveChatEndpoint", "continuation"]) ||
    getNested(value, ["liveChatReplayEndpoint", "continuation"]) ||
    getNested(value, ["reloadContinuationData", "continuation"]) ||
    getNested(value, ["nextContinuationData", "continuation"]) ||
    getNested(value, ["timedContinuationData", "continuation"]) ||
    getNested(value, ["invalidationContinuationData", "continuation"]) ||
    getNested(value, ["playerSeekContinuationData", "continuation"]) ||
    getNested(value, ["liveChatReplayContinuationData", "continuation"]) ||
    null;

  const findContinuationToken = (value) => {
    let token = null;

    walk(value, (node) => {
      if (token) {
        return false;
      }

      const found = getContinuationToken(node);
      if (found) {
        token = found;
      }

      return token ? false : undefined;
    });

    return token;
  };

  const findNextContinuation = (data, options = {}) => {
    const actions = [];

    walk(data, (node) => {
      if (node.appendContinuationItemsAction) {
        actions.push(node.appendContinuationItemsAction);
      }

      if (node.reloadContinuationItemsCommand) {
        actions.push(node.reloadContinuationItemsCommand);
      }
    });

    for (const action of actions) {
      const items = action.continuationItems || [];

      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        const token = item && item.continuationItemRenderer
          ? getContinuationToken(item.continuationItemRenderer)
          : null;

        if (token) {
          return token;
        }
      }
    }

    return getLiveChatContinuation(data, options).token;
  };

  const getLiveChatContinuation = (data, options = {}) => {
    const continuation = {
      token: "",
      timeoutMs: 0,
      clickTrackingParams: ""
    };
    const hasReplayFilter = Object.prototype.hasOwnProperty.call(options, "replay");
    const replay = Boolean(options.replay);

    walk(data, (node) => {
      if (continuation.token) {
        return false;
      }

      const candidates = hasReplayFilter
        ? replay
          ? [
              node.playerSeekContinuationData,
              node.liveChatReplayContinuationData
            ]
          : [
              node.timedContinuationData,
              node.invalidationContinuationData,
              node.reloadContinuationData,
              node.nextContinuationData
            ]
        : [
            node.timedContinuationData,
            node.invalidationContinuationData,
            node.reloadContinuationData,
            node.nextContinuationData,
            node.playerSeekContinuationData,
            node.liveChatReplayContinuationData
          ];

      for (const candidate of candidates.filter(Boolean)) {
        const token = candidate.continuation;
        if (token) {
          continuation.token = token;
          continuation.timeoutMs =
            Number(candidate.timeoutMs) ||
            Number(candidate.timeoutMsForDummy) ||
            Number(candidate.timeUntilLastMessageMsec) ||
            0;
          continuation.clickTrackingParams = candidate.clickTrackingParams || "";
          return false;
        }
      }

      return undefined;
    });

    return continuation;
  };

  const getContinuationFromCandidate = (candidate) => {
    if (!candidate || !candidate.continuation) {
      return null;
    }

    return {
      token: candidate.continuation,
      timeoutMs:
        Number(candidate.timeoutMs) ||
        Number(candidate.timeoutMsForDummy) ||
        Number(candidate.timeUntilLastMessageMsec) ||
        0,
      clickTrackingParams: candidate.clickTrackingParams || ""
    };
  };

  const getTypedContinuationFromNode = (node, replay) => {
    const candidates = replay
      ? [
          node && node.playerSeekContinuationData,
          node && node.liveChatReplayContinuationData
        ]
      : [
          node && node.timedContinuationData,
          node && node.invalidationContinuationData,
          node && node.reloadContinuationData,
          node && node.nextContinuationData
        ];

    for (const candidate of candidates) {
      const info = getContinuationFromCandidate(candidate);
      if (info && info.token) {
        return info;
      }
    }

    return null;
  };

  const getLiveChatContinuationByType = (data, replay) => {
    const continuation = {
      token: "",
      timeoutMs: 0,
      clickTrackingParams: ""
    };

    walk(data, (node) => {
      if (continuation.token) {
        return false;
      }

      const info = getTypedContinuationFromNode(node, replay);
      if (info && info.token) {
        continuation.token = info.token;
        continuation.timeoutMs = info.timeoutMs;
        continuation.clickTrackingParams = info.clickTrackingParams;
        return false;
      }

      return undefined;
    });

    return continuation;
  };

  const getEndpointApiUrl = (value) =>
    getNested(value, ["commandMetadata", "webCommandMetadata", "apiUrl"]) ||
    getNested(value, ["continuationEndpoint", "commandMetadata", "webCommandMetadata", "apiUrl"]) ||
    getNested(value, ["command", "commandMetadata", "webCommandMetadata", "apiUrl"]) ||
    getNested(value, ["serviceEndpoint", "commandMetadata", "webCommandMetadata", "apiUrl"]) ||
    getNested(value, ["navigationEndpoint", "commandMetadata", "webCommandMetadata", "apiUrl"]) ||
    "";

  const isLiveChatEndpoint = (value, replay) => {
    if (replay && (value.getLiveChatReplayEndpoint || value.liveChatReplayEndpoint)) {
      return true;
    }

    if (!replay && (value.getLiveChatEndpoint || value.liveChatEndpoint)) {
      return true;
    }

    const apiUrl = getEndpointApiUrl(value);
    if (!apiUrl || !apiUrl.includes("/live_chat/")) {
      return false;
    }

    const isReplayEndpoint = apiUrl.includes("/get_live_chat_replay");
    return replay ? isReplayEndpoint : apiUrl.includes("/get_live_chat") && !isReplayEndpoint;
  };

  const getCommandContinuationToken = (value) =>
    getNested(value, ["continuationCommand", "token"]) ||
    getNested(value, ["continuationCommand", "continuation"]) ||
    null;

  const getLiveChatEndpointContinuationToken = (value, replay) => {
    const endpointNames = replay
      ? ["getLiveChatReplayEndpoint", "liveChatReplayEndpoint"]
      : ["getLiveChatEndpoint", "liveChatEndpoint"];

    for (const endpointName of endpointNames) {
      const token =
        getNested(value, [endpointName, "continuation"]) ||
        getNested(value, ["continuationEndpoint", endpointName, "continuation"]) ||
        getNested(value, ["command", endpointName, "continuation"]) ||
        getNested(value, ["serviceEndpoint", endpointName, "continuation"]) ||
        getNested(value, ["navigationEndpoint", endpointName, "continuation"]);
      if (token) {
        return token;
      }
    }

    if (!isLiveChatEndpoint(value, replay)) {
      return "";
    }

    const commandContainers = [
      value,
      value.continuationEndpoint,
      value.command,
      value.serviceEndpoint,
      value.navigationEndpoint,
      getNested(value, ["button", "buttonRenderer", "command"]),
      getNested(value, ["button", "buttonRenderer", "serviceEndpoint"]),
      getNested(value, ["button", "buttonRenderer", "navigationEndpoint"]),
      value.buttonRenderer && value.buttonRenderer.command,
      value.buttonRenderer && value.buttonRenderer.serviceEndpoint,
      value.buttonRenderer && value.buttonRenderer.navigationEndpoint,
      getNested(value, ["onTap", "innertubeCommand"])
    ];

    for (const commandContainer of commandContainers) {
      const token = getCommandContinuationToken(commandContainer);
      if (token) {
        return token;
      }
    }

    return "";
  };

  const pickLiveChatContinuation = (container, replay) => {
    if (!container || typeof container !== "object") {
      return null;
    }

    const containerInfo = getLiveChatContinuationByType(container, replay);
    if (containerInfo && containerInfo.token) {
      return {
        ...containerInfo,
        isReplay: replay,
        source: "live-chat-container"
      };
    }

    let endpointInfo = null;
    walk(container, (node) => {
      if (endpointInfo) {
        return false;
      }

      if (!isLiveChatEndpoint(node, replay)) {
        return undefined;
      }

      const token = getLiveChatEndpointContinuationToken(node, replay);
      if (token) {
        endpointInfo = {
          token,
          timeoutMs: 0,
          clickTrackingParams: "",
          isReplay: replay,
          source: "live-chat-endpoint"
        };
        return false;
      }

      return undefined;
    });

    return endpointInfo;
  };

  const findLiveChatContinuation = (data, options = {}) => {
    const replay = Boolean(options.replay);
    const allowContinuationData = Boolean(options.allowContinuationData);
    let result = null;

    walk(data, (node) => {
      if (result) {
        return false;
      }

      if (node.liveChatRenderer) {
        result = pickLiveChatContinuation(node.liveChatRenderer, replay);
      }

      if (!result && node.liveChatContinuation) {
        result = pickLiveChatContinuation(node.liveChatContinuation, replay);
      }

      const directInfo = !result && (replay || allowContinuationData)
        ? getTypedContinuationFromNode(node, replay)
        : null;
      if (directInfo && directInfo.token) {
        result = {
          ...directInfo,
          isReplay: replay,
          source: "live-chat-continuation-data"
        };
        return false;
      }

      if (!result && isLiveChatEndpoint(node, replay)) {
        const token = getLiveChatEndpointContinuationToken(node, replay);
        if (token) {
          result = {
            token,
            timeoutMs: 0,
            clickTrackingParams: "",
            isReplay: replay,
            source: "live-chat-endpoint"
          };
        }
      }

      return result ? false : undefined;
    });

    return result;
  };

  const waitForConfig = async (isDisposed = () => false) => {
    for (let attempt = 0; attempt < CONFIG_RETRY_COUNT; attempt += 1) {
      if (isDisposed()) {
        return null;
      }

      const config = extractConfig();
      if (config.apiKey && config.context) {
        return config;
      }

      await sleep(CONFIG_RETRY_MS);
    }

    return extractConfig();
  };

  const fetchEndpoint = async (endpoint, config, body, signal) => {
    const headers = {
      "content-type": "application/json",
      "x-youtube-client-name": config.clientName,
      "x-youtube-client-version": config.clientVersion
    };

    if (config.visitorData) {
      headers["x-goog-visitor-id"] = config.visitorData;
    }

    const response = await fetch(
      `${ENDPOINT_BASE}/${endpoint}?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`,
      {
        method: "POST",
        credentials: "include",
        headers,
        signal,
        body: JSON.stringify({
          context: config.context,
          ...body
        })
      }
    );

    if (!response.ok) {
      throw new Error(`youtubei ${endpoint} failed: ${response.status}`);
    }

    return response.json();
  };

  const fetchNext = (config, body, signal) => fetchEndpoint("next", config, body, signal);

  window.YoutubiInnertube = {
    sleep,
    isAbortError,
    getNested,
    textFrom,
    firstText,
    firstUrl,
    getHandle,
    walk,
    parseJsonAfter,
    getScriptTexts,
    getWindowObject,
    extractConfig,
    extractInitialData,
    extractPlayerResponse,
    getContinuationToken,
    findContinuationToken,
    findNextContinuation,
    getLiveChatContinuation,
    findLiveChatContinuation,
    waitForConfig,
    fetchEndpoint,
    fetchNext
  };
})();
