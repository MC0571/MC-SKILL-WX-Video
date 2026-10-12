const PAGE_SIZE = 20;
const SEARCH_BATCH_SIZE = 100;

function historyItem(item) {
  return {
    id: item.id,
    filename: item.filename,
    startTime: item.startTime,
    endTime: item.endTime,
    state: item.state,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    exists: item.exists,
  };
}

function compareItems(a, b, direction) {
  const byTime = Date.parse(a.startTime) - Date.parse(b.startTime);
  return direction * (byTime || a.id - b.id);
}

function encodeCursor(item, order) {
  const encoded = btoa(JSON.stringify({ startTime: item.startTime, id: item.id, order }));
  return `v1.${encoded.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}`;
}

function decodeCursor(value, order) {
  try {
    if (typeof value !== "string" || value.length > 512 || !value.startsWith("v1.")) throw new Error();
    const encoded = value.slice(3).replace(/-/gu, "+").replace(/_/gu, "/");
    const data = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
    if (
      data.order !== order ||
      typeof data.startTime !== "string" || !Number.isFinite(Date.parse(data.startTime)) ||
      !Number.isSafeInteger(data.id) || data.id < 0
    ) throw new Error();
    return { startTime: data.startTime, id: data.id };
  } catch {
    throw new TypeError("Invalid download history cursor");
  }
}

function search(chromeApi, order, query, limit) {
  return chromeApi.downloads.search({
    ...query,
    orderBy: [order === "asc" ? "startTime" : "-startTime"],
    limit,
  });
}

export async function loadDownloadHistoryPage(
  chromeApi = globalThis.chrome,
  { cursor, pageSize = PAGE_SIZE, order = "desc" } = {},
) {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new TypeError("Invalid download history page");
  }
  if (order !== "asc" && order !== "desc") throw new TypeError("Invalid download history order");
  const direction = order === "asc" ? 1 : -1;
  const after = cursor === undefined ? null : decodeCursor(cursor, order);
  const matches = [];
  const addMatches = (items) => {
    matches.push(...items.filter((item) =>
      item.byExtensionId === chromeApi.runtime.id && (!after || compareItems(item, after, direction) > 0),
    ));
  };

  let query = {};
  if (after) {
    addMatches(await search(chromeApi, order, { startTime: after.startTime }, 0));
    query = order === "desc" ? { startedBefore: after.startTime } : { startedAfter: after.startTime };
  }

  while (matches.length <= pageSize) {
    const batch = await search(chromeApi, order, query, SEARCH_BATCH_SIZE);
    if (!batch.length) break;
    batch.sort((a, b) => compareItems(a, b, direction));

    let scanned = batch;
    const boundary = batch.at(-1).startTime;
    if (batch.length === SEARCH_BATCH_SIZE) {
      const tied = await search(chromeApi, order, { startTime: boundary }, 0);
      scanned = [
        ...batch.filter((item) => Date.parse(item.startTime) !== Date.parse(boundary)),
        ...tied,
      ];
    }
    addMatches(scanned);
    if (matches.length > pageSize || batch.length < SEARCH_BATCH_SIZE) break;
    query = order === "desc" ? { startedBefore: boundary } : { startedAfter: boundary };
  }

  matches.sort((a, b) => compareItems(a, b, direction));
  const page = matches.slice(0, pageSize);
  const hasMore = matches.length > pageSize;
  return {
    items: page.map(historyItem),
    nextCursor: hasMore && page.length ? encodeCursor(page.at(-1), order) : undefined,
    hasMore,
  };
}

export async function getDownloadFileStatus(downloadId, chromeApi = globalThis.chrome) {
  try {
    const [item] = await chromeApi.downloads.search({ id: downloadId });
    if (item?.byExtensionId !== chromeApi.runtime.id || item.state !== "complete") return "unknown";
    return item.exists === true ? "exists" : item.exists === false ? "missing" : "unknown";
  } catch {
    return "unknown";
  }
}

export async function revealDownload(downloadId, chromeApi = globalThis.chrome) {
  const status = await getDownloadFileStatus(downloadId, chromeApi);
  if (status !== "exists") return status;
  try {
    chromeApi.downloads.show(downloadId);
    return "shown";
  } catch {
    return "error";
  }
}

export function watchDownloadHistory(chromeApi = globalThis.chrome, onChange) {
  const created = (item) => {
    if (item.byExtensionId === chromeApi.runtime.id) onChange(historyItem(item), { id: item.id, created: true });
  };
  const listener = (delta) => {
    void chromeApi.downloads.search({ id: delta.id }).then(([item]) => {
      onChange(item?.byExtensionId === chromeApi.runtime.id ? historyItem(item) : null, delta);
    }).catch(() => onChange(undefined, delta));
  };
  const removed = (downloadId) => onChange(null, { id: downloadId, removed: true });
  chromeApi.downloads.onCreated.addListener(created);
  chromeApi.downloads.onChanged.addListener(listener);
  chromeApi.downloads.onErased.addListener(removed);
  return () => {
    chromeApi.downloads.onCreated.removeListener(created);
    chromeApi.downloads.onChanged.removeListener(listener);
    chromeApi.downloads.onErased.removeListener(removed);
  };
}
