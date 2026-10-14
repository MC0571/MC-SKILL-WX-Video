(() => {
  const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const result = {
    title: "示例视频｜海边片段",
    author: "示例作者",
    coverUrl: "./capture-cover.svg",
    previewUrl: "./capture-preview.mp4",
    downloadUrl: "./capture-preview.mp4",
    mediaVariants: [
      { label: "示例版本 A", downloadUrl: "./capture-preview.mp4" },
      { label: "示例版本 B", downloadUrl: "./capture-preview.mp4#standard" },
    ],
  };
  const at = (daysAgo, hour, minute) => {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hour, minute, 0, 0);
    return date.toISOString();
  };
  const allDownloads = [
    [8101, 0, 11, 24, "海边片段"],
    [8102, 0, 9, 40, "山间晨雾"],
    [8103, 1, 18, 12, "公园里的橘猫"],
    [8104, 4, 16, 5, "秋日散步"],
    [8105, 9, 13, 50, "旧城一角"],
    [8106, 22, 19, 8, "晚霞染红海面"],
    [8107, 52, 8, 31, "雨停之后"],
  ].map(([id, days, hour, minute, title], index) => ({
    id,
    byExtensionId: extensionId,
    filename: `示例_${title}_2026.mp4`,
    startTime: at(days, hour, minute),
    endTime: at(days, hour, minute + 1),
    state: "complete",
    bytesReceived: (index + 4) * 1024 * 1024,
    totalBytes: (index + 4) * 1024 * 1024,
    exists: true,
  }));
  const captureMode = new URLSearchParams(location.search).get("capture");
  const downloads = captureMode === "history"
    ? allDownloads
    : captureMode === "empty"
      ? []
      : allDownloads.slice(0, 1);
  const listeners = () => {
    const callbacks = new Set();
    return {
      addListener: (callback) => callbacks.add(callback),
      removeListener: (callback) => callbacks.delete(callback),
      forEach: (callback) => callbacks.forEach(callback),
    };
  };
  const values = Object.create(null);
  values["weixin-channels-video:instance-id"] = "e246b5f1-6fbd-4c9c-870d-ae29dd083126";
  const storageListeners = listeners();
  const choose = (keys) => {
    if (typeof keys === "string") return Object.hasOwn(values, keys) ? { [keys]: values[keys] } : {};
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
    return { ...values };
  };
  const chrome = {
    runtime: {
      id: extensionId,
      getManifest: () => ({ name: "视频号分享链接解析", version: "0.2.5" }),
      getURL: (path) => new URL(path, location.href).href,
      onMessage: listeners(),
      sendMessage: async (message) => {
        if (message?.type === "weixin-channels-video:page-parse") return { ok: true, result };
        return null;
      },
    },
    storage: {
      local: {
        get: async (keys) => choose(keys),
        set: async (updates) => {
          Object.assign(values, updates);
          storageListeners.forEach((callback) => callback(
            Object.fromEntries(Object.entries(updates).map(([key, newValue]) => [key, { newValue }])),
            "local",
          ));
        },
      },
      onChanged: storageListeners,
    },
    downloads: {
      search: async (query = {}) => {
        let matches = downloads;
        if (Number.isInteger(query.id)) matches = matches.filter((item) => item.id === query.id);
        if (typeof query.startedAfter === "string") matches = matches.filter((item) => Date.parse(item.startTime) >= Date.parse(query.startedAfter));
        if (typeof query.startedBefore === "string") matches = matches.filter((item) => Date.parse(item.startTime) <= Date.parse(query.startedBefore));
        if (typeof query.startTime === "string") matches = matches.filter((item) => Date.parse(item.startTime) >= Date.parse(query.startTime));
        matches = [...matches].sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
        if (query.orderBy?.[0] === "-startTime") matches.reverse();
        return query.limit > 0 ? matches.slice(0, query.limit) : matches;
      },
      onCreated: listeners(),
      onChanged: listeners(),
      onErased: listeners(),
      show: () => {},
    },
  };
  globalThis.chrome = chrome;
})();
