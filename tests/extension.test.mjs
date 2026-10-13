import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  createExtensionRequest,
  safeFilename,
  startDownload,
  waitForDownload,
} from "../extension/app.mjs";
import { createAgentCommandHandler } from "../extension/agent.mjs";
import { createLoginStateManager, getInstanceId, LOGIN_REFRESH_ALARM, LOGIN_STORAGE_KEY } from "../extension/agent-state.mjs";
import {
  RELEASE_CHECK_STORAGE_KEY,
  STORE_EXTENSION_ID,
  UPDATE_ACTION_TYPE,
  UPDATE_STATE_CHANGED_TYPE,
  UPDATE_STATE_TYPE,
  UPDATE_STORAGE_KEY,
  createUpdateStateManager,
} from "../extension/update-state.mjs";
import { initializeUpdateUi } from "../extension/update-ui.mjs";
import { API_URLS } from "../src/core.mjs";

function createHiddenIframeHarness() {
  const iframeListeners = new Map();
  const messageListeners = new Set();
  const requestMessages = [];
  let removeCount = 0;
  let timeoutCallback;
  let timeoutCleared = false;
  const iframe = {
    contentWindow: {
      postMessage(message, targetOrigin) {
        requestMessages.push({ message, targetOrigin });
      },
    },
    addEventListener(type, listener) {
      if (!iframeListeners.has(type)) iframeListeners.set(type, new Set());
      iframeListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      iframeListeners.get(type)?.delete(listener);
    },
    setAttribute() {},
    remove() { removeCount += 1; },
    dispatch(type) {
      for (const listener of [...(iframeListeners.get(type) ?? [])]) listener();
    },
  };
  const windowApi = {
    crypto: { randomUUID: () => "123e4567-e89b-42d3-a456-426614174000" },
    addEventListener(type, listener) {
      assert.equal(type, "message");
      messageListeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "message");
      messageListeners.delete(listener);
    },
    setTimeout(callback, delay) {
      assert.equal(delay, 15_000);
      timeoutCallback = callback;
      return 1;
    },
    clearTimeout(timeoutId) {
      assert.equal(timeoutId, 1);
      timeoutCleared = true;
    },
  };
  const documentApi = {
    createElement(tag) {
      assert.equal(tag, "iframe");
      return iframe;
    },
    body: {
      append(element) {
        assert.equal(element, iframe);
        element.dispatch("load");
      },
    },
  };

  return {
    documentApi,
    windowApi,
    iframe,
    requestMessages,
    dispatchMessage(message, source = iframe.contentWindow, origin = "https://yuanbao.tencent.com") {
      for (const listener of [...messageListeners]) listener({ data: message, source, origin });
    },
    expire() { timeoutCallback(); },
    get state() {
      return {
        iframeRemoved: removeCount === 1,
        iframeLoadListeners: iframeListeners.get("load")?.size ?? 0,
        iframeErrorListeners: iframeListeners.get("error")?.size ?? 0,
        messageListeners: messageListeners.size,
        timeoutCleared,
      };
    },
  };
}

async function withHiddenIframeHarness(harness, callback) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", { configurable: true, value: harness.documentApi });
  Object.defineProperty(globalThis, "window", { configurable: true, value: harness.windowApi });
  try {
    return await callback();
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
}

async function withBackgroundHarness({ fetchImpl, timerApi, initialStorage = { [LOGIN_STORAGE_KEY]: { login: "anonymous", checkedAt: Date.now() } }, initialAlarms = {}, offscreenMessenger, extensionId = "synthetic-extension-id", pageContexts = [] } = {}, callback) {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const previousSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  const previousClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
  const rules = new Map();
  const updates = [];
  const timeline = [];
  const fetchCalls = [];
  const releaseFetchCalls = [];
  let messageListener;
  const event = () => {
    const listeners = new Set();
    return {
      addListener(listener) { listeners.add(listener); },
      async fire(value) {
        return Promise.all([...listeners].map((listener) => listener(value)));
      },
    };
  };
  const onStartup = event();
  const onInstalled = event();
  const onAlarm = event();
  const onDownloadDeterminingFilename = event();
  const onDownloadCreated = event();
  const onDownloadChanged = event();
  const onUpdateAvailable = event();
  const onTabRemoved = event();
  const storage = new Map(Object.entries(initialStorage));
  const alarms = new Map(Object.entries(initialAlarms));
  const tabContexts = pageContexts;
  const ports = [];
  let offscreenCreated = false;
  const chromeApi = {
    downloads: {
      onDeterminingFilename: onDownloadDeterminingFilename,
      onCreated: onDownloadCreated,
      onChanged: onDownloadChanged,
      async search() { return []; },
    },
    runtime: {
      id: extensionId,
      getURL: (path) => `chrome-extension://${extensionId}/${path}`,
      onMessage: { addListener: (listener) => { messageListener = listener; } },
      onStartup,
      onInstalled,
      onUpdateAvailable,
      getContexts: async (filter) => filter.contextTypes.includes("OFFSCREEN_DOCUMENT")
        ? (offscreenCreated ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [])
        : tabContexts,
      getManifest: () => ({ version: "0.2.4" }),
      reload() { timeline.push("reload"); },
      sendMessage: async (message) => {
        if (!offscreenMessenger) throw new Error("no offscreen test responder");
        return offscreenMessenger(message);
      },
      connectNative: (name) => {
        assert.equal(name, "com.mc0571.weixin_channels_video");
        const port = {
          onMessage: event(),
          onDisconnect: event(),
          messages: [],
          disconnects: 0,
          postMessage(value) { this.messages.push(value); timeline.push("postMessage"); },
          disconnect() { this.disconnects += 1; timeline.push("disconnect"); void this.onDisconnect.fire(); },
        };
        ports.push(port);
        return port;
      },
    },
    storage: { local: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.map((key) => [key, storage.get(key)]));
      },
      async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
    } },
    offscreen: { createDocument: async (options) => { offscreenCreated = true; return options; } },
    alarms: {
      onAlarm,
      async clear(name) { return alarms.delete(name); },
      async get(name) { return alarms.get(name); },
      create(name, options) { alarms.set(name, options); },
    },
    declarativeNetRequest: {
      updateSessionRules: async (change) => {
        updates.push(structuredClone(change));
        for (const id of change.removeRuleIds ?? []) rules.delete(id);
        for (const rule of change.addRules ?? []) rules.set(rule.id, structuredClone(rule));
      },
    },
    action: { onClicked: { addListener() {} }, async setBadgeText() {} },
    tabs: { create() {}, onRemoved: onTabRemoved },
    windows: { update() {} },
    management: { getSelf: async () => ({ id: extensionId, installType: "normal" }) },
  };
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: chromeApi });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url, init) => {
      if (String(url).startsWith("https://api.github.com/repos/MC0571/weixin-channels-video/releases?")) {
        releaseFetchCalls.push({ url, init });
        return Response.json([{
          tag_name: "extension-v0.2.4",
          draft: false,
          prerelease: false,
          assets: [{ name: "weixin-channels-video-extension-v0.2.4.zip" }],
        }]);
      }
      fetchCalls.push({ url, init });
      return fetchImpl ? fetchImpl(url, init) : Response.json({ ok: true });
    },
  });
  if (timerApi) {
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: timerApi.setTimeout });
    Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: timerApi.clearTimeout });
  }

  const restore = (name, descriptor) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
  try {
    await import(`../extension/background.mjs?test=${Date.now()}-${Math.random()}`);
    const defaultSender = {
      id: extensionId,
      frameId: 0,
      url: `chrome-extension://${extensionId}/index.html`,
    };
    const send = (message, sender = defaultSender) => new Promise((resolve) => {
      const handled = messageListener(message, sender, resolve);
      if (handled !== true) resolve(undefined);
    });
    return await callback({
      chromeApi, extensionId, fetchCalls, releaseFetchCalls, updates, rules, send,
      onStartup, onInstalled, onAlarm, onUpdateAvailable, storage, alarms, ports, timeline,
      get offscreenCreated() { return offscreenCreated; },
    });
  } finally {
    restore("chrome", previousChrome);
    restore("fetch", previousFetch);
    restore("setTimeout", previousSetTimeout);
    restore("clearTimeout", previousClearTimeout);
  }
}

function createFeedRequest({ rid = "abc123-12345678", token = "synthetic-token", eid = "synthetic-eid" } = {}) {
  const pageUrl = "https://channels.weixin.qq.com/finder-preview/pages/feed";
  const url = new URL(API_URLS.feedInfo);
  url.searchParams.set("_rid", rid);
  url.searchParams.set("_pageUrl", pageUrl);
  return {
    type: "weixin-channels-video:feed-request",
    url: url.href,
    referer: `${pageUrl}?eid=${encodeURIComponent(eid)}&tracking=synthetic&token=${encodeURIComponent(token)}`,
    body: JSON.stringify({ baseReq: { generalToken: token }, exportId: eid }),
  };
}

test("extension requests only fixed APIs with isolated credentials and browser-owned headers", async () => {
  const calls = [];
  const request = createExtensionRequest(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true });
  });

  await request(API_URLS.userInfo, {
    method: "GET",
    headers: {
      Origin: "https://yuanbao.tencent.com",
      Referer: "https://yuanbao.tencent.com/chat?private=value",
      Cookie: "must-not-be-set-by-extension-code",
      Authorization: "must-not-cross-origin",
    },
  });
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.has("origin"), false);
  assert.equal(calls[0].init.headers.has("referer"), false);
  assert.equal(calls[0].init.headers.has("cookie"), false);
  assert.equal(calls[0].init.headers.has("authorization"), false);

  await assert.rejects(request("https://attacker.example/collect", { method: "POST" }), TypeError);
  await assert.rejects(request(API_URLS.userInfo, { method: "POST" }), TypeError);
  assert.equal(calls.length, 1);
});

test("hidden Yuanbao iframe requester preserves HTTP status and cleans up", async () => {
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const parseBody = JSON.stringify({
    type: "video_channel_url",
    url: "https://weixin.qq.com/sph/synthetic-id",
    scene: 1,
  });
  const harness = createHiddenIframeHarness();
  await withHiddenIframeHarness(harness, async () => {
    const request = createExtensionRequest(async () => assert.fail("Yuanbao parse must use the hidden iframe"));
    const responsePromise = request(API_URLS.parseShare, { method: "POST", body: parseBody });
    const [{ message, targetOrigin }] = harness.requestMessages;
    assert.equal(harness.iframe.hidden, true);
    assert.equal(harness.iframe.src, "https://yuanbao.tencent.com/");
    assert.equal(harness.iframe.title, "");
    assert.equal(harness.iframe.tabIndex, -1);
    assert.deepEqual({ ...message }, {
      type: "weixin-channels-video:api-request",
      requestId,
      body: parseBody,
    });
    assert.equal(targetOrigin, "https://yuanbao.tencent.com");

    const resultMessage = {
      type: "weixin-channels-video:api-response",
      requestId,
      status: 200,
      body: "{\"code\":0}",
    };
    harness.dispatchMessage(resultMessage, {}, "https://yuanbao.tencent.com");
    harness.dispatchMessage(resultMessage, harness.iframe.contentWindow, "https://attacker.example");
    harness.dispatchMessage({ ...resultMessage, requestId: "223e4567-e89b-42d3-a456-426614174000" });
    assert.equal(harness.state.iframeRemoved, false);
    assert.equal(harness.state.messageListeners, 1);

    harness.dispatchMessage(resultMessage);
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "{\"code\":0}");
    assert.deepEqual(harness.state, {
      iframeRemoved: true,
      iframeLoadListeners: 0,
      iframeErrorListeners: 0,
      messageListeners: 0,
      timeoutCleared: true,
    });
  });
});

test("feed request adapter forwards the core request and preserves HTTP 401", async () => {
  const pageUrl = "https://channels.weixin.qq.com/finder-preview/pages/feed";
  const referer = `${pageUrl}?eid=synthetic-eid&token=synthetic-token`;
  const url = new URL(API_URLS.feedInfo);
  url.searchParams.set("_rid", "synthetic-rid");
  url.searchParams.set("_pageUrl", pageUrl);
  const body = JSON.stringify({ baseReq: { generalToken: "synthetic-token" }, exportId: "synthetic-eid" });
  const forwarded = [];
  const request = createExtensionRequest(
    async () => assert.fail("feed requests use the background bridge"),
    async () => assert.fail("feed requests do not use the Yuanbao iframe"),
    async (value) => {
      forwarded.push(value);
      return new Response(null, { status: 401 });
    },
  );

  const response = await request(url.href, {
    method: "POST",
    headers: { referer },
    body,
  });
  assert.equal(response.status, 401);
  assert.deepEqual(forwarded, [{ url: url.href, referer, body }]);
});

test("feed request adapter maps background failures to fixed safe messages", async () => {
  const pageUrl = "https://channels.weixin.qq.com/finder-preview/pages/feed";
  const url = new URL(API_URLS.feedInfo);
  url.searchParams.set("_rid", "synthetic-rid");
  url.searchParams.set("_pageUrl", pageUrl);
  const referer = `${pageUrl}?token=synthetic-secret&eid=synthetic-eid`;
  const body = JSON.stringify({ baseReq: { generalToken: "synthetic-secret" }, exportId: "synthetic-eid" });
  const previousChrome = globalThis.chrome;
  const messages = [];

  try {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          return { status: 0, body: "", failure: "timeout" };
        },
      },
    };
    const request = createExtensionRequest(async () => assert.fail("feed requests use the background bridge"));
    await assert.rejects(request(url.href, { method: "POST", headers: { referer }, body }), (error) => {
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.equal(error.message, "视频详情请求超时。");
      assert.equal(error.message.includes("synthetic-secret"), false);
      return true;
    });
    assert.deepEqual(messages, [{
      type: "weixin-channels-video:feed-request",
      url: url.href,
      referer,
      body,
    }]);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("Yuanbao frame bridge routes only the fixed request with browser credentials", async () => {
  const source = await readFile(new URL("../extension/yuanbao-frame.js", import.meta.url), "utf8");
  const extensionOrigin = "chrome-extension://synthetic-extension-id";
  assert.equal(new URL(extensionOrigin + "/").origin, "null");
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const parseBody = JSON.stringify({ type: "video_channel_url" });
  const fetchCalls = [];
  const messages = [];
  const listeners = [];
  const parent = {
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
    },
  };
  const windowApi = {
    parent,
    addEventListener(type, listener) {
      assert.equal(type, "message");
      listeners.push(listener);
    },
  };
  runInNewContext(source, {
    window: windowApi,
    location: { origin: "https://yuanbao.tencent.com", pathname: "/" },
    chrome: { runtime: { getURL: () => extensionOrigin + "/" } },
    URL,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return { status: 200, ok: true, text: async () => "{\"code\":0}" };
    },
  });

  const requestMessage = {
    type: "weixin-channels-video:api-request",
    requestId,
    body: parseBody,
  };
  const listener = listeners[0];
  listener({ source: {}, origin: extensionOrigin, data: requestMessage });
  listener({ source: parent, origin: "https://attacker.example", data: requestMessage });
  listener({ source: parent, origin: extensionOrigin, data: { ...requestMessage, extra: true } });
  listener({ source: parent, origin: extensionOrigin, data: { ...requestMessage, requestId: "bad" } });
  assert.equal(fetchCalls.length, 0);

  listener({ source: parent, origin: extensionOrigin, data: requestMessage });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url, "https://yuanbao.tencent.com/api/weixin/get_parse_result");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body, parseBody);
  assert.equal(call.init.credentials, "include");
  assert.equal(call.init.redirect, "error");
  assert.deepEqual({ ...call.init.headers }, {
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.deepEqual(messages.map(({ message, targetOrigin }) => ({
    message: { ...message },
    targetOrigin,
  })), [{
    message: {
      type: "weixin-channels-video:api-response",
      requestId,
      status: 200,
      body: "{\"code\":0}",
    },
    targetOrigin: extensionOrigin,
  }]);
  listener({ source: parent, origin: extensionOrigin, data: requestMessage });
  assert.equal(fetchCalls.length, 1);
});

test("background feed bridge restricts its sender and API request while preserving the core referer", async () => {
  const request = createFeedRequest();
  await withBackgroundHarness({
    fetchImpl: async () => ({ status: 401, ok: false, text: async () => assert.fail("401 body must not be read") }),
  }, async ({ extensionId, fetchCalls, rules, send, updates }) => {
    const badSender = { id: "other-extension", frameId: 0, url: `chrome-extension://${extensionId}/index.html` };
    const badUrl = { ...request, url: "https://attacker.example/collect" };
    const badRid = { ...request, url: request.url.replace("abc123-12345678", "bad-rid") };
    const badBody = { ...request, body: JSON.stringify({ baseReq: { generalToken: "other-token" }, exportId: "synthetic-eid" }) };
    assert.equal(await send(request, badSender), undefined);
    assert.equal(await send(request, { ...badSender, id: extensionId, frameId: 2 }), undefined);
    assert.equal(await send(request, { id: extensionId, frameId: 0, url: `chrome-extension://${extensionId}/other.html` }), undefined);
    assert.equal(await send(badUrl), undefined);
    assert.equal(await send(badRid), undefined);
    assert.equal(await send(badBody), undefined);
    assert.equal(fetchCalls.length, 0);

    const result = await send(request);
    assert.deepEqual(result, { status: 401, body: "" });
    assert.equal(fetchCalls.length, 1);
    const [call] = fetchCalls;
    assert.equal(call.url, request.url);
    assert.equal(call.init.method, "POST");
    assert.deepEqual({ ...call.init.headers }, {
      accept: "application/json",
      "content-type": "application/json",
    });
    assert.equal(call.init.body, request.body);
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.redirect, "error");
    assert.equal(rules.size, 0);
    assert.equal(updates.length, 3);
    assert.deepEqual(updates[0], { removeRuleIds: [1] });
    assert.deepEqual(updates[1].removeRuleIds, [1]);
    assert.deepEqual(updates[2], { removeRuleIds: [1] });
    assert.deepEqual(updates[1].addRules[0], {
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin", operation: "set", value: "https://channels.weixin.qq.com" },
          { header: "Referer", operation: "set", value: request.referer },
        ],
      },
      condition: {
        urlFilter: `|${request.url}|`,
        isUrlFilterCaseSensitive: true,
        initiatorDomains: [extensionId],
        requestMethods: ["post"],
        resourceTypes: ["xmlhttprequest"],
      },
    });
  });
});

test("background feed bridge aborts timed-out requests and removes its session rule", async () => {
  let timeoutCallback;
  const clearedTimers = [];
  await withBackgroundHarness({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    timerApi: {
      setTimeout(callback, delay) {
        assert.equal(delay, 15_000);
        timeoutCallback = callback;
        return "feed-timeout";
      },
      clearTimeout(id) { clearedTimers.push(id); },
    },
  }, async ({ fetchCalls, rules, send }) => {
    const pending = send(createFeedRequest());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchCalls.length, 1);
    assert.equal(rules.size, 1);
    timeoutCallback();
    assert.deepEqual(await pending, { status: 0, body: "", failure: "timeout" });
    assert.equal(rules.size, 0);
    assert.deepEqual(clearedTimers, ["feed-timeout"]);
  });
});

test("background feed bridge serializes referer rules and cleans up after network failure", async () => {
  let finishFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  await withBackgroundHarness({
    fetchImpl: async (_url, init) => {
      if (!finishFirst) {
        markFirstStarted();
        return new Promise((resolve) => { finishFirst = resolve; });
      }
      throw new Error("synthetic network failure");
    },
  }, async ({ fetchCalls, rules, send, updates }) => {
    const firstRequest = createFeedRequest({ rid: "aaa-12345678", token: "first-token", eid: "first-eid" });
    const secondRequest = createFeedRequest({ rid: "bbb-12345678", token: "second-token", eid: "second-eid" });
    const first = send(firstRequest);
    await firstStarted;
    const second = send(secondRequest);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fetchCalls.length, 1);
    assert.equal(rules.get(1).action.requestHeaders[1].value, firstRequest.referer);
    finishFirst({ status: 200, ok: true, text: async () => "{\"first\":true}" });
    assert.deepEqual(await first, { status: 200, body: "{\"first\":true}" });
    assert.deepEqual(await second, { status: 0, body: "", failure: "failed" });

    assert.equal(fetchCalls.length, 2);
    assert.equal(rules.size, 0);
    assert.equal(updates[1].addRules[0].action.requestHeaders[1].value, firstRequest.referer);
    assert.equal(updates[3].addRules[0].action.requestHeaders[1].value, secondRequest.referer);
    assert.deepEqual(updates[2], { removeRuleIds: [1] });
    assert.deepEqual(updates[4], { removeRuleIds: [1] });
  });
});

test("background feed bridge accepts only the exact extension index page", async () => {
  await withBackgroundHarness({}, async ({ extensionId, fetchCalls, send }) => {
    const request = createFeedRequest();
    const invalidUrls = [
      `chrome-extension://${extensionId}/index.html?agent-connect`,
      `chrome-extension://${extensionId}/agent.html`,
      `chrome-extension://${extensionId}/other.html`,
    ];
    for (const url of invalidUrls) {
      assert.equal(await send(request, { id: extensionId, frameId: 0, url }), undefined);
    }
    assert.equal(fetchCalls.length, 0);
    assert.equal((await send(request, { id: extensionId, frameId: 0, url: `chrome-extension://${extensionId}/index.html` })).status, 200);
    assert.equal(fetchCalls.length, 1);
  });
});

test("download filenames are safe and existing files are uniquified", async () => {
  let options;
  const chromeApi = {
    downloads: {
      download: async (value) => {
        options = value;
        return 27;
      },
    },
  };

  const id = await startDownload({
    title: "../clip: one?.mp4",
    downloadUrl: "https://media.example/video.mp4?sig=synthetic-signature",
  }, chromeApi);

  assert.equal(id, 27);
  assert.equal(options.url, "https://media.example/video.mp4?sig=synthetic-signature");
  assert.equal(options.filename, safeFilename("../clip: one?.mp4"));
  assert.equal(options.filename.includes("/"), false);
  assert.equal(options.filename.includes(".."), false);
  assert.equal(options.conflictAction, "uniquify");
  assert.equal("saveAs" in options, false);
  for (const title of ["中".repeat(90), "中".repeat(100), "😀".repeat(100)]) {
    options = undefined;
    await startDownload({ title, downloadUrl: "https://media.example/video.mp4" }, chromeApi);
    assert.equal(options.filename, safeFilename(title));
    assert.ok(new TextEncoder().encode(options.filename).byteLength <= 255);
    assert.equal(options.conflictAction, "uniquify");
  }
  await startDownload({ title: "unused", downloadUrl: "https://media.example/video.mp4" }, chromeApi, "Clips/custom.mp4");
  assert.equal(options.filename, "Clips/custom.mp4");
  await assert.rejects(
    startDownload({ title: "clip", downloadUrl: "https://media.example/video.mp4" }, chromeApi, "../unsafe.mp4"),
    TypeError,
  );
  await assert.rejects(
    startDownload({ title: "clip", downloadUrl: "javascript:alert(1)" }, chromeApi),
    TypeError,
  );
});

test("waitForDownload follows one Chrome ID through its terminal state and removes its listener", async () => {
  const listeners = new Set();
  const current = { id: 42, state: "in_progress", filename: "/Users/test/Downloads/clip.mp4", bytesReceived: 0 };
  const searchQueries = [];
  const chromeApi = {
    downloads: {
      onChanged: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
      },
      async search(query) {
        searchQueries.push(query);
        return [current];
      },
    },
  };
  const pending = waitForDownload(42, chromeApi, 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listeners.size, 1);
  current.state = "complete";
  current.bytesReceived = 1234;
  for (const listener of [...listeners]) listener({ id: 42, state: { current: "complete" } });
  assert.deepEqual(await pending, {
    state: "complete",
    path: "/Users/test/Downloads/clip.mp4",
    bytes: 1234,
  });
  assert.deepEqual(searchQueries, [{ id: 42 }, { id: 42 }]);
  assert.equal(listeners.size, 0);
});

test("waitForDownload times out with zero listeners and rejects zero-byte terminal downloads", async () => {
  const listeners = new Set();
  const chromeApi = {
    downloads: {
      onChanged: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
      },
      async search() { return [{ id: 12, state: "in_progress", filename: "/tmp/clip.mp4", bytesReceived: 0 }]; },
    },
  };
  await assert.rejects(waitForDownload(12, chromeApi, 10), /DOWNLOAD_TIMEOUT/);
  assert.equal(listeners.size, 0);
  chromeApi.downloads.search = async () => [{ id: 12, state: "complete", filename: "/tmp/clip.mp4", bytesReceived: 0 }];
  await assert.rejects(waitForDownload(12, chromeApi, 100), /DOWNLOAD_EMPTY/);
  assert.equal(listeners.size, 0);
});

test("manifest requests only required extension and upstream-host permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.deepEqual(manifest.permissions, ["downloads", "declarativeNetRequestWithHostAccess", "nativeMessaging", "storage", "offscreen", "alarms"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://yuanbao.tencent.com/*",
    "https://channels.weixin.qq.com/*",
  ]);
  assert.deepEqual(manifest.content_scripts, [{
    matches: ["https://yuanbao.tencent.com/*"],
    all_frames: true,
    run_at: "document_start",
    js: ["yuanbao-frame.js"],
  }]);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.action.default_popup, undefined);
  const index = await readFile(new URL("../extension/index.html", import.meta.url), "utf8");
  assert.match(index, /src="\.\/agent\.js"/);
  assert.doesNotMatch(index, /agent-connect-(?:toggle|status)/);
  assert.match(await readFile(new URL("../extension/offscreen.html", import.meta.url), "utf8"), /offscreen\.js/);
});

test("successful Agent parses trigger the shared first-success hook without opening the page", async () => {
  const successes = [];
  const handler = createAgentCommandHandler({
    chromeApi: {},
    requestFactory: () => async () => new Response(null, { status: 200 }),
    parser: async () => ({
      title: "A title",
      author: "An author",
      coverUrl: "https://media.example/cover.jpg",
      previewUrl: "https://media.example/video.mp4",
      downloadUrl: "https://media.example/video.mp4",
      mediaVariants: [],
    }),
    onParseSuccess: async ({ source }) => { successes.push(source); },
  });

  const response = await handler({
    id: "323e4567-e89b-42d3-a456-426614174000",
    command: "parse",
    url: "https://weixin.qq.com/sph/synthetic",
  }, { source: "agent" });

  assert.equal(response.ok, true);
  assert.deepEqual(successes, ["agent"]);
});

test("update notice mounts beside the header so it stays visible on the history page", async () => {
  class Element {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.hidden = false; }
    get nextSibling() {
      if (!this.parentNode) return null;
      return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] ?? null;
    }
    append(...children) {
      for (const child of children) {
        child.parentNode = this;
        this.children.push(child);
      }
    }
    insertBefore(child, reference) {
      if (reference && reference.parentNode !== this) throw new Error("reference is not a child");
      child.parentNode = this;
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      this.children.splice(index, 0, child);
    }
    setAttribute() {}
    addEventListener() {}
  }

  const shell = new Element("main");
  const header = new Element("header");
  header.className = "page-header";
  const homeView = new Element("div");
  const inputCard = new Element("section");
  inputCard.className = "input-card";
  const historyView = new Element("section");
  historyView.hidden = true;
  shell.append(header, homeView, historyView);
  homeView.append(inputCard);
  const documentApi = {
    querySelector(selector) {
      return selector === ".shell" ? shell
        : selector === ".input-card" ? inputCard
          : selector === ".page-header" ? header
            : null;
    },
    createElement: (tagName) => new Element(tagName),
  };

  initializeUpdateUi({ documentApi, chromeApi: { runtime: { sendMessage: async () => ({ ok: true, source: "unknown" }) } } });

  assert.equal(shell.children[1].className, "card update-card");
  assert.equal(homeView.children[0], inputCard);
  assert.equal(shell.children[2], homeView);
  assert.equal(shell.children[3], historyView);
});

test("external installs check only stable extension releases and cache the result", async () => {
  const storage = new Map();
  const requests = [];
  const notifications = [];
  const badgeTexts = [];
  let currentTime = 1_000_000;
  const chromeApi = {
    management: { getSelf: async () => ({ id: "unpacked-id", installType: "development" }) },
    action: { setBadgeText: async ({ text }) => { badgeTexts.push(text); } },
    runtime: {
      getManifest: () => ({ version: "0.2.4" }),
      sendMessage: async (message) => { notifications.push(message); },
    },
    storage: { local: {
      async get(key) { return { [key]: storage.get(key) }; },
      async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
    } },
  };
  const olderReleases = [
    { tag_name: "extension-v0.2.3", draft: false, prerelease: false, assets: [{ name: "weixin-channels-video-extension-v0.2.3.zip" }] },
    { tag_name: "extension-v9.0.0-rc.1", draft: false, prerelease: true },
    { tag_name: "extension-v8.0.0", draft: true, prerelease: false },
    ...Array.from({ length: 97 }, (_, index) => ({
      tag_name: `skill-v${index + 1}.0.0`, draft: false, prerelease: false,
    })),
  ];
  const manager = createUpdateStateManager({
    chromeApi,
    now: () => currentTime,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const page = new URL(url).searchParams.get("page");
      return Response.json(page === "1" ? olderReleases : [
        { tag_name: "extension-v0.2.5", draft: false, prerelease: false, assets: [{ name: "weixin-channels-video-extension-v0.2.5.zip" }] },
        { tag_name: "skill-v99.0.0", draft: false, prerelease: false },
      ]);
    },
  });

  const initialState = await manager.getState();
  assert.equal(initialState.releaseStatus, "checking");
  for (let attempt = 0; attempt < 20 && notifications.length === 0; attempt += 1) await new Promise(setImmediate);
  assert.equal(notifications[0].type, UPDATE_STATE_CHANGED_TYPE);
  const checkedState = await manager.getState();
  assert.equal(checkedState.releaseStatus, "available");
  assert.equal(checkedState.releaseVersion, "0.2.5");
  assert.equal(checkedState.releaseChangelogUrl, "https://github.com/MC0571/weixin-channels-video/releases/tag/extension-v0.2.5");
  assert.equal(badgeTexts.at(-1), "更新");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ url }) => url), [
    "https://api.github.com/repos/MC0571/weixin-channels-video/releases?per_page=100&page=1",
    "https://api.github.com/repos/MC0571/weixin-channels-video/releases?per_page=100&page=2",
  ]);
  for (const { init } of requests) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Accept, "application/vnd.github+json");
    assert.equal(Object.hasOwn(init.headers, "Authorization"), false);
    assert.equal(init.signal.aborted, false);
  }
  assert.equal((await manager.getState()).releaseStatus, "available");
  assert.equal(requests.length, 2, "a fresh result is reused rather than fetched on every page open");

  currentTime += 24 * 60 * 60 * 1000;
  assert.equal((await manager.getState()).releaseStatus, "checking");
  for (let attempt = 0; attempt < 20 && notifications.length < 2; attempt += 1) await new Promise(setImmediate);
  assert.equal((await manager.getState()).releaseVersion, "0.2.5");
  assert.equal(requests.length, 4);
  assert.equal(storage.has(RELEASE_CHECK_STORAGE_KEY), true);
});

test("failed or malformed release checks remain unknown", async () => {
  for (const [name, response] of [
    ["rate limit", new Response("", { status: 403 })],
    ["malformed JSON", new Response("not json", { status: 200 })],
    ["unexpected shape", Response.json({ releases: [] })],
    ["no extension release", Response.json([{ tag_name: "skill-v9.0.0", draft: false, prerelease: false }])],
  ]) {
    const storage = new Map();
    const chromeApi = {
      management: { getSelf: async () => ({ id: "unpacked-id", installType: "development" }) },
      action: { setBadgeText: async () => {} },
      runtime: { getManifest: () => ({ version: "0.2.4" }), sendMessage: async () => {} },
      storage: { local: {
        async get(key) { return { [key]: storage.get(key) }; },
        async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
      } },
    };
    const manager = createUpdateStateManager({ chromeApi, fetchImpl: async () => response });
    assert.equal((await manager.getState()).releaseStatus, "checking", name);
    for (let attempt = 0; attempt < 20 && !storage.has(RELEASE_CHECK_STORAGE_KEY); attempt += 1) await new Promise(setImmediate);
    const state = await manager.getState();
    assert.equal(state.releaseStatus, "unknown", name);
    assert.equal(state.releaseVersion, null, name);
  }
});

test("legacy stable releases count only when they include the extension archive", async () => {
  const storage = new Map();
  const chromeApi = {
    management: { getSelf: async () => ({ id: "unpacked-id", installType: "development" }) },
    action: { setBadgeText: async () => {} },
    runtime: { getManifest: () => ({ version: "0.2.4" }), sendMessage: async () => {} },
    storage: { local: {
      async get(key) { return { [key]: storage.get(key) }; },
      async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
    } },
  };
  const manager = createUpdateStateManager({
    chromeApi,
    fetchImpl: async () => Response.json([
      { tag_name: "v0.3.0", draft: false, prerelease: false, assets: [{ name: "weixin-channels-video-extension-v0.3.0.zip" }] },
      { tag_name: "v9.0.0", draft: false, prerelease: false, assets: [{ name: "weixin-channels-video-skill-v9.0.0.zip" }] },
    ]),
  });

  assert.equal((await manager.getState()).releaseStatus, "checking");
  for (let attempt = 0; attempt < 20 && !storage.has(RELEASE_CHECK_STORAGE_KEY); attempt += 1) await new Promise(setImmediate);
  const state = await manager.getState();
  assert.equal(state.releaseStatus, "available");
  assert.equal(state.releaseVersion, "0.3.0");
  assert.equal(state.releaseChangelogUrl, "https://github.com/MC0571/weixin-channels-video/releases/tag/v0.3.0");
});

test("store update notifies an already open page after persisting update state", async () => {
  class Element {
    constructor() { this.children = []; this.hidden = false; }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
    append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
    insertBefore(child, reference) {
      child.parentNode = this;
      this.children.splice(reference ? this.children.indexOf(reference) : this.children.length, 0, child);
    }
    setAttribute() {}
    addEventListener() {}
  }
  const shell = new Element();
  const header = new Element();
  header.className = "page-header";
  const inputCard = new Element();
  inputCard.className = "input-card";
  shell.append(header, inputCard);
  const storage = new Map();
  let onMessage;
  let manager;
  const chromeApi = {
    management: { getSelf: async () => ({ id: STORE_EXTENSION_ID, installType: "normal" }) },
    action: { setBadgeText: async () => {} },
    runtime: {
      getManifest: () => ({ version: "0.2.4" }),
      async sendMessage(message) {
        if (message.type === UPDATE_STATE_CHANGED_TYPE) {
          assert.equal(storage.get(UPDATE_STORAGE_KEY)?.availableVersion, "0.2.5");
          onMessage(message);
          return;
        }
        if (message.type === UPDATE_STATE_TYPE) return manager.getState();
      },
      onMessage: { addListener(listener) { onMessage = listener; } },
    },
    storage: { local: {
      async get(key) { return { [key]: storage.get(key) }; },
      async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
    } },
  };
  manager = createUpdateStateManager({ chromeApi });
  const documentApi = {
    querySelector(selector) { return selector === ".shell" ? shell : selector === ".input-card" ? inputCard : selector === ".page-header" ? header : null; },
    createElement: () => new Element(),
  };

  initializeUpdateUi({ documentApi, chromeApi });
  const card = shell.children[1];
  await new Promise(setImmediate);
  assert.equal(card.hidden, true, "the open page initially has no available update");

  await manager.updateAvailable("0.2.5");
  await new Promise(setImmediate);
  assert.equal(card.hidden, false);
  assert.equal(card.children[0].textContent, "已下载扩展更新 v0.2.5。");
});

test("external update notice is dismissible without clearing update state", async () => {
  class Element {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.hidden = false; this.listeners = new Map(); }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
    append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
    insertBefore(child, reference) { child.parentNode = this; this.children.splice(reference ? this.children.indexOf(reference) : this.children.length, 0, child); }
    setAttribute() {}
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    click() { this.listeners.get("click")?.(); }
  }
  const shell = new Element("main");
  const header = new Element("header");
  header.className = "page-header";
  const inputCard = new Element("section");
  inputCard.className = "input-card";
  shell.append(header, inputCard);
  let state = { ok: true, source: "external", version: "0.2.4", releaseStatus: "unknown", releaseUrl: "https://github.com/MC0571/weixin-channels-video/releases" };
  let onMessage;
  const sentMessages = [];
  const documentApi = {
    querySelector(selector) { return selector === ".shell" ? shell : selector === ".input-card" ? inputCard : selector === ".page-header" ? header : null; },
    createElement: (tagName) => new Element(tagName),
  };
  const chromeApi = {
    runtime: {
      sendMessage: async (message) => { sentMessages.push(message); return state; },
      onMessage: { addListener(listener) { onMessage = listener; } },
    },
  };
  initializeUpdateUi({ documentApi, chromeApi });
  const card = shell.children[1];
  await new Promise(setImmediate);
  assert.equal(card.hidden, true, "routine unknown state stays out of the way");

  state = {
    ...state,
    releaseStatus: "available",
    releaseVersion: "0.2.5",
    releaseChangelogUrl: "https://github.com/MC0571/weixin-channels-video/releases/tag/extension-v0.2.5",
  };
  onMessage({ type: UPDATE_STATE_CHANGED_TYPE });
  await new Promise(setImmediate);
  assert.equal(card.hidden, false);
  assert.equal(card.children[0].textContent, "扩展有新版 v0.2.5。请按原安装方式更新。");
  assert.equal(card.children[1].href, state.releaseChangelogUrl);
  const dismissButton = card.children[3];
  assert.equal(dismissButton.hidden, false);
  dismissButton.click();
  assert.equal(card.hidden, true);
  assert.equal(sentMessages.some((message) => message.action === "acknowledge-updated"), false);

  onMessage({ type: UPDATE_STATE_CHANGED_TYPE });
  await new Promise(setImmediate);
  assert.equal(card.hidden, true, "closing hides this version for the current page only");
  state.releaseVersion = "0.2.6";
  state.releaseChangelogUrl = "https://github.com/MC0571/weixin-channels-video/releases/tag/extension-v0.2.6";
  onMessage({ type: UPDATE_STATE_CHANGED_TYPE });
  await new Promise(setImmediate);
  assert.equal(card.hidden, false, "a newly available version can be shown later");
});

test("store update reload waits for an active feed response to finish", async () => {
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const request = createFeedRequest();
  const pageContexts = [{ tabId: 4, windowId: 2 }];
  await withBackgroundHarness({
    extensionId: STORE_EXTENSION_ID,
    pageContexts,
    fetchImpl: async () => {
      await fetchGate;
      return { status: 200, ok: true, text: async () => "{}" };
    },
  }, async ({ fetchCalls, onUpdateAvailable, send, storage, timeline }) => {
    const activeRequest = send(request);
    for (let attempt = 0; attempt < 20 && fetchCalls.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchCalls.length, 1);

    await onUpdateAvailable.fire({ version: "0.2.5" });
    for (let attempt = 0; attempt < 20 && storage.get(UPDATE_STORAGE_KEY)?.availableVersion !== "0.2.5"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(storage.get(UPDATE_STORAGE_KEY)?.availableVersion, "0.2.5");
    const status = await send({ type: UPDATE_STATE_TYPE });
    assert.equal(status.source, "store");
    assert.equal(status.status, "available");
    const requestedUpdate = await send({ type: UPDATE_ACTION_TYPE, action: "apply" });
    assert.equal(requestedUpdate.status, "waiting");
    assert.equal(timeline.includes("reload"), false);

    releaseFetch();
    assert.deepEqual(await activeRequest, { status: 200, body: "{}" });
    for (let attempt = 0; attempt < 20 && !timeline.includes("reload"); attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timeline.includes("reload"), true);
    assert.equal(pageContexts.length, 1, "an explicit apply can reload while its page remains open");
  });
});

test("explicit store update reloads an idle open page after responding to the action", async () => {
  const pageContexts = [{ tabId: 11, windowId: 3 }];
  await withBackgroundHarness({ extensionId: STORE_EXTENSION_ID, pageContexts }, async ({ onUpdateAvailable, send, storage, timeline }) => {
    await onUpdateAvailable.fire({ version: "0.2.5" });
    for (let attempt = 0; attempt < 20 && storage.get(UPDATE_STORAGE_KEY)?.availableVersion !== "0.2.5"; attempt += 1) await new Promise(setImmediate);
    const response = await send({ type: UPDATE_ACTION_TYPE, action: "apply" });
    assert.equal(response.status, "waiting");
    for (let attempt = 0; attempt < 20 && !timeline.includes("reload"); attempt += 1) await new Promise(setImmediate);
    assert.equal(timeline.includes("reload"), true);
    assert.equal(pageContexts.length, 1);
  });
});

test("automatic store update waits for the open page until the user chooses apply", async () => {
  const pageContexts = [{ tabId: 12, windowId: 3 }];
  await withBackgroundHarness({ extensionId: STORE_EXTENSION_ID, pageContexts }, async ({ onUpdateAvailable, send, storage, timeline }) => {
    await onUpdateAvailable.fire({ version: "0.2.5" });
    for (let attempt = 0; attempt < 20 && storage.get(UPDATE_STORAGE_KEY)?.availableVersion !== "0.2.5"; attempt += 1) await new Promise(setImmediate);
    const state = await send({ type: UPDATE_STATE_TYPE });
    assert.equal(state.status, "available");
    assert.equal(timeline.includes("reload"), false);
    assert.equal(pageContexts.length, 1);
  });
});

test("toolbar action focuses the existing page or creates one", async () => {
  const previousChrome = globalThis.chrome;
  let onClicked;
  const focusedTabs = [];
  const createdTabs = [];
  let queried = [{ tabId: 42, windowId: 9 }];
  const focusedWindows = [];
  globalThis.chrome = {
    downloads: {
      onDeterminingFilename: { addListener() {} },
      onCreated: { addListener() {} },
      onChanged: { addListener() {} },
      search: async () => [],
    },
    action: { onClicked: { addListener: (listener) => { onClicked = listener; } }, async setBadgeText() {} },
    runtime: {
      id: "synthetic-id",
      getURL: (path) => `chrome-extension://synthetic-id/${path}`,
      onMessage: { addListener() {} },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      onUpdateAvailable: { addListener() {} },
      getContexts: async (filter) => {
        assert.deepEqual(filter, { contextTypes: ["TAB"], documentUrls: ["chrome-extension://synthetic-id/index.html"] });
        return queried;
      },
      getManifest: () => ({ version: "0.2.4" }),
      reload() {},
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    alarms: { onAlarm: { addListener() {} }, clear: async () => true, create() {} },
    windows: { update: async (id, properties) => { focusedWindows.push({ id, properties }); } },
    tabs: {
      onRemoved: { addListener() {} },
      update: async (id, properties) => { focusedTabs.push({ id, properties }); },
      create: async (properties) => { createdTabs.push(properties); },
    },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    management: { getSelf: async () => ({ id: "synthetic-id", installType: "normal" }) },
  };

  try {
    await import(`../extension/background.mjs?test=${Date.now()}`);
    await onClicked();
    assert.deepEqual(focusedTabs, [{ id: 42, properties: { active: true } }]);
    assert.deepEqual(createdTabs, []);
    assert.deepEqual(focusedWindows, [{ id: 9, properties: { focused: true } }]);
    queried = [];
    await onClicked();
    assert.deepEqual(createdTabs, [{ url: "chrome-extension://synthetic-id/index.html" }]);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("background starts a per-profile protocol v2 connection and persistent alarms without pairing", async () => {
  await withBackgroundHarness({}, async ({ ports, alarms, storage }) => {
    for (let attempt = 0; attempt < 20 && ports.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    const instanceId = storage.get("weixin-channels-video:instance-id");
    assert.match(instanceId, /^[0-9a-f-]{36}$/);
    assert.equal(ports.length, 1);
    assert.deepEqual(ports[0].messages, [{ type: "hello", version: 2, instanceId }]);
    assert.deepEqual(alarms.get("weixin-channels-video:bridge-reconnect"), { periodInMinutes: 1 });
    assert.deepEqual(alarms.get(LOGIN_REFRESH_ALARM), { periodInMinutes: 5 });
  });
});

test("background reuses one identity for install and startup and requires the matching v2 ready message", async () => {
  await withBackgroundHarness({}, async ({ onInstalled, onStartup, ports, storage }) => {
    await onInstalled.fire();
    await onStartup.fire();
    assert.equal(ports.length, 1);
    const instanceId = storage.get("weixin-channels-video:instance-id");
    await ports[0].onMessage.fire({ type: "ready", version: 2, instanceId: "523e4567-e89b-42d3-a456-426614174000" });
    for (let attempt = 0; attempt < 20 && storage.get("weixin-channels-video:bridge-connection-state")?.stage !== "failed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(storage.get("weixin-channels-video:bridge-connection-state"), { version: 1, stage: "failed", reason: "invalid_ready_message" });
  });
});

test("only a valid legacy ready payload is reported as unsupported protocol", async () => {
  const stateKey = "weixin-channels-video:bridge-connection-state";
  await withBackgroundHarness({}, async ({ ports, storage }) => {
    for (let attempt = 0; attempt < 20 && ports.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    await ports[0].onMessage.fire({ type: "ready", version: 1 });
    assert.deepEqual(storage.get(stateKey), { version: 1, stage: "failed", reason: "protocol_unsupported" });
    assert.equal(ports[0].disconnects, 1);
  });

  await withBackgroundHarness({}, async ({ ports, storage }) => {
    for (let attempt = 0; attempt < 20 && ports.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    const instanceId = storage.get("weixin-channels-video:instance-id");
    await ports[0].onMessage.fire({ type: "ready", version: 3, instanceId });
    assert.deepEqual(storage.get(stateKey), { version: 1, stage: "failed", reason: "protocol_unsupported" });
  });

  for (const [ready, expectedReason] of [
    [{ type: "ready", version: 1, instanceId: "423e4567-e89b-42d3-a456-426614174000" }, "invalid_ready_message"],
    [{ type: "ready", version: 2, instanceId: "523e4567-e89b-42d3-a456-426614174000" }, "invalid_ready_message"],
    [{ type: "ready", version: 3, instanceId: "523e4567-e89b-42d3-a456-426614174000" }, "invalid_ready_message"],
    [{ type: "ready", version: 2, instanceId: "423e4567-e89b-42d3-a456-426614174000", extra: true }, "invalid_ready_message"],
  ]) {
    await withBackgroundHarness({}, async ({ ports, storage }) => {
      for (let attempt = 0; attempt < 20 && ports.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
      await ports[0].onMessage.fire(ready);
      assert.deepEqual(storage.get(stateKey), { version: 1, stage: "failed", reason: expectedReason });
    });
  }
});

test("background reconnects on the persistent one-minute alarm after host disconnect", async () => {
  await withBackgroundHarness({}, async ({ ports, onAlarm, alarms, storage }) => {
    for (let attempt = 0; attempt < 20 && ports.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    await ports[0].onMessage.fire({ type: "ready", version: 2, instanceId: storage.get("weixin-channels-video:instance-id") });
    await ports[0].onDisconnect.fire();
    assert.deepEqual(alarms.get("weixin-channels-video:bridge-reconnect"), { periodInMinutes: 1 });
    await onAlarm.fire({ name: "weixin-channels-video:bridge-reconnect" });
    assert.equal(ports.length, 2);
    assert.deepEqual(ports[1].messages, [{ type: "hello", version: 2, instanceId: storage.get("weixin-channels-video:instance-id") }]);
  });
});

test("Native Messaging disconnects store safe Chrome error categories", async () => {
  const stateKey = "weixin-channels-video:bridge-connection-state";
  const errors = [
    ["Specified native messaging host not found. C:\\private\\manifest.json", "host_not_found"],
    ["Native messaging host host name is not registered. (Windows-only)", "host_not_registered"],
    ["Failed to start native messaging host.", "host_start_failed"],
    ["Access to the specified native messaging host is forbidden.", "host_access_forbidden"],
    ["Native host has exited.", "host_exited"],
    ["Error when communicating with the native messaging host.", "host_communication_failed"],
    ["Unrecognized runtime error with a private path", "host_disconnected"],
  ];
  for (const [message, reason] of errors) {
    await withBackgroundHarness({}, async ({ ports, storage, chromeApi }) => {
      for (let attempt = 0; attempt < 20 && ports.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
      chromeApi.runtime.lastError = { message };
      await ports[0].onDisconnect.fire();
      for (let attempt = 0; attempt < 20 && storage.get(stateKey)?.stage !== "failed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(storage.get(stateKey), { version: 1, stage: "failed", reason });
      assert.equal(JSON.stringify(storage.get(stateKey)).includes("private"), false);
    });
  }
});

test("host exit remains a host exit after the v2 ready handshake", async () => {
  const stateKey = "weixin-channels-video:bridge-connection-state";
  await withBackgroundHarness({}, async ({ ports, storage, chromeApi }) => {
    for (let attempt = 0; attempt < 20 && ports.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    const instanceId = storage.get("weixin-channels-video:instance-id");
    await ports[0].onMessage.fire({ type: "ready", version: 2, instanceId });
    chromeApi.runtime.lastError = { message: "Native host has exited." };
    await ports[0].onDisconnect.fire();
    assert.deepEqual(storage.get(stateKey), { version: 1, stage: "failed", reason: "host_exited" });
  });
});

test("only the fixed index page can refresh login or report authentication expiry", async () => {
  const { LOGIN_REFRESH_TYPE, AUTH_FAILURE_TYPE, LOGIN_STORAGE_KEY } = await import("../extension/agent-state.mjs");
  await withBackgroundHarness({ fetchImpl: async () => Response.json({ userId: "user", needRefreshToken: false, anonUser: { isAnon: false } }) }, async ({ send, extensionId, storage }) => {
    const sender = { id: extensionId, frameId: 0, url: `chrome-extension://${extensionId}/index.html` };
    assert.equal(await send({ type: LOGIN_REFRESH_TYPE }, { ...sender, frameId: 3 }), undefined);
    const refreshed = await send({ type: LOGIN_REFRESH_TYPE }, sender);
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.state.login, "authenticated");
    await send({ type: AUTH_FAILURE_TYPE }, sender);
    assert.deepEqual(storage.get(LOGIN_STORAGE_KEY), { login: "anonymous", checkedAt: storage.get(LOGIN_STORAGE_KEY).checkedAt });
  });
});

test("Native Messaging commands share one queue across port reconnections without replay", async () => {
  let startFirstOffscreenRequest;
  let finishFirstOffscreenRequest;
  const firstRequestStarted = new Promise((resolve) => { startFirstOffscreenRequest = resolve; });
  const firstRequestResult = new Promise((resolve) => { finishFirstOffscreenRequest = resolve; });
  let parseRequests = 0;
  await withBackgroundHarness({
    fetchImpl: async () => Response.json({ userId: "user", needRefreshToken: false, anonUser: { isAnon: false } }),
    offscreenMessenger: async (message) => {
      assert.equal(message.type, "weixin-channels-video:offscreen-parse");
      parseRequests += 1;
      if (parseRequests === 1) {
        startFirstOffscreenRequest();
        return firstRequestResult;
      }
      return { status: 500, body: "{}" };
    },
  }, async ({ onAlarm, ports, storage }) => {
    for (let attempt = 0; attempt < 20 && ports.length === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    const instanceId = storage.get("weixin-channels-video:instance-id");
    const oldPort = ports[0];
    await oldPort.onMessage.fire({ type: "ready", version: 2, instanceId });
    await oldPort.onMessage.fire({ id: "323e4567-e89b-42d3-a456-426614174000", command: "parse", url: "https://weixin.qq.com/sph/first" });
    await firstRequestStarted;
    await oldPort.onMessage.fire({ id: "423e4567-e89b-42d3-a456-426614174000", command: "parse", url: "https://weixin.qq.com/sph/queued-old-request" });
    await oldPort.onDisconnect.fire();
    await onAlarm.fire({ name: "weixin-channels-video:bridge-reconnect" });
    const newPort = ports[1];
    await newPort.onMessage.fire({ type: "ready", version: 2, instanceId });
    await newPort.onMessage.fire({ id: "523e4567-e89b-42d3-a456-426614174000", command: "parse", url: "https://weixin.qq.com/sph/new-port-request" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parseRequests, 1, "new-port work waits for the dispatched old task");
    finishFirstOffscreenRequest({ status: 500, body: "{}" });
    for (let attempt = 0; attempt < 20 && newPort.messages.length < 2; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parseRequests, 2, "queued work from the stale port is not replayed");
    assert.equal(oldPort.messages.length, 1, "the stale port receives no late result");
    assert.equal(newPort.messages.length, 2);
  });
});

test("instance identity is stable in extension storage", async () => {
  const values = new Map();
  const chromeApi = { storage: { local: {
    async get(key) { return { [key]: values.get(key) }; },
    async set(items) { for (const [key, value] of Object.entries(items)) values.set(key, value); },
  } } };
  const expected = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(await getInstanceId(chromeApi, () => expected), expected);
  assert.equal(await getInstanceId(chromeApi, () => { throw new Error("must reuse stored identity"); }), expected);
});

test("login snapshot stays fast, refreshes once, and preserves auth expiry over an older check", async () => {
  const values = new Map();
  const alarms = [];
  let now = 10_000;
  let resolveCheck;
  let checks = 0;
  const chromeApi = {
    storage: { local: {
      async get(key) { return { [key]: values.get(key) }; },
      async set(items) { for (const [key, value] of Object.entries(items)) values.set(key, value); },
    } },
    alarms: { async create(name, info) { alarms.push([name, info]); } },
  };
  const manager = createLoginStateManager({
    chromeApi,
    clock: () => now,
    requestFactory: () => () => {},
    checker: () => { checks += 1; return new Promise((resolve) => { resolveCheck = resolve; }); },
  });

  assert.deepEqual(await manager.status(), { login: "not_checked", checkedAt: null });
  assert.equal(checks, 0);
  assert.deepEqual(alarms, []);
  const first = manager.status({ refreshLogin: true });
  const second = manager.refresh();
  assert.equal(checks, 1);
  await manager.markAuthenticationFailure({ code: "AUTH_EXPIRED" });
  resolveCheck({ status: "authenticated" });
  assert.deepEqual(await first, { login: "anonymous", checkedAt: now });
  assert.deepEqual(await second, { login: "anonymous", checkedAt: now });
  assert.deepEqual(values.get(LOGIN_STORAGE_KEY), { login: "anonymous", checkedAt: now });
  now += 5 * 60_000;
  const next = manager.refresh();
  assert.equal(checks, 2);
  resolveCheck({ status: "authenticated" });
  assert.deepEqual(await next, { login: "authenticated", checkedAt: now });
  assert.equal(await manager.status({ refreshLogin: true }).then((value) => value.login), "authenticated");
  assert.equal(checks, 2);
  await manager.start();
  assert.deepEqual(alarms, [[LOGIN_REFRESH_ALARM, { periodInMinutes: 5 }]]);
});
