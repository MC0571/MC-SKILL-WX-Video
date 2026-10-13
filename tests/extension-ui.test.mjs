import assert from "node:assert/strict";
import test from "node:test";
import { LINKS } from "../extension/config.mjs";
import { initializeEngagementUi, REPOSITORY_LINK_CLICKED_KEY, FIRST_SUCCESSFUL_PARSE_KEY, REVIEW_PROMPT_HANDLED_KEY } from "../extension/engagement.mjs";
import { initializeDownloadHistoryUi } from "../extension/history-ui.mjs";
import { createAgentCommandHandler } from "../extension/agent.mjs";
import { recordSuccessfulParse } from "../extension/engagement.mjs";
import { PAGE_DOWNLOAD_TYPE } from "../extension/app.mjs";

class FixtureElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.className = "";
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async click() {
    if (this.disabled) return;
    await Promise.all((this.listeners.get("click") ?? []).map((listener) => listener({ target: this })));
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  pause() {}
  load() {}
  focus() {}
}

class FixtureDocument {
  constructor(selectors) {
    this.elements = new Map(selectors.map((selector) => [selector, new FixtureElement()]));
    for (const selector of [
      "#review-prompt", "#recent-download-empty", "#history-view",
      "#download-history-empty", "#history-load-more", "#login-status", "#yuanbao-login-link",
    ]) {
      const element = this.elements.get(selector);
      if (element) element.hidden = true;
    }
  }

  querySelector(selector) { return this.elements.get(selector) ?? null; }
  createElement(tagName) { return new FixtureElement(tagName); }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeChromeApi({ items = [], storage = {}, sourceId = "jdecfnemmnhbpamcfhmgjkcphgomgjoe", installType = "normal", onShow = () => {} } = {}) {
  const storageListeners = new Set();
  const createdListeners = new Set();
  const downloadListeners = new Set();
  const erasedListeners = new Set();
  const state = { ...storage };
  const chromeApi = {
    runtime: { id: "fixture-extension" },
    management: { getSelf: async () => ({ id: sourceId, installType }) },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") return { [keys]: state[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, state[key]]));
          return { ...state };
        },
        async set(values) {
          Object.assign(state, values);
          const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
          for (const listener of storageListeners) listener(changes, "local");
        },
      },
      onChanged: {
        addListener: (listener) => storageListeners.add(listener),
        removeListener: (listener) => storageListeners.delete(listener),
      },
    },
    downloads: {
      onCreated: {
        addListener: (listener) => createdListeners.add(listener),
        removeListener: (listener) => createdListeners.delete(listener),
      },
      onChanged: {
        addListener: (listener) => downloadListeners.add(listener),
        removeListener: (listener) => downloadListeners.delete(listener),
      },
      onErased: {
        addListener: (listener) => erasedListeners.add(listener),
        removeListener: (listener) => erasedListeners.delete(listener),
      },
      async search(query) {
        let found = [...items];
        if (query.id !== undefined) found = found.filter((item) => item.id === query.id);
        if (query.startTime !== undefined) {
          found = found.filter((item) => Date.parse(item.startTime) === Date.parse(query.startTime));
        }
        if (query.startedBefore !== undefined) {
          found = found.filter((item) => Date.parse(item.startTime) < Date.parse(query.startedBefore));
        }
        if (query.startedAfter !== undefined) {
          found = found.filter((item) => Date.parse(item.startTime) > Date.parse(query.startedAfter));
        }
        if (query.orderBy) {
          const direction = query.orderBy[0].startsWith("-") ? -1 : 1;
          found.sort((a, b) => direction * (Date.parse(a.startTime) - Date.parse(b.startTime)));
        }
        return query.limit === undefined || query.limit === 0 ? found : found.slice(0, query.limit);
      },
      show: onShow,
    },
  };
  return { chromeApi, state, storageListeners, createdListeners, downloadListeners, erasedListeners };
}

const historySelectors = [
  "#recent-download-list", "#recent-download-empty", "#home-view", "#history-view",
  "#open-download-history", "#history-back", "#history-heading", "#download-history-list",
  "#download-history-empty", "#history-order-toggle", "#history-load-more", "#history-status",
];

let pageFixtureSequence = 0;

async function withPage(chromeApi, check) {
  const documentApi = new FixtureDocument([
    ...historySelectors,
    "#parse-form", "#share-url", "#parse-button", "#parse-status", "#result-card",
    "#video-title", "#video-author", "#cover-image", "#preview-video", "#media-variants",
    "#download-button", "#download-status",
  ]);
  const windowApi = new FixtureElement("window");
  const previousGlobals = new Map(["chrome", "document", "addEventListener"].map((key) => [
    key, Object.getOwnPropertyDescriptor(globalThis, key),
  ]));
  globalThis.chrome = chromeApi;
  globalThis.document = documentApi;
  globalThis.addEventListener = windowApi.addEventListener.bind(windowApi);
  try {
    await import(`../extension/app.mjs?page-fixture=${++pageFixtureSequence}`);
    await new Promise((resolve) => setImmediate(resolve));
    await check(documentApi);
  } finally {
    for (const listener of windowApi.listeners.get("pagehide") ?? []) listener();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function download(id, { exists = true, state = "complete" } = {}) {
  return {
    id,
    byExtensionId: "fixture-extension",
    filename: `/downloads/clip-${id}.mp4`,
    startTime: `2026-10-12T10:${String(id % 60).padStart(2, "0")}:00.000Z`,
    state,
    exists,
    bytesReceived: 2048,
    totalBytes: 2048,
  };
}

test("engagement UI uses configured links, nudges the first GitHub star, and merges a late initial storage read", async () => {
  const selectors = [
    "#repository-link", "#repository-link-label", "#privacy-link", "#feedback-link",
    "#review-prompt", "#review-link", "#review-dismiss",
  ];
  const documentApi = new FixtureDocument(selectors);
  const initialRead = deferred();
  const { chromeApi, state, storageListeners } = makeChromeApi();
  const normalGet = chromeApi.storage.local.get.bind(chromeApi.storage.local);
  chromeApi.storage.local.get = (keys) => Array.isArray(keys) ? initialRead.promise : normalGet(keys);

  initializeEngagementUi({ chromeApi, documentApi, windowApi: new FixtureElement("window") });
  assert.equal(documentApi.querySelector("#repository-link").href, LINKS.repository);
  assert.equal(documentApi.querySelector("#privacy-link").href, LINKS.privacy);
  assert.equal(documentApi.querySelector("#feedback-link").href, LINKS.feedback);
  assert.equal(documentApi.querySelector("#review-link").href, LINKS.storeReview);

  await chromeApi.storage.local.set({ [FIRST_SUCCESSFUL_PARSE_KEY]: 101 });
  assert.equal(Number.isFinite(state[FIRST_SUCCESSFUL_PARSE_KEY]), true);
  assert.equal(storageListeners.size, 1);
  assert.equal(documentApi.querySelector("#review-prompt").hidden, true);
  initialRead.resolve({
    [REPOSITORY_LINK_CLICKED_KEY]: false,
    [FIRST_SUCCESSFUL_PARSE_KEY]: -1,
    [REVIEW_PROMPT_HANDLED_KEY]: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(documentApi.querySelector("#repository-link").dataset.starNudge, "true");
  assert.equal(state[REPOSITORY_LINK_CLICKED_KEY], undefined);
  assert.equal(documentApi.querySelector("#repository-link-label").textContent, "Star 一下");
  assert.equal(documentApi.querySelector("#review-prompt").hidden, false);
  assert.equal(Number.isFinite(state[FIRST_SUCCESSFUL_PARSE_KEY]), true);
  assert.equal(state[FIRST_SUCCESSFUL_PARSE_KEY], 101);
  await documentApi.querySelector("#review-dismiss").click();
  assert.equal(documentApi.querySelector("#review-prompt").hidden, true);
  assert.equal(state[REVIEW_PROMPT_HANDLED_KEY], true);
});

test("opening the repository with the middle button records the click, while right-click does not", async () => {
  const documentApi = new FixtureDocument(["#repository-link", "#repository-link-label"]);
  const { chromeApi, state } = makeChromeApi();
  initializeEngagementUi({ chromeApi, documentApi, windowApi: new FixtureElement("window") });
  await new Promise((resolve) => setImmediate(resolve));
  const link = documentApi.querySelector("#repository-link");
  const dispatch = (button) => Promise.all(link.listeners.get("auxclick").map((listener) => listener({ button })));

  await dispatch(2);
  assert.equal(state[REPOSITORY_LINK_CLICKED_KEY], undefined);
  assert.equal(link.dataset.starNudge, "true");
  await dispatch(1);
  assert.equal(state[REPOSITORY_LINK_CLICKED_KEY], true);
  assert.equal(link.dataset.starNudge, undefined);
  assert.equal(documentApi.querySelector("#repository-link-label").textContent, "Github");
});

test("repository click persists across pages, merges late reads, and does not infer a click from the old first-open flag", async () => {
  const selectors = ["#repository-link", "#repository-link-label"];
  const documentApi = new FixtureDocument(selectors);
  const initialRead = deferred();
  const { chromeApi, state } = makeChromeApi({ storage: {
    "weixin-channels-video:first-open-guide-shown": true,
  } });
  const normalGet = chromeApi.storage.local.get.bind(chromeApi.storage.local);
  chromeApi.storage.local.get = () => initialRead.promise;
  initializeEngagementUi({ chromeApi, documentApi, windowApi: new FixtureElement("window") });
  await documentApi.querySelector("#repository-link").click();
  assert.equal(state[REPOSITORY_LINK_CLICKED_KEY], true);
  initialRead.resolve({ [REPOSITORY_LINK_CLICKED_KEY]: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(documentApi.querySelector("#repository-link-label").textContent, "Github");
  assert.equal(documentApi.querySelector("#repository-link").dataset.starNudge, undefined);

  chromeApi.storage.local.get = normalGet;
  const reopened = new FixtureDocument(selectors);
  initializeEngagementUi({ chromeApi, documentApi: reopened, windowApi: new FixtureElement("window") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reopened.querySelector("#repository-link-label").textContent, "Github");
  assert.equal(reopened.querySelector("#repository-link").dataset.starNudge, undefined);
  await chromeApi.storage.local.set({ [REPOSITORY_LINK_CLICKED_KEY]: false });
  assert.equal(reopened.querySelector("#repository-link-label").textContent, "Star 一下");
  assert.equal(reopened.querySelector("#repository-link").dataset.starNudge, "true");
  await documentApi.querySelector("#repository-link").click();
  assert.equal(reopened.querySelector("#repository-link-label").textContent, "Github");

  const legacy = new FixtureDocument(selectors);
  const legacyApi = makeChromeApi({ storage: { "weixin-channels-video:first-open-guide-shown": true } });
  initializeEngagementUi({ chromeApi: legacyApi.chromeApi, documentApi: legacy, windowApi: new FixtureElement("window") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(legacy.querySelector("#repository-link-label").textContent, "Star 一下");
  assert.equal(legacy.querySelector("#repository-link").dataset.starNudge, "true");
});

test("page and Agent success events reach the prompt through shared storage; failed parses do not", async () => {
  const documentApi = new FixtureDocument([
    "#repository-link", "#privacy-link", "#feedback-link",
    "#review-prompt", "#review-link", "#review-dismiss",
  ]);
  const { chromeApi, state } = makeChromeApi({ storage: { [REPOSITORY_LINK_CLICKED_KEY]: true } });
  initializeEngagementUi({ chromeApi, documentApi, windowApi: new FixtureElement("window") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(documentApi.querySelector("#repository-link").dataset.starNudge, undefined);
  assert.equal(documentApi.querySelector("#review-prompt").hidden, true);

  const video = {
    title: "A title", author: "An author", coverUrl: "https://media.example/cover.jpg",
    previewUrl: "https://media.example/video.mp4", downloadUrl: "https://media.example/video.mp4",
    mediaVariants: [],
  };
  const handler = (parser) => createAgentCommandHandler({
    chromeApi,
    parser,
    requestFactory: () => async () => new Response(null, { status: 200 }),
    onParseSuccess: () => recordSuccessfulParse(chromeApi),
  });
  const request = { id: "323e4567-e89b-42d3-a456-426614174000", command: "parse", url: "https://weixin.qq.com/sph/synthetic" };
  assert.equal((await handler(async () => video)(request, { source: "page" })).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  const firstSuccessAt = state[FIRST_SUCCESSFUL_PARSE_KEY];
  assert.equal(Number.isFinite(firstSuccessAt), true);
  assert.equal(documentApi.querySelector("#review-prompt").hidden, false);

  assert.equal((await handler(async () => video)(request, { source: "agent" })).ok, true);
  assert.equal(state[FIRST_SUCCESSFUL_PARSE_KEY], firstSuccessAt);

  const failedFixture = new FixtureDocument([
    "#repository-link", "#privacy-link", "#feedback-link",
    "#review-prompt", "#review-link", "#review-dismiss",
  ]);
  const failedApi = makeChromeApi({ storage: { [REPOSITORY_LINK_CLICKED_KEY]: true } });
  initializeEngagementUi({ chromeApi: failedApi.chromeApi, documentApi: failedFixture, windowApi: new FixtureElement("window") });
  await new Promise((resolve) => setImmediate(resolve));
  const failure = await createAgentCommandHandler({
    chromeApi: failedApi.chromeApi,
    parser: async () => { throw new Error("synthetic parse failure"); },
    requestFactory: () => async () => new Response(null, { status: 200 }),
    onParseSuccess: () => recordSuccessfulParse(failedApi.chromeApi),
  })(request, { source: "agent" });
  assert.equal(failure.ok, false);
  assert.equal(failedApi.state[FIRST_SUCCESSFUL_PARSE_KEY], undefined);
  assert.equal(failedFixture.querySelector("#review-prompt").hidden, true);
});

for (const action of ["#review-dismiss", "#review-link"]) {
  test(`review prompt ignores installation source and stays handled after ${action}`, async () => {
    const documentApi = new FixtureDocument([
      "#repository-link", "#privacy-link", "#feedback-link",
      "#review-prompt", "#review-link", "#review-dismiss",
    ]);
    const { chromeApi, state } = makeChromeApi({
      sourceId: "unpacked-id",
      installType: "development",
      storage: { [REPOSITORY_LINK_CLICKED_KEY]: true, [FIRST_SUCCESSFUL_PARSE_KEY]: 12 },
    });
    chromeApi.management.getSelf = async () => { throw new Error("installation source must not be queried"); };
    const windowApi = new FixtureElement("window");
    windowApi.setTimeout = setTimeout;
    initializeEngagementUi({ chromeApi, documentApi, windowApi });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(documentApi.querySelector("#review-prompt").hidden, false);
    assert.equal(documentApi.querySelector("#review-link").href, LINKS.storeReview);
    assert.equal(documentApi.querySelector("#feedback-link").hidden, false);
    await documentApi.querySelector(action).click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(state[REVIEW_PROMPT_HANDLED_KEY], true);
    const reopened = new FixtureDocument([...documentApi.elements.keys()]);
    initializeEngagementUi({ chromeApi, documentApi: reopened, windowApi: new FixtureElement("window") });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reopened.querySelector("#review-prompt").hidden, true);
  });
}

test("page entry follows Agent-created downloads and reopening without a contradictory empty summary", async () => {
  const items = [];
  const { chromeApi, createdListeners, downloadListeners, erasedListeners } = makeChromeApi({ items });
  const recentRows = (documentApi) => documentApi.querySelector("#recent-download-list").children
    .flatMap((section) => section.children[1].children);

  await withPage(chromeApi, async (documentApi) => {
    assert.equal(documentApi.querySelector("#recent-download-empty").hidden, false);
    const item = download(42, { state: "in_progress" });
    items.push(item);
    for (const listener of createdListeners) listener(item);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(documentApi.querySelector("#recent-download-empty").hidden, true);
    assert.match(recentRows(documentApi)[0].children[0].children[1].textContent, /下载中/);
    assert.equal(documentApi.querySelector("#download-status").textContent, "");

    item.state = "complete";
    for (const listener of downloadListeners) listener({ id: item.id, state: { current: "complete" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(recentRows(documentApi)[0].children[0].children[1].textContent, /已完成/);
    assert.equal(documentApi.querySelector("#download-status").textContent, "");
  });
  assert.equal(downloadListeners.size, 0);

  await withPage(chromeApi, async (documentApi) => {
    assert.equal(documentApi.querySelector("#recent-download-empty").hidden, true);
    assert.equal(recentRows(documentApi).length, 1);
    assert.equal(documentApi.querySelector("#download-status").textContent, "");
    items.length = 0;
    for (const listener of erasedListeners) listener(42);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recentRows(documentApi).length, 0);
    assert.equal(documentApi.querySelector("#recent-download-empty").hidden, false);
    assert.equal(documentApi.querySelector("#download-status").textContent, "");
  });
});

test("page download start errors remain visible and clear after a successful retry", async () => {
  const { chromeApi } = makeChromeApi();
  let downloadAttempts = 0;
  chromeApi.runtime.sendMessage = async (message) => {
    if (message.type === "weixin-channels-video:page-parse") {
      return { ok: true, result: {
        title: "clip", downloadUrl: "https://media.example/clip.mp4",
        previewUrl: "https://media.example/clip.mp4", mediaVariants: [],
      } };
    }
    assert.equal(message.type, PAGE_DOWNLOAD_TYPE);
    return { ok: ++downloadAttempts > 1 };
  };
  await withPage(chromeApi, async (documentApi) => {
    for (const submit of documentApi.querySelector("#parse-form").listeners.get("submit")) {
      await submit({ preventDefault() {} });
    }
    const button = documentApi.querySelector("#download-button");
    await button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(documentApi.querySelector("#download-status").textContent, "下载无法启动，请检查浏览器下载设置。");
    assert.equal(button.disabled, false);
    await button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(documentApi.querySelector("#download-status").textContent, "");
    assert.equal(button.disabled, false);
  });
});

test("missing download rows remain gray with precise status, and failed reveal remains retryable", async () => {
  const documentApi = new FixtureDocument(historySelectors);
  const missing = download(1, { exists: false });
  let showAttempts = 0;
  const existing = download(2);
  existing.exists = undefined;
  const { chromeApi } = makeChromeApi({ items: [missing, existing], onShow: () => {
    showAttempts += 1;
    if (showAttempts === 1) throw new Error("temporary error");
  } });
  initializeDownloadHistoryUi({ chromeApi, documentApi, windowApi: new FixtureElement("window") });
  await new Promise((resolve) => setImmediate(resolve));
  const recentRows = documentApi.querySelector("#recent-download-list").children[0].children[1].children;
  const recentMissingRow = recentRows.find((row) => row.dataset.fileMissing === "true");
  assert.equal(recentMissingRow.children[1].textContent, "文件已移除或移动");
  assert.equal(recentMissingRow.children[1].tagName, "span");

  await documentApi.querySelector("#open-download-history").click();
  await new Promise((resolve) => setImmediate(resolve));

  const firstSectionList = documentApi.querySelector("#download-history-list").children[0].children[1];
  const missingRow = firstSectionList.children.find((row) => row.dataset.fileMissing === "true");
  assert.ok(missingRow);
  assert.equal(missingRow.children[0].children.length, 2);
  assert.equal(missingRow.children[1].textContent, "文件已移除或移动");
  assert.equal(missingRow.children[1].tagName, "span");
  assert.equal(missingRow.children.length, 2);

  const existingRow = firstSectionList.children.find((row) => row.dataset.fileMissing === "false");
  const revealButton = existingRow.children.at(-1);
  assert.equal(revealButton.textContent, "在文件夹中显示");
  await revealButton.click();
  assert.equal(revealButton.textContent, "状态未知，重试");
  assert.equal(revealButton.disabled, false);
  existing.exists = true;
  await revealButton.click();
  assert.equal(revealButton.textContent, "打开失败，重试");
  assert.equal(revealButton.disabled, false);
  await revealButton.click();
  assert.equal(revealButton.textContent, "已在文件夹中显示");
  assert.equal(revealButton.disabled, false);
  await revealButton.click();
  assert.equal(revealButton.disabled, false);
  assert.equal(showAttempts, 3);
});

test("download history ignores unrelated events and refreshes without collapsing loaded rows", async () => {
  const documentApi = new FixtureDocument(historySelectors);
  const items = Array.from({ length: 24 }, (_, index) => download(index + 1));
  const foreign = { ...download(100), byExtensionId: "another-extension" };
  const { chromeApi, downloadListeners } = makeChromeApi({ items: [...items, foreign] });
  initializeDownloadHistoryUi({ chromeApi, documentApi, windowApi: new FixtureElement("window") });
  await new Promise((resolve) => setImmediate(resolve));
  await documentApi.querySelector("#open-download-history").click();
  await new Promise((resolve) => setImmediate(resolve));

  const loadMore = documentApi.querySelector("#history-load-more");
  await loadMore.click();
  await new Promise((resolve) => setImmediate(resolve));
  const rows = () => documentApi.querySelector("#download-history-list").children[0].children[1].children;
  assert.equal(rows().length, 24);

  for (const listener of downloadListeners) listener({ id: foreign.id, state: "interrupted" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows().length, 24, "foreign download changes must not reset the visible page depth");

  items.at(-1).filename = "/downloads/updated-clip.mp4";
  for (const listener of downloadListeners) listener({ id: items.at(-1).id, state: "complete" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows().length, 24, "refreshing a visible history should retain all loaded rows");
  assert.equal(rows()[0].children[0].children[0].textContent, "updated-clip.mp4");
});

test("overlapping own download changes retain expanded history depth", async () => {
  const documentApi = new FixtureDocument(historySelectors);
  const items = Array.from({ length: 24 }, (_, index) => download(index + 1));
  const { chromeApi, downloadListeners } = makeChromeApi({ items });
  const search = chromeApi.downloads.search.bind(chromeApi.downloads);
  const firstHistoryRefreshStarted = deferred();
  const releaseFirstHistoryRefresh = deferred();
  let holdFirstHistoryRefresh = false;
  let refreshSearchCount = 0;
  chromeApi.downloads.search = async (query) => {
    if (holdFirstHistoryRefresh && query.id === undefined) {
      refreshSearchCount += 1;
      if (refreshSearchCount === 2) {
        firstHistoryRefreshStarted.resolve();
        await releaseFirstHistoryRefresh.promise;
      }
    }
    return search(query);
  };

  initializeDownloadHistoryUi({ chromeApi, documentApi, windowApi: new FixtureElement("window") });
  await new Promise((resolve) => setImmediate(resolve));
  await documentApi.querySelector("#open-download-history").click();
  await new Promise((resolve) => setImmediate(resolve));
  await documentApi.querySelector("#history-load-more").click();
  await new Promise((resolve) => setImmediate(resolve));
  const rows = () => documentApi.querySelector("#download-history-list").children[0].children[1].children;
  assert.equal(rows().length, 24);

  holdFirstHistoryRefresh = true;
  items[0].filename = "/downloads/first-change.mp4";
  for (const listener of downloadListeners) listener({ id: items[0].id, state: "complete" });
  await firstHistoryRefreshStarted.promise;

  items.at(-1).filename = "/downloads/second-change.mp4";
  for (const listener of downloadListeners) listener({ id: items.at(-1).id, state: "complete" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows().length, 24);
  assert.equal(rows()[0].children[0].children[0].textContent, "second-change.mp4");

  releaseFirstHistoryRefresh.resolve();
  await new Promise((resolve) => setImmediate(resolve));
});

test("failed history refresh keeps visible rows and offers a full retry", async () => {
  const documentApi = new FixtureDocument(historySelectors);
  const items = Array.from({ length: 24 }, (_, index) => download(index + 1));
  const { chromeApi, downloadListeners } = makeChromeApi({ items });
  const search = chromeApi.downloads.search.bind(chromeApi.downloads);
  let failNextRefresh = false;
  let refreshSearchCount = 0;
  chromeApi.downloads.search = async (query) => {
    if (failNextRefresh && query.id === undefined) {
      refreshSearchCount += 1;
      if (refreshSearchCount === 2) {
        failNextRefresh = false;
        throw new Error("temporary refresh failure");
      }
    }
    return search(query);
  };

  initializeDownloadHistoryUi({ chromeApi, documentApi, windowApi: new FixtureElement("window") });
  await new Promise((resolve) => setImmediate(resolve));
  await documentApi.querySelector("#open-download-history").click();
  await new Promise((resolve) => setImmediate(resolve));
  await documentApi.querySelector("#history-load-more").click();
  await new Promise((resolve) => setImmediate(resolve));
  const rows = () => documentApi.querySelector("#download-history-list").children[0].children[1].children;
  assert.equal(rows().length, 24);

  failNextRefresh = true;
  items.at(-1).filename = "/downloads/after-failed-refresh.mp4";
  for (const listener of downloadListeners) listener({ id: items.at(-1).id, state: "complete" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows().length, 24);
  const retry = documentApi.querySelector("#history-load-more");
  assert.equal(retry.textContent, "重试读取记录");

  await retry.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows().length, 24);
  assert.equal(rows()[0].children[0].children[0].textContent, "after-failed-refresh.mp4");
  assert.equal(retry.hidden, true);
});

test("failed load-more keeps a retry action and succeeds on the next click", async () => {
  const documentApi = new FixtureDocument(historySelectors);
  const items = Array.from({ length: 21 }, (_, index) => download(index + 1));
  const { chromeApi } = makeChromeApi({ items });
  let failNextSearch = false;
  const search = chromeApi.downloads.search.bind(chromeApi.downloads);
  chromeApi.downloads.search = async (query) => {
    if (query.id === undefined && failNextSearch) {
      failNextSearch = false;
      throw new Error("temporary read failure");
    }
    return search(query);
  };
  initializeDownloadHistoryUi({ chromeApi, documentApi, windowApi: new FixtureElement("window") });
  await new Promise((resolve) => setImmediate(resolve));
  await documentApi.querySelector("#open-download-history").click();
  await new Promise((resolve) => setImmediate(resolve));
  const loadMore = documentApi.querySelector("#history-load-more");
  assert.equal(loadMore.hidden, false);

  failNextSearch = true;
  await loadMore.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loadMore.hidden, false);
  assert.equal(loadMore.textContent, "重试加载更多");
  assert.equal(loadMore.disabled, false);
  await loadMore.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(documentApi.querySelector("#download-history-list").children[0].children[1].children.length, 21);
  assert.equal(loadMore.hidden, true);
});
