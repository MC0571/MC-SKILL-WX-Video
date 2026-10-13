import {
  loadDownloadHistoryPage,
  revealDownload,
  watchDownloadHistory,
} from "./download-history.mjs";

const RECENT_PAGE_SIZE = 5;
const HISTORY_PAGE_SIZE = 20;

function filenameLabel(path) {
  if (typeof path !== "string" || !path) return "未命名文件";
  return path.split(/[\\/]/).pop() || "未命名文件";
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "大小未知";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unit = "B";
  for (const nextUnit of units) {
    size /= 1024;
    unit = nextUnit;
    if (size < 1024 || nextUnit === "TB") break;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(size)} ${unit}`;
}

function formatDownloadTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { dayKey: "unknown", dayLabel: "日期未知", timeLabel: "时间未知" };
  const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const dayLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(date);
  const timeLabel = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  return { dayKey, dayLabel, timeLabel };
}

function statusLabel(item) {
  if (item.state === "in_progress") return "下载中";
  if (item.state === "interrupted") return "已中断";
  if (item.state === "complete") return "已完成";
  return "状态未知";
}

function fileLocationLabel(item) {
  if (item.state !== "complete") return "";
  if (item.exists === false) return "文件已移除或移动";
  if (item.exists !== true) return "文件状态未知";
  return "";
}

function appendDownloadRow(list, item, documentApi, chromeApi) {
  const row = documentApi.createElement("li");
  row.className = "download-history-item";
  row.dataset.fileMissing = String(item.state === "complete" && item.exists === false);

  const details = documentApi.createElement("div");
  details.className = "download-history-details";
  const name = documentApi.createElement("span");
  name.className = "download-history-name";
  name.textContent = filenameLabel(item.filename);
  const metadata = documentApi.createElement("span");
  metadata.className = "download-history-meta";
  const time = formatDownloadTime(item.startTime);
  const bytes = Number.isFinite(item.bytesReceived) ? item.bytesReceived : item.totalBytes;
  metadata.textContent = [time.timeLabel, statusLabel(item), formatBytes(bytes)].join(" · ");
  details.append(name, metadata);

  const location = fileLocationLabel(item);
  if (location) {
    const note = documentApi.createElement("span");
    note.className = "download-history-location";
    note.textContent = location;
    details.append(note);
  }

  row.append(details);
  if (item.state === "complete" && item.exists !== false) {
    const revealButton = documentApi.createElement("button");
    revealButton.type = "button";
    revealButton.className = "secondary-button history-reveal-button";
    revealButton.textContent = "在文件夹中显示";
    revealButton.setAttribute("aria-label", `在文件夹中显示：${filenameLabel(item.filename)}`);
    revealButton.addEventListener("click", async () => {
      revealButton.disabled = true;
      let terminal = false;
      try {
        const state = await revealDownload(item.id, chromeApi);
        if (state === "shown") {
          revealButton.textContent = "已在文件夹中显示";
        } else if (state === "missing") {
          revealButton.textContent = "文件已移除或移动";
          row.dataset.fileMissing = "true";
          terminal = true;
        } else {
          revealButton.textContent = state === "error" ? "打开失败，重试" : "状态未知，重试";
        }
        revealButton.setAttribute("aria-label", `${revealButton.textContent}：${filenameLabel(item.filename)}`);
      } finally {
        revealButton.disabled = terminal;
      }
    });
    row.append(revealButton);
  }
  list.append(row);
}

function renderItems({ container, empty, items, documentApi, chromeApi, failed = false }) {
  container.replaceChildren();
  if (failed) {
    empty.textContent = "暂时无法读取下载记录。";
    empty.hidden = false;
    return;
  }
  if (!items.length) {
    empty.textContent = "还没有下载记录。";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const groups = new Map();
  for (const item of items) {
    const time = formatDownloadTime(item.startTime);
    if (!groups.has(time.dayKey)) groups.set(time.dayKey, { label: time.dayLabel, items: [] });
    groups.get(time.dayKey).items.push(item);
  }

  for (const group of groups.values()) {
    const section = documentApi.createElement("section");
    section.className = "download-history-day";
    const heading = documentApi.createElement("h3");
    heading.textContent = group.label;
    const list = documentApi.createElement("ul");
    list.className = "download-history-list";
    for (const item of group.items) appendDownloadRow(list, item, documentApi, chromeApi);
    section.append(heading, list);
    container.append(section);
  }
}

export function initializeDownloadHistoryUi({
  chromeApi = globalThis.chrome,
  documentApi = globalThis.document,
  windowApi = globalThis,
} = {}) {
  if (!documentApi?.querySelector) return;
  const recentList = documentApi.querySelector("#recent-download-list");
  const recentEmpty = documentApi.querySelector("#recent-download-empty");
  const homeView = documentApi.querySelector("#home-view");
  const historyView = documentApi.querySelector("#history-view");
  const openHistory = documentApi.querySelector("#open-download-history");
  const backHome = documentApi.querySelector("#history-back");
  const historyHeading = documentApi.querySelector("#history-heading");
  const historyList = documentApi.querySelector("#download-history-list");
  const historyEmpty = documentApi.querySelector("#download-history-empty");
  const orderButton = documentApi.querySelector("#history-order-toggle");
  const loadMoreButton = documentApi.querySelector("#history-load-more");
  const liveStatus = documentApi.querySelector("#history-status");
  if (!recentList || !recentEmpty || !homeView || !historyView || !historyHeading ||
      !historyList || !historyEmpty || !orderButton || !loadMoreButton || !liveStatus) return;

  let order = "desc";
  let nextCursor;
  let hasMore = false;
  let historyItems = [];
  let recentItems = [];
  let historyRequest = 0;
  let recentRequest = 0;
  let historyVisible = false;
  let loadingMore = false;
  let retryFullLoad = false;
  let retryPageSize = HISTORY_PAGE_SIZE;
  let active = true;

  async function loadRecent() {
    const request = ++recentRequest;
    try {
      const page = await loadDownloadHistoryPage(chromeApi, { pageSize: RECENT_PAGE_SIZE, order: "desc" });
      if (!active || request !== recentRequest) return;
      recentItems = page.items;
      renderItems({ container: recentList, empty: recentEmpty, items: page.items, documentApi, chromeApi });
    } catch {
      if (!active || request !== recentRequest) return;
      renderItems({ container: recentList, empty: recentEmpty, items: [], documentApi, chromeApi, failed: true });
    }
  }

  async function loadHistory({ append = false, pageSize = HISTORY_PAGE_SIZE } = {}) {
    if (loadingMore && append) return;
    const request = ++historyRequest;
    if (!append) {
      retryFullLoad = false;
      retryPageSize = pageSize;
      loadMoreButton.disabled = true;
      liveStatus.textContent = "正在读取下载记录…";
    }
    if (append) {
      loadingMore = true;
      loadMoreButton.disabled = true;
      liveStatus.textContent = "正在加载更多记录…";
    }
    try {
      const page = await loadDownloadHistoryPage(chromeApi, {
        ...(append && nextCursor !== undefined ? { cursor: nextCursor } : {}),
        pageSize,
        order,
      });
      if (!active || request !== historyRequest) return;
      historyItems = append ? [...historyItems, ...page.items] : page.items;
      nextCursor = page.nextCursor;
      hasMore = page.hasMore;
      retryFullLoad = false;
      renderItems({ container: historyList, empty: historyEmpty, items: historyItems, documentApi, chromeApi });
      liveStatus.textContent = historyItems.length ? `${historyItems.length} 条记录` : "";
      loadMoreButton.hidden = !hasMore;
      loadMoreButton.textContent = "加载更多";
    } catch {
      if (!active || request !== historyRequest) return;
      const canKeepExistingResults = !append && historyItems.length > 0;
      if (!append && !canKeepExistingResults) {
        renderItems({ container: historyList, empty: historyEmpty, items: [], documentApi, chromeApi, failed: true });
      }
      liveStatus.textContent = "暂时无法读取下载记录。";
      if (append && hasMore) {
        loadMoreButton.hidden = false;
        loadMoreButton.textContent = "重试加载更多";
      } else if (canKeepExistingResults) {
        retryFullLoad = true;
        loadMoreButton.hidden = false;
        loadMoreButton.textContent = "重试读取记录";
      } else {
        loadMoreButton.hidden = true;
      }
    } finally {
      if (request === historyRequest) {
        loadingMore = false;
        loadMoreButton.disabled = false;
      }
    }
  }

  function showHistory() {
    historyVisible = true;
    homeView.hidden = true;
    historyView.hidden = false;
    historyHeading.focus({ preventScroll: true });
    void loadHistory();
  }

  function showHome() {
    historyVisible = false;
    historyView.hidden = true;
    homeView.hidden = false;
    openHistory?.focus({ preventScroll: true });
  }

  openHistory?.addEventListener("click", showHistory);
  backHome?.addEventListener("click", showHome);
  orderButton.addEventListener("click", () => {
    order = order === "desc" ? "asc" : "desc";
    orderButton.textContent = order === "desc" ? "切换为从旧到新" : "切换为从新到旧";
    void loadHistory();
  });
  loadMoreButton.addEventListener("click", () => {
    if (retryFullLoad) {
      void loadHistory({ pageSize: retryPageSize });
    } else {
      void loadHistory({ append: true });
    }
  });
  loadMoreButton.hidden = true;
  orderButton.textContent = "切换为从旧到新";

  const stopWatching = typeof chromeApi?.downloads?.onChanged?.addListener === "function"
    ? watchDownloadHistory(chromeApi, (item, change) => {
      const removedVisibleItem = change?.removed === true &&
        (recentItems.some((entry) => entry.id === change.id) || historyItems.some((entry) => entry.id === change.id));
      if (!item && !removedVisibleItem) return;
      void loadRecent();
      if (historyVisible) {
        void loadHistory({ pageSize: Math.max(HISTORY_PAGE_SIZE, historyItems.length) });
      }
    })
    : () => {};
  windowApi?.addEventListener?.("pagehide", () => {
    active = false;
    historyRequest += 1;
    recentRequest += 1;
    stopWatching();
  }, { once: true });
  void loadRecent();
}
