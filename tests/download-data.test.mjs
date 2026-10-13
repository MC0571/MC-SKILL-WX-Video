import assert from "node:assert/strict";
import test from "node:test";
import { safeDownloadFilename, isSafeRelativeMp4Filename } from "../src/download-filename.mjs";
import { getDownloadFileStatus, loadDownloadHistoryPage, revealDownload, watchDownloadHistory } from "../extension/download-history.mjs";

const fixedDate = new Date(2026, 9, 12, 23, 59);

function makeChromeApi(items) {
  const queries = [];
  return {
    runtime: { id: "ours" },
    downloads: {
      queries,
      async search(query) {
        queries.push(query);
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
    },
  };
}

test("download names normalize unsafe text and stay within the filename byte limit", () => {
  assert.equal(safeDownloadFilename("心中那个篮球传奇", fixedDate), "心中那个篮球传奇_20261012.mp4");
  assert.equal(safeDownloadFilename("Vintage Video 04", fixedDate), "Vintage Video 04_20261012.mp4");
  assert.equal(safeDownloadFilename("  bad:/ title.  ", fixedDate), "bad_ title_20261012.mp4");
  const illegal = safeDownloadFilename("a\\b/c:d*e?f\"g<h>i|j\u0000\u001f\u007f\u009f", fixedDate);
  assert.equal(illegal, "a_b_c_d_e_f_g_h_i_j__20261012.mp4");
  assert.equal(safeDownloadFilename("../...", fixedDate).includes(".."), false);
  for (const reserved of ["CON.txt", "PRN", "AUX", "NUL", "COM1", "LPT9"]) {
    assert.equal(safeDownloadFilename(reserved, fixedDate), "视频号_20261012.mp4");
  }
  assert.equal(safeDownloadFilename("   ", fixedDate), "视频号_20261012.mp4");
  assert.match(safeDownloadFilename(""), /^视频号_\d{8}\.mp4$/u);

  const filename = safeDownloadFilename("👩🏽‍🚀e\u0301".repeat(100), fixedDate);
  assert.ok(isSafeRelativeMp4Filename(filename));
  assert.ok(new TextEncoder().encode(filename).byteLength <= 255);
  assert.ok(filename.includes("👩🏽‍🚀"));
  assert.ok(filename.endsWith("_20261012.mp4"));
  assert.equal(isSafeRelativeMp4Filename("Clips/clip.mp4"), true);
  assert.equal(isSafeRelativeMp4Filename("../clip.mp4"), false);
});

test("history scans bounded browser batches until it finds this extension's records", async () => {
  const own = [
    { id: 12, byExtensionId: "ours", startTime: "2026-10-12T09:00:00.000Z", state: "complete" },
    { id: 11, byExtensionId: "ours", startTime: "2026-10-12T09:00:00.000Z", state: "interrupted" },
    { id: 13, byExtensionId: "ours", startTime: "2026-10-12T10:00:00.000Z", state: "in_progress" },
  ];
  const other = Array.from({ length: 230 }, (_, index) => ({
    id: 1000 + index,
    byExtensionId: "other",
    startTime: new Date(Date.parse("2026-10-12T13:00:00.000Z") - index * 60_000).toISOString(),
  }));
  const chromeApi = makeChromeApi([...other, ...own]);
  const first = await loadDownloadHistoryPage(chromeApi, { pageSize: 2 });
  assert.deepEqual(first.items.map(({ id }) => id), [13, 12]);
  assert.equal(first.hasMore, true);
  assert.match(first.nextCursor, /^v1\./u);
  const next = await loadDownloadHistoryPage(chromeApi, { cursor: first.nextCursor, pageSize: 2 });
  assert.deepEqual(next.items.map(({ id }) => id), [11]);
  assert.equal(next.hasMore, false);

  const ascending = await loadDownloadHistoryPage(chromeApi, { pageSize: 3, order: "asc" });
  assert.deepEqual(ascending.items.map(({ id }) => id), [11, 12, 13]);
  assert.equal(ascending.hasMore, false);
  assert.ok(chromeApi.downloads.queries.some(({ startedBefore }) => startedBefore));
  assert.ok(chromeApi.downloads.queries.some(({ startedAfter }) => startedAfter));
  assert.ok(chromeApi.downloads.queries.every((query) =>
    query.limit === 100 || (query.limit === 0 && query.startTime !== undefined) || query.id !== undefined,
  ));
  await assert.rejects(loadDownloadHistoryPage(chromeApi, { cursor: "bad", pageSize: 2 }), TypeError);
  await assert.rejects(loadDownloadHistoryPage(chromeApi, { cursor: first.nextCursor, pageSize: 2, order: "asc" }), TypeError);
});

test("exact timestamp scans page same-time downloads by stable ID without gaps or repeats", async () => {
  const timestamp = "2026-10-12T09:00:00.000Z";
  const items = Array.from({ length: 105 }, (_, index) => ({
    id: 105 - index,
    byExtensionId: "ours",
    startTime: timestamp,
  }));
  const chromeApi = makeChromeApi(items);
  const first = await loadDownloadHistoryPage(chromeApi, { pageSize: 3 });
  const second = await loadDownloadHistoryPage(chromeApi, { cursor: first.nextCursor, pageSize: 3 });
  assert.deepEqual(first.items.map(({ id }) => id), [105, 104, 103]);
  assert.deepEqual(second.items.map(({ id }) => id), [102, 101, 100]);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, true);
  const descendingIds = [...first.items, ...second.items].map(({ id }) => id);
  let nextCursor = second.nextCursor;
  while (nextCursor) {
    const page = await loadDownloadHistoryPage(chromeApi, { cursor: nextCursor, pageSize: 3 });
    descendingIds.push(...page.items.map(({ id }) => id));
    nextCursor = page.nextCursor;
  }
  assert.deepEqual(descendingIds, Array.from({ length: 105 }, (_, index) => 105 - index));

  const ascending = await loadDownloadHistoryPage(chromeApi, { pageSize: 3, order: "asc" });
  const ascendingNext = await loadDownloadHistoryPage(chromeApi, { cursor: ascending.nextCursor, pageSize: 3, order: "asc" });
  assert.deepEqual(ascending.items.map(({ id }) => id), [1, 2, 3]);
  assert.deepEqual(ascendingNext.items.map(({ id }) => id), [4, 5, 6]);
  const ascendingIds = [...ascending.items, ...ascendingNext.items].map(({ id }) => id);
  nextCursor = ascendingNext.nextCursor;
  while (nextCursor) {
    const page = await loadDownloadHistoryPage(chromeApi, { cursor: nextCursor, pageSize: 3, order: "asc" });
    ascendingIds.push(...page.items.map(({ id }) => id));
    nextCursor = page.nextCursor;
  }
  assert.deepEqual(ascendingIds, Array.from({ length: 105 }, (_, index) => index + 1));
});

test("file status and reveal only apply to downloads owned by this extension", async () => {
  let item = { id: 3, byExtensionId: "ours", state: "complete" };
  const shown = [];
  const chromeApi = makeChromeApi([]);
  chromeApi.downloads.search = async () => [item];
  chromeApi.downloads.show = (id) => shown.push(id);
  assert.equal(await getDownloadFileStatus(3, chromeApi), "unknown");
  assert.equal(await revealDownload(3, chromeApi), "unknown");
  item = { ...item, exists: false };
  assert.equal(await revealDownload(3, chromeApi), "missing");
  item = { ...item, exists: true };
  assert.equal(await revealDownload(3, chromeApi), "shown");
  item = { ...item, byExtensionId: "other", exists: false };
  assert.equal(await revealDownload(3, chromeApi), "unknown");
  assert.deepEqual(shown, [3]);
  chromeApi.downloads.search = async () => { throw new Error("unavailable"); };
  assert.equal(await getDownloadFileStatus(3, chromeApi), "unknown");
});

test("download creation refreshes owned items and erasure removes them", async () => {
  const listeners = new Set();
  const createdListeners = new Set();
  const erasedListeners = new Set();
  let result = { id: 4, byExtensionId: "ours", state: "complete", exists: true };
  const updates = [];
  const chromeApi = {
    runtime: { id: "ours" },
    downloads: {
      onCreated: { addListener: (fn) => createdListeners.add(fn), removeListener: (fn) => createdListeners.delete(fn) },
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
      onErased: { addListener: (fn) => erasedListeners.add(fn), removeListener: (fn) => erasedListeners.delete(fn) },
      search: async () => result ? [result] : [],
    },
  };
  const stop = watchDownloadHistory(chromeApi, (item, delta) => updates.push({ item, delta }));
  const created = { id: 5, byExtensionId: "ours", startTime: "2026-10-12T10:00:00.000Z", state: "in_progress" };
  for (const listener of createdListeners) listener(created);
  assert.deepEqual(updates[0], {
    item: {
      id: 5, filename: undefined, startTime: created.startTime, endTime: undefined, state: "in_progress",
      bytesReceived: undefined, totalBytes: undefined, exists: undefined,
    },
    delta: { id: 5, created: true },
  });
  for (const listener of createdListeners) listener({ ...created, id: 6, byExtensionId: "other" });
  assert.equal(updates.length, 1);

  for (const listener of listeners) listener({ id: 4, exists: { current: false } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates[1].item.exists, true);
  result = null;
  for (const listener of erasedListeners) listener(4);
  assert.deepEqual(updates[2], { item: null, delta: { id: 4, removed: true } });
  stop();
  assert.equal(createdListeners.size, 0);
  assert.equal(listeners.size, 0);
  assert.equal(erasedListeners.size, 0);
});
