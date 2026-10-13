export const UPDATE_STATE_TYPE = "weixin-channels-video:update-state";
export const UPDATE_ACTION_TYPE = "weixin-channels-video:update-action";
export const UPDATE_STATE_CHANGED_TYPE = "weixin-channels-video:update-state-changed";
export const UPDATE_STORAGE_KEY = "weixin-channels-video:update-state";
export const RELEASE_CHECK_STORAGE_KEY = "weixin-channels-video:release-check";
export const STORE_EXTENSION_ID = "jdecfnemmnhbpamcfhmgjkcphgomgjoe";
export const STORE_REVIEW_URL = `https://chromewebstore.google.com/detail/${STORE_EXTENSION_ID}/reviews`;
export const GITHUB_RELEASES_URL = "https://github.com/MC0571/weixin-channels-video/releases";
const RELEASES_API_URL = "https://api.github.com/repos/MC0571/weixin-channels-video/releases?per_page=100&page=";
const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RELEASE_RETRY_INTERVAL_MS = 15 * 60 * 1000;
const RELEASE_FETCH_TIMEOUT_MS = 8_000;
const RELEASES_MAX_PAGES = 5;

export function extensionReleaseUrl(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)) return null;
  return `https://github.com/MC0571/weixin-channels-video/releases/tag/extension-v${encodeURIComponent(version)}`;
}

export async function getInstallSource(chromeApi = globalThis.chrome, storeExtensionId = STORE_EXTENSION_ID) {
  try {
    const info = await chromeApi.management.getSelf();
    if (!info || typeof info.id !== "string" || typeof info.installType !== "string") return "unknown";
    return info.id === storeExtensionId && info.installType === "normal" ? "store" : "external";
  } catch {
    return "unknown";
  }
}

export function createUpdateStateManager({
  chromeApi = globalThis.chrome,
  storeExtensionId = STORE_EXTENSION_ID,
  storageKey = UPDATE_STORAGE_KEY,
  releaseCheckStorageKey = RELEASE_CHECK_STORAGE_KEY,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const currentVersion = () => chromeApi.runtime.getManifest().version;
  let releaseCheckPromise;

  async function readStoredState() {
    const stored = await chromeApi.storage.local.get(storageKey);
    return stored?.[storageKey] ?? {};
  }

  async function writeStoredState(state) {
    await chromeApi.storage.local.set({ [storageKey]: state });
  }

  async function readReleaseCheck() {
    const stored = await chromeApi.storage.local.get(releaseCheckStorageKey);
    return stored?.[releaseCheckStorageKey] ?? {};
  }

  async function writeReleaseCheck(state) {
    await chromeApi.storage.local.set({ [releaseCheckStorageKey]: state });
  }

  function compareVersions(left, right) {
    const leftParts = left.split(".").map(Number);
    const rightParts = right.split(".").map(Number);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
      const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
      if (difference) return Math.sign(difference);
    }
    return 0;
  }

  async function syncExternalBadge(latestVersion) {
    const available = latestVersion && compareVersions(latestVersion, currentVersion()) > 0;
    await chromeApi.action.setBadgeText({ text: available ? "更新" : "" });
  }

  async function notifyStateChanged() {
    try { await chromeApi.runtime.sendMessage({ type: UPDATE_STATE_CHANGED_TYPE }); }
    catch { /* No extension page may be open. */ }
  }

  function parseExtensionTag(tag) {
    if (typeof tag !== "string") return null;
    const version = tag.startsWith("extension-v") ? tag.slice("extension-v".length)
      : tag.startsWith("v") ? tag.slice(1) : null;
    return extensionReleaseUrl(version) ? version : null;
  }

  function releaseHasExtensionArchive(release, version) {
    if (!Array.isArray(release.assets)) return false;
    const archiveName = `weixin-channels-video-extension-v${version}.zip`;
    return release.assets.some((asset) => asset?.name === archiveName);
  }

  function releaseUrl(tag) {
    return `https://github.com/MC0571/weixin-channels-video/releases/tag/${encodeURIComponent(tag)}`;
  }

  async function fetchLatestExtensionRelease() {
    if (typeof fetchImpl !== "function" || typeof globalThis.AbortSignal?.timeout !== "function") return null;
    let latestRelease = null;
    for (let page = 1; page <= RELEASES_MAX_PAGES; page += 1) {
      let response;
      try {
        response = await fetchImpl(`${RELEASES_API_URL}${page}`, {
          headers: { Accept: "application/vnd.github+json" },
          credentials: "omit",
          redirect: "error",
          signal: globalThis.AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
        });
      } catch {
        return null;
      }
      if (!response?.ok) return null;
      let releases;
      try { releases = await response.json(); }
      catch { return null; }
      if (!Array.isArray(releases)) return null;
      for (const release of releases) {
        if (!release || typeof release !== "object" || typeof release.tag_name !== "string" ||
            typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean") return null;
        if (release.draft || release.prerelease) continue;
        const version = parseExtensionTag(release.tag_name);
        if (!version || !releaseHasExtensionArchive(release, version)) continue;
        const comparison = latestRelease ? compareVersions(version, latestRelease.version) : 1;
        const isCanonicalTag = release.tag_name.startsWith("extension-v");
        const latestIsCanonicalTag = latestRelease?.tag.startsWith("extension-v");
        if (comparison > 0 || (comparison === 0 && isCanonicalTag && !latestIsCanonicalTag)) {
          latestRelease = { version, tag: release.tag_name };
        }
      }
      if (releases.length < 100) return latestRelease;
    }
    return null;
  }

  async function refreshExternalReleaseCheck() {
    if (releaseCheckPromise) return releaseCheckPromise;
    releaseCheckPromise = (async () => {
      const checkedAt = now();
      const latestRelease = await fetchLatestExtensionRelease();
      await writeReleaseCheck({
        status: latestRelease ? "checked" : "unknown",
        latestVersion: latestRelease?.version ?? null,
        latestTag: latestRelease?.tag ?? null,
        checkedAt,
      });
      if (await getInstallSource(chromeApi, storeExtensionId) === "external") {
        await syncExternalBadge(latestRelease?.version ?? null);
      }
      await notifyStateChanged();
    })().finally(() => { releaseCheckPromise = undefined; });
    return releaseCheckPromise;
  }

  function releaseCheckIsDue(check, timestamp) {
    const checkedAt = Number(check.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt > timestamp) return true;
    const interval = check.status === "unknown" ? RELEASE_RETRY_INTERVAL_MS : RELEASE_CHECK_INTERVAL_MS;
    return timestamp - checkedAt >= interval;
  }

  async function getState() {
    const [source, stored, releaseCheck] = await Promise.all([
      getInstallSource(chromeApi, storeExtensionId),
      readStoredState(),
      readReleaseCheck(),
    ]);
    const version = currentVersion();
    let releaseStatus = null;
    let releaseVersion = null;
    if (source === "external") {
      const due = releaseCheckIsDue(releaseCheck, now());
      if (due) void refreshExternalReleaseCheck();
      releaseStatus = due ? "checking"
        : releaseCheck.status === "unknown" ? "unknown"
          : releaseCheck.latestVersion && compareVersions(releaseCheck.latestVersion, version) > 0 ? "available"
            : releaseCheck.latestVersion ? "current" : "checking";
      releaseVersion = due ? null : releaseCheck.latestVersion ?? null;
      await syncExternalBadge(releaseCheck.latestVersion ?? null);
    }
    return {
      ok: true,
      source,
      status: stored.availableVersion ? (stored.applyRequested ? "waiting" : "available") : "none",
      applyRequested: Boolean(stored.applyRequested),
      version,
      availableVersion: stored.availableVersion ?? null,
      changelogUrl: stored.availableVersion ? extensionReleaseUrl(stored.availableVersion) : null,
      updated: stored.updated ?? null,
      releaseUrl: source === "external" ? GITHUB_RELEASES_URL : null,
      releaseStatus,
      releaseVersion,
      releaseChangelogUrl: releaseVersion
        ? releaseUrl(releaseCheck.latestTag ?? `extension-v${releaseVersion}`)
        : null,
    };
  }

  async function updateAvailable(version) {
    if (await getInstallSource(chromeApi, storeExtensionId) !== "store" || !extensionReleaseUrl(version)) return;
    const stored = await readStoredState();
    await writeStoredState({ ...stored, availableVersion: version, applyRequested: false });
    await notifyStateChanged();
    await chromeApi.action.setBadgeText({ text: "更新" });
  }

  async function installed(details) {
    const version = currentVersion();
    const stored = await readStoredState();
    if (details?.reason === "update" && details.previousVersion !== version) {
      await writeStoredState({
        updated: { version, changelogUrl: extensionReleaseUrl(version) },
      });
      await chromeApi.action.setBadgeText({ text: "" });
      return;
    }
    if (details?.reason === "install") await writeStoredState({});
    else if (stored.availableVersion && stored.availableVersion === version) {
      await writeStoredState({});
      await chromeApi.action.setBadgeText({ text: "" });
    }
  }

  async function apply() {
    const stored = await readStoredState();
    if (!stored.availableVersion) return getState();
    await writeStoredState({ ...stored, applyRequested: true });
    return getState();
  }

  async function later() {
    const stored = await readStoredState();
    if (stored.availableVersion) await writeStoredState({ ...stored, applyRequested: false });
    return getState();
  }

  async function acknowledgeUpdated() {
    const stored = await readStoredState();
    if (!stored.updated) return getState();
    const { updated, ...remaining } = stored;
    await writeStoredState(remaining);
    return getState();
  }

  return { getState, updateAvailable, installed, apply, later, acknowledgeUpdated };
}
