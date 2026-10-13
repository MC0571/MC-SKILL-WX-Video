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
  if (location && item.exists !== false) {
    const note = documentApi.createElement("span");
    note.className = "download-history-location";
    note.textContent = location;
    details.append(note);
  }

  row.append(details);
  if (location && item.exists === false) {
    const unavailable = documentApi.createElement("span");
    unavailable.className = "download-history-location download-history-action-status";
    unavailable.textContent = location;
    row.append(unavailable);
  } else if (item.state === "complete") {
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

function renderItems({ container, empty, items, documentApi, chromeApi, collapsedDays, reviewPrompt, failed = false, filtered = false }) {
  container.replaceChildren();
  if (failed) {
    empty.textContent = "暂时无法读取下载记录。";
    empty.hidden = false;
    return;
  }
  if (!items.length) {
    empty.textContent = filtered ? "这个日期范围内没有下载记录。" : "还没有下载记录。";
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

  for (const [dayKey, group] of groups) {
    const section = documentApi.createElement("section");
    section.className = "download-history-day";
    const heading = documentApi.createElement("h3");
    const list = documentApi.createElement("ul");
    list.className = "download-history-list";
    list.id = `${container.id}-${dayKey}`;
    const toggle = documentApi.createElement("button");
    toggle.type = "button";
    toggle.className = "history-day-toggle";
    toggle.setAttribute("aria-controls", list.id);
    const chevron = documentApi.createElement("span");
    chevron.className = "history-day-chevron";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");
    const label = documentApi.createElement("span");
    label.textContent = group.label;
    toggle.append(chevron, label);
    const updateCollapsed = () => {
      list.hidden = collapsedDays.has(dayKey);
      toggle.setAttribute("aria-expanded", String(!list.hidden));
      toggle.setAttribute("aria-label", `${list.hidden ? "展开" : "收起"} ${group.label}`);
    };
    updateCollapsed();
    toggle.addEventListener("click", () => {
      if (collapsedDays.has(dayKey)) collapsedDays.delete(dayKey);
      else collapsedDays.add(dayKey);
      updateCollapsed();
    });
    heading.append(toggle);
    for (const item of group.items) {
      appendDownloadRow(list, item, documentApi, chromeApi);
      if (reviewPrompt && item === items[0]) {
        const promptRow = documentApi.createElement("li");
        promptRow.className = "review-feed-item";
        promptRow.append(reviewPrompt);
        list.append(promptRow);
      }
    }
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
  const reviewPrompt = documentApi.querySelector("#review-prompt");
  const homeView = documentApi.querySelector("#home-view");
  const historyView = documentApi.querySelector("#history-view");
  const openHistory = documentApi.querySelector("#open-download-history");
  const homeLink = documentApi.querySelector("#home-link");
  const parseForm = documentApi.querySelector("#parse-form");
  const historyHeading = documentApi.querySelector("#history-heading");
  const historyList = documentApi.querySelector("#download-history-list");
  const historyEmpty = documentApi.querySelector("#download-history-empty");
  const orderButton = documentApi.querySelector("#history-order-toggle");
  const orderLabel = documentApi.querySelector("#history-order-label");
  const dateSelect = documentApi.querySelector("#history-date-filter");
  const loadMoreButton = documentApi.querySelector("#history-load-more");
  const liveStatus = documentApi.querySelector("#history-status");
  if (!recentList || !recentEmpty || !homeView || !historyView || !historyHeading ||
      !historyList || !historyEmpty || !orderButton || !orderLabel || !dateSelect || !loadMoreButton || !liveStatus) return;

  let order = "desc";
  let dateFilter = "all";
  const collapsedDays = new Set();
  let nextCursor;
  let hasMore = false;
  let historyItems = [];
  let recentItems = [];
  let recentFailed = false;
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
      recentFailed = false;
      renderItems({ container: recentList, empty: recentEmpty, items: page.items, documentApi, chromeApi, collapsedDays, reviewPrompt: historyVisible ? null : reviewPrompt });
    } catch {
      if (!active || request !== recentRequest) return;
      recentFailed = true;
      renderItems({ container: recentList, empty: recentEmpty, items: [], documentApi, chromeApi, collapsedDays, failed: true });
    }
  }

  async function loadHistory({ append = false, pageSize = HISTORY_PAGE_SIZE, reset = false } = {}) {
    if (loadingMore && append) return;
    const request = ++historyRequest;
    if (reset) {
      historyItems = [];
      nextCursor = undefined;
      hasMore = false;
      historyList.replaceChildren();
      historyList.scrollTop = 0;
      historyEmpty.hidden = true;
      loadMoreButton.hidden = true;
    }
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
        dateFilter,
      });
      if (!active || request !== historyRequest) return;
      historyItems = append ? [...historyItems, ...page.items] : page.items;
      nextCursor = page.nextCursor;
      hasMore = page.hasMore;
      retryFullLoad = false;
      renderItems({ container: historyList, empty: historyEmpty, items: historyItems, documentApi, chromeApi, collapsedDays, reviewPrompt: historyVisible ? reviewPrompt : null, filtered: dateFilter !== "all" });
      liveStatus.textContent = `${historyItems.length} 条记录`;
      loadMoreButton.hidden = !hasMore;
      loadMoreButton.textContent = "加载更多";
    } catch {
      if (!active || request !== historyRequest) return;
      const canKeepExistingResults = !append && historyItems.length > 0;
      if (!append && !canKeepExistingResults) {
        renderItems({ container: historyList, empty: historyEmpty, items: [], documentApi, chromeApi, collapsedDays, failed: true });
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
    void loadHistory({ reset: true });
  }

  function showHome() {
    historyVisible = false;
    historyView.hidden = true;
    homeView.hidden = false;
    renderItems({ container: recentList, empty: recentEmpty, items: recentItems, documentApi, chromeApi, collapsedDays, reviewPrompt, failed: recentFailed });
  }

  openHistory?.addEventListener("click", showHistory);
  homeLink?.addEventListener("click", (event) => {
    event.preventDefault();
    showHome();
  });
  parseForm?.addEventListener("submit", showHome);
  function updateOrderLabel() {
    const label = order === "desc" ? "当前从最新到最早，切换为从最早到最新" : "当前从最早到最新，切换为从最新到最早";
    orderButton.setAttribute("aria-label", label);
    orderButton.title = label;
    orderButton.dataset.order = order;
    orderLabel.textContent = order === "desc" ? "最新优先" : "最早优先";
  }
  orderButton.addEventListener("click", () => {
    order = order === "desc" ? "asc" : "desc";
    updateOrderLabel();
    void loadHistory({ reset: true });
  });
  dateSelect.addEventListener("sl-change", () => {
    dateFilter = dateSelect.value;
    void loadHistory({ reset: true });
  });
  loadMoreButton.addEventListener("click", () => {
    if (retryFullLoad) {
      void loadHistory({ pageSize: retryPageSize });
    } else {
      void loadHistory({ append: true });
    }
  });
  loadMoreButton.hidden = true;
  updateOrderLabel();

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
