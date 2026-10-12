import { API_URLS, ParseError } from "../src/core.mjs";
import { INSTANCE_ID_PATTERN, NATIVE_HOST_NAME, validateBridgeCommand } from "../src/native-messaging.mjs";
import { createExtensionRequest, PAGE_DOWNLOAD_TYPE, safeFilename, startDownload, waitForDownload } from "./app.mjs";
import { createAgentCommandHandler } from "./agent.mjs";
import { AUTH_FAILURE_TYPE, CONNECTION_STORAGE_KEY, LOGIN_REFRESH_ALARM, LOGIN_REFRESH_TYPE, createLoginStateManager, getInstanceId } from "./agent-state.mjs";

const CHANNELS_ORIGIN = "https://channels.weixin.qq.com";
const CHANNELS_FEED_PAGE_URL = `${CHANNELS_ORIGIN}/finder-preview/pages/feed`;
const FEED_REQUEST_TYPE = "weixin-channels-video:feed-request";
const OFFSCREEN_PARSE_TYPE = "weixin-channels-video:offscreen-parse";
const FEED_RULE_ID = 1;
const FEED_TIMEOUT_MS = 15_000;
const FEED_REQUEST_ID_PATTERN = /^[0-9a-f]{1,16}-[0-9a-f]{8}$/;
const FAILURE_RESULT = { status: 0, body: "", failure: "failed" };
const RECONNECT_ALARM = "weixin-channels-video:bridge-reconnect";
const OFFSCREEN_URL = "offscreen.html";

// Each request atomically replaces this rule, so that operation retries cleanup if startup fails.
const initialRuleCleanup = chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [FEED_RULE_ID],
}).catch(() => undefined);
let feedRequestQueue = Promise.resolve();
const requestedFilenames = new Map();

async function startTrackedDownload(result, chromeApi = chrome, filename = safeFilename(result.title)) {
  const downloadId = await startDownload(result, chromeApi, filename);
  requestedFilenames.set(downloadId, filename);
  return downloadId;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = item.byExtensionId === chrome.runtime.id ? requestedFilenames.get(item.id) : undefined;
  if (!filename) {
    suggest();
    return;
  }

  requestedFilenames.delete(item.id);
  suggest({ filename, conflictAction: "uniquify" });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
    requestedFilenames.delete(delta.id);
  }
});

function hasExactKeys(value, keys) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function isAllowedFeedSender(sender) {
  return sender?.url === chrome.runtime.getURL("index.html");
}

function validateFeedRequest(message) {
  if (
    !hasExactKeys(message, ["type", "url", "referer", "body"]) ||
    message.type !== FEED_REQUEST_TYPE ||
    typeof message.url !== "string" ||
    typeof message.referer !== "string" ||
    typeof message.body !== "string"
  ) return null;

  try {
    const url = new URL(message.url);
    const queryKeys = [...url.searchParams.keys()].sort();
    const requestId = url.searchParams.get("_rid");
    if (
      url.origin !== CHANNELS_ORIGIN ||
      url.pathname !== new URL(API_URLS.feedInfo).pathname ||
      url.username ||
      url.password ||
      url.hash ||
      queryKeys.length !== 2 ||
      queryKeys[0] !== "_pageUrl" ||
      queryKeys[1] !== "_rid" ||
      url.searchParams.get("_pageUrl") !== CHANNELS_FEED_PAGE_URL ||
      !requestId ||
      !FEED_REQUEST_ID_PATTERN.test(requestId)
    ) return null;

    const expectedUrl = new URL(API_URLS.feedInfo);
    expectedUrl.searchParams.set("_rid", requestId);
    expectedUrl.searchParams.set("_pageUrl", CHANNELS_FEED_PAGE_URL);
    if (url.href !== expectedUrl.href || /[|*^]/.test(url.href)) return null;

    const referer = new URL(message.referer);
    if (
      referer.origin !== CHANNELS_ORIGIN ||
      referer.pathname !== new URL(CHANNELS_FEED_PAGE_URL).pathname ||
      referer.username ||
      referer.password ||
      referer.hash
    ) return null;

    const token = referer.searchParams.get("token");
    const exportId = referer.searchParams.get("eid");
    if (!token || !exportId) return null;

    const body = JSON.parse(message.body);
    if (
      !hasExactKeys(body, ["baseReq", "exportId"]) ||
      !hasExactKeys(body.baseReq, ["generalToken"]) ||
      body.baseReq.generalToken !== token ||
      body.exportId !== exportId
    ) return null;

    return { url: expectedUrl.href, referer: message.referer, body: message.body };
  } catch {
    return null;
  }
}

function feedHeaderRule(request) {
  return {
    id: FEED_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Origin", operation: "set", value: CHANNELS_ORIGIN },
        { header: "Referer", operation: "set", value: request.referer },
      ],
    },
    condition: {
      urlFilter: `|${request.url}|`,
      isUrlFilterCaseSensitive: true,
      initiatorDomains: [chrome.runtime.id],
      requestMethods: ["post"],
      resourceTypes: ["xmlhttprequest"],
    },
  };
}

async function fetchFeedInfo(request) {
  let result = FAILURE_RESULT;
  let timeoutId;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [FEED_RULE_ID],
      addRules: [feedHeaderRule(request)],
    });

    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: request.body,
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      result = {
        status: response.status,
        body: response.ok ? await response.text() : "",
      };
    } catch {
      result = {
        ...FAILURE_RESULT,
        failure: controller.signal.aborted ? "timeout" : "failed",
      };
    }
  } catch {
    result = FAILURE_RESULT;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [FEED_RULE_ID] });
    } catch {
      result = FAILURE_RESULT;
    }
  }
  return result;
}

function queueFeedRequest(request) {
  const operation = feedRequestQueue.then(async () => {
    await initialRuleCleanup;
    return fetchFeedInfo(request);
  });
  feedRequestQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === PAGE_DOWNLOAD_TYPE) {
    if (
      sender?.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.url !== chrome.runtime.getURL("index.html") ||
      !hasExactKeys(message, ["type", "filename", "downloadUrl"]) ||
      typeof message.filename !== "string" ||
      typeof message.downloadUrl !== "string"
    ) return;
    void startTrackedDownload({ downloadUrl: message.downloadUrl }, chrome, message.filename).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }

  if (message?.type === LOGIN_REFRESH_TYPE) {
    if (
      sender?.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      sender.url !== chrome.runtime.getURL("index.html") ||
      !hasExactKeys(message, ["type"])
    ) return;
    void loginState.refresh().then(
      (state) => sendResponse({ ok: true, state }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }

  if (message?.type === AUTH_FAILURE_TYPE) {
    if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 ||
        sender.url !== chrome.runtime.getURL("index.html") || !hasExactKeys(message, ["type"])) return;
    void loginState.markAuthenticationFailure({ code: "AUTH_EXPIRED" }).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }

  if (message?.type !== FEED_REQUEST_TYPE) return;
  if (
    sender?.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !isAllowedFeedSender(sender)
  ) return;
  const request = validateFeedRequest(message);
  if (!request) return;
  void queueFeedRequest(request).then(sendResponse, () => sendResponse(FAILURE_RESULT));
  return true;
});

let offscreenReady;
async function ensureOffscreenDocument() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const url = chrome.runtime.getURL(OFFSCREEN_URL);
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [url],
      });
      if (!contexts.length) {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ["IFRAME_SCRIPTING", "LOCAL_STORAGE"],
          justification: "在后台通过隐藏框架访问固定元宝解析接口。",
        });
      }
    })().catch((error) => {
      offscreenReady = undefined;
      throw error;
    });
  }
  return offscreenReady;
}

let nativeConnection;
let nativeRequestQueue = Promise.resolve();
let nativeConnectionStateQueue = Promise.resolve();

function setNativeConnectionState(stage, reason) {
  const state = {
    version: 1,
    stage,
    ...(reason ? { reason } : {}),
  };
  nativeConnectionStateQueue = nativeConnectionStateQueue.then(() =>
    chrome.storage.local.set({ [CONNECTION_STORAGE_KEY]: state })
  ).catch(() => {});
}

function classifyNativeDisconnect(message) {
  if (typeof message !== "string") return "host_disconnected";
  if (/specified native messaging host not found/i.test(message)) return "host_not_found";
  if (/native messaging host.*is not registered/i.test(message)) return "host_not_registered";
  if (/failed to start native messaging host/i.test(message)) return "host_start_failed";
  if (/access to the specified native messaging host is forbidden/i.test(message)) return "host_access_forbidden";
  if (/native host has exited/i.test(message)) return "host_exited";
  if (/error when communicating with the native messaging host/i.test(message)) return "host_communication_failed";
  return "host_disconnected";
}

async function scheduleReconnect() {
  await chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
}

function disconnectNative(connection, reason = "invalid_host_message") {
  if (nativeConnection !== connection) return;
  nativeConnection = undefined;
  setNativeConnectionState("failed", reason);
  try { connection.port.disconnect(); }
  catch { /* A disconnected Native Messaging port has no further work to do. */ }
  void scheduleReconnect(connection.ready);
}

function connectNative(instanceId) {
  if (nativeConnection?.instanceId === instanceId) {
    setNativeConnectionState(nativeConnection.ready ? "host_ready" : "host_starting");
    return;
  }
  if (nativeConnection) {
    const previous = nativeConnection;
    nativeConnection = undefined;
    try { previous.port.disconnect(); }
    catch { /* A replaced Native Messaging port has no further work to do. */ }
  }
  let port;
  try { port = chrome.runtime.connectNative(NATIVE_HOST_NAME); }
  catch {
    setNativeConnectionState("failed", "connect_native_failed");
    void scheduleReconnect();
    return;
  }
  setNativeConnectionState("host_starting");
  const connection = { port, instanceId, ready: false };
  nativeConnection = connection;
  port.onMessage.addListener((message) => {
    if (nativeConnection !== connection) return;
    if (message?.type === "ready") {
      if (hasExactKeys(message, ["type", "version"]) && message.version === 1) {
        disconnectNative(connection, "protocol_unsupported");
        return;
      }
      if (hasExactKeys(message, ["type", "version", "instanceId"]) &&
          Number.isSafeInteger(message.version) && message.version > 2 && message.instanceId === instanceId) {
        disconnectNative(connection, "protocol_unsupported");
        return;
      }
      if (!hasExactKeys(message, ["type", "version", "instanceId"]) || message.version !== 2 || message.instanceId !== instanceId) {
        disconnectNative(connection, "invalid_ready_message");
        return;
      }
      connection.ready = true;
      setNativeConnectionState("host_ready");
      return;
    }
    if (!connection.ready || !validateBridgeCommand(message)) {
      disconnectNative(connection, "invalid_host_message");
      return;
    }
    nativeRequestQueue = nativeRequestQueue.then(async () => {
      if (nativeConnection !== connection) return;
      const response = await handleAgentCommand(message);
      if (nativeConnection === connection) connection.port.postMessage(response);
    }).catch(() => disconnectNative(connection, "host_communication_failed"));
  });
  port.onDisconnect.addListener(() => {
    if (nativeConnection !== connection) return;
    nativeConnection = undefined;
    const reason = classifyNativeDisconnect(chrome.runtime.lastError?.message);
    setNativeConnectionState("failed", reason);
    return scheduleReconnect(connection.ready);
  });
  try { port.postMessage({ type: "hello", version: 2, instanceId }); }
  catch { disconnectNative(connection, "host_communication_failed"); }
}

function workerRequestFactory() {
  return createExtensionRequest(fetch, async (body) => {
    await ensureOffscreenDocument();
    const result = await chrome.runtime.sendMessage({ type: OFFSCREEN_PARSE_TYPE, body });
    if (!result || !Number.isInteger(result.status) || typeof result.body !== "string") {
      throw new TypeError("The offscreen request returned an invalid response");
    }
    return new Response([204, 205, 304].includes(result.status) ? null : result.body, {
      status: result.status,
    });
  }, (request) => {
    const validated = validateFeedRequest({ type: FEED_REQUEST_TYPE, ...request });
    if (!validated) throw new TypeError("The feed request is invalid");
    return queueFeedRequest(validated).then((result) => {
      if (result.status === 0) {
        throw new ParseError("UPSTREAM_ERROR", result.failure === "timeout" ? "视频详情请求超时。" : "视频详情请求失败。");
      }
      return new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status });
    });
  });
}

const handleAgentCommand = createAgentCommandHandler({
  chromeApi: chrome,
  requestFactory: workerRequestFactory,
  statusProvider: (options) => loginState.status(options),
  instanceIdProvider: () => getInstanceId(chrome),
  onAuthenticationFailure: (error) => loginState.markAuthenticationFailure(error),
  downloadStarter: startTrackedDownload,
  downloadWaiter: waitForDownload,
});

const loginState = createLoginStateManager({ chromeApi: chrome, requestFactory: workerRequestFactory });
let instanceIdPromise;

async function restoreConnection() {
  if (!instanceIdPromise) instanceIdPromise = getInstanceId(chrome);
  const instanceId = await instanceIdPromise;
  if (!INSTANCE_ID_PATTERN.test(instanceId)) throw new Error("INSTANCE_ID_INVALID");
  connectNative(instanceId);
}

async function startBackgroundServices() {
  await chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
  await restoreConnection();
  void loginState.start();
}

chrome.runtime.onStartup.addListener(() => { void startBackgroundServices(); });
chrome.runtime.onInstalled.addListener(() => { void startBackgroundServices(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !nativeConnection) return void restoreConnection().catch(() => {});
  if (alarm.name === LOGIN_REFRESH_ALARM) return void loginState.refresh().catch(() => {});
});

void startBackgroundServices().catch(() => {});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("index.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
  const existingTab = contexts.find((context) => context.tabId >= 0);
  if (existingTab) {
    await chrome.tabs.update(existingTab.tabId, { active: true });
    await chrome.windows.update(existingTab.windowId, { focused: true });
  }
  else await chrome.tabs.create({ url });
});
