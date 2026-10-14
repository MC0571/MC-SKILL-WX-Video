#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { MIN_NODE_VERSION, RUNTIME_PROTOCOL, supportsNodeVersion } from "./runtime-support.mjs";
import { assertWindowsPrivatePath, secureWindowsPath } from "./windows-security.mjs";

export { MIN_NODE_VERSION, RUNTIME_PROTOCOL, supportsNodeVersion };

const OWNER = "MC0571";
const REPOSITORY = "weixin-channels-video";
const RELEASES_API = "https://api.github.com/repos/" + OWNER + "/" + REPOSITORY + "/releases?per_page=100&page=";
const RELEASE_DOWNLOADS = "https://github.com/" + OWNER + "/" + REPOSITORY + "/releases/download";
const ARCHIVE_NAME = (version) => REPOSITORY + "-skill-v" + version + ".tar.gz";
const SKILL_ZIP_NAME = (version) => REPOSITORY + "-skill-v" + version + ".zip";
const ARCHIVE_CONTENT_TYPES = ["application/gzip", "application/x-gzip", "application/x-gtar", "application/octet-stream"];
const LEGACY_CACHE_ROOT = platformCacheRoot() ?? join(homedir(), ".cache", REPOSITORY, "skill-runtime");
const CACHE_ROOT = join(LEGACY_CACHE_ROOT, "protocol-" + RUNTIME_PROTOCOL);
const SKILL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 256;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = MAX_UNPACKED_BYTES + (MAX_ARCHIVE_FILES * 2 + 2) * 512;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(value)) return null;
  if (value.split(".").some((part) => Number(part) > 65535)) return null;
  return value;
}

export function platformCacheRoot({
  platform = process.platform,
  home = homedir(),
  env = process.env,
} = {}) {
  if (platform === "darwin") {
    if (!isAbsolute(home)) fail("工具缓存路径必须是绝对路径。");
    return join(home, "Library", "Caches", REPOSITORY, "skill-runtime");
  }
  if (platform === "win32") {
    const path = win32;
    const root = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    if (!path.isAbsolute(root)) fail("工具缓存路径必须是绝对路径。");
    return path.join(root, REPOSITORY, "skill-runtime");
  }
  return null;
}

function assertSupportedNode() {
  if (!supportsNodeVersion()) fail("此 Skill 需要 Node.js " + MIN_NODE_VERSION + " 或更高版本。");
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail("运行资源文件类型无效。");
}

async function readRegularFile(path) {
  await assertRegularFile(path);
  return readFile(path);
}

async function secureNewCacheDirectory(path) {
  if (process.platform === "win32") {
    await secureWindowsPath(path, { directory: true, newlyCreated: true });
  }
}

async function assertPrivateCacheDirectory(path) {
  if (process.platform === "win32") {
    await assertWindowsPrivatePath(path, { directory: true });
  }
}

async function createOrAssertCacheDirectory(path, recursive = false) {
  let newlyCreated = false;
  try {
    await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      await mkdir(path, { recursive, mode: 0o700 });
      newlyCreated = true;
    } catch (createError) {
      // Another process may have created the directory; verify the filesystem state below.
      try { await lstat(path); }
      catch { throw createError; }
    }
  }

  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("运行资源缓存目录不安全。");
  if (newlyCreated) await secureNewCacheDirectory(path);
  else await assertPrivateCacheDirectory(path);
}

async function ensureNewCacheDirectory(path) {
  await mkdir(path, { recursive: false, mode: 0o700 });
  await secureNewCacheDirectory(path);
}

async function assertPrivateRuntime(root) {
  if (process.platform !== "win32") return;
  await assertWindowsPrivatePath(root, { directory: true });
  await assertWindowsPrivatePath(join(root, "runtime.json"));
  await assertWindowsPrivatePath(join(root, "scripts"), { directory: true });
  await assertWindowsPrivatePath(join(root, "scripts", "cli.mjs"));
  await assertWindowsPrivatePath(join(root, "scripts", "native-host.mjs"));
}

async function writeCacheFile(path, contents) {
  if (process.platform === "win32") {
    await writeFile(path, "", { flag: "wx", mode: 0o600 });
    await secureWindowsPath(path, { newlyCreated: true });
    await writeFile(path, contents);
    return;
  }
  await writeFile(path, contents, { flag: "wx", mode: 0o600 });
}

async function copyCacheFile(source, destination) {
  if (process.platform === "win32") {
    await writeCacheFile(destination, await readRegularFile(source));
    return;
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

async function runtimeContentHash(root) {
  const hash = createHash("sha256");
  for (const name of ["runtime.json", "scripts/cli.mjs", "scripts/native-host.mjs"]) {
    const contents = await readRegularFile(join(root, name));
    hash.update(name + "\0" + contents.length + "\0").update(contents);
  }
  return hash.digest("hex");
}

function parseRuntimeMetadata(text, expectedVersion) {
  let metadata;
  try { metadata = JSON.parse(text); }
  catch { fail("运行资源元数据无效。"); }
  if (
    !isRecord(metadata) || Object.keys(metadata).length !== 3 ||
    !parseVersion(metadata.version) ||
    !Number.isInteger(metadata.runtimeProtocol) || metadata.runtimeProtocol < 1 ||
    !supportsNodeVersion(metadata.minimumNodeVersion, metadata.minimumNodeVersion) ||
    (expectedVersion && metadata.version !== expectedVersion)
  ) fail("运行资源元数据无效。");
  return metadata;
}

function isCompatibleRuntime(metadata) {
  return metadata.runtimeProtocol === RUNTIME_PROTOCOL &&
    supportsNodeVersion(process.versions.node, metadata.minimumNodeVersion);
}

async function readRuntime(root, expectedVersion, { requirePrivate = false, allowIncompatible = false } = {}) {
  if (requirePrivate) await assertPrivateRuntime(root);
  const metadata = parseRuntimeMetadata((await readRegularFile(join(root, "runtime.json"))).toString("utf8"), expectedVersion);

  const scriptsDir = join(root, "scripts");
  await assertRegularFile(join(scriptsDir, "cli.mjs"));
  await assertRegularFile(join(scriptsDir, "native-host.mjs"));
  const compatible = isCompatibleRuntime(metadata);
  if (!compatible && !allowIncompatible) fail("Skill 与运行资源版本不兼容，请更新 Skill 后重试。");
  const runtime = {
    version: metadata.version,
    runtimeProtocol: metadata.runtimeProtocol,
    minimumNodeVersion: metadata.minimumNodeVersion,
    runtimeCLI: join(scriptsDir, "cli.mjs"),
  };
  if (allowIncompatible) runtime.compatible = compatible;
  return runtime;
}

async function fetchBytes(url, {
  maxBytes = MAX_DOWNLOAD_BYTES,
  json = false,
  expectedSize,
  contentTypes,
  pagination = false,
} = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: json ? { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } : {},
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("无法连接 GitHub Releases，请检查网络后重试。");
  }
  if (!response.ok) fail("GitHub Releases 请求失败（HTTP " + response.status + "）。");
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentTypes && !contentTypes.includes(contentType)) fail("GitHub Release 资源类型无效。");
  const contentLength = response.headers.get("content-length");
  if (expectedSize !== undefined && contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) !== expectedSize)) {
    fail("GitHub Release 资源大小与元数据不一致。");
  }
  if (!response.body) fail("GitHub Releases 返回了空响应。");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) fail("GitHub Release 资源超过允许大小。");
    chunks.push(Buffer.from(chunk));
  }
  if (expectedSize !== undefined && size !== expectedSize) fail("GitHub Release 资源大小与元数据不一致。");
  const bytes = Buffer.concat(chunks, size);
  return pagination
    ? { bytes, hasNextPage: /(?:^|,)\s*<[^>]+>\s*;\s*rel="?next"?(?:\s*;|\s*,|\s*$)/.test(response.headers.get("link") ?? "") }
    : bytes;
}

function releaseAsset(release, version, name, maxBytes, contentTypes) {
  const matches = Array.isArray(release.assets)
    ? release.assets.filter((asset) => asset?.name === name)
    : [];
  if (matches.length !== 1) fail("GitHub Release v" + version + " 缺少唯一资源 " + name + "。");
  const asset = matches[0];
  const expectedUrl = RELEASE_DOWNLOADS + "/" + release.tag_name + "/" + name;
  if (
    !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxBytes ||
    typeof asset.content_type !== "string" || !contentTypes.includes(asset.content_type.split(";")[0].trim().toLowerCase()) ||
    asset.browser_download_url !== expectedUrl
  ) fail("GitHub Release 资源元数据无效。");
  return { name, size: asset.size };
}

async function skillReleases() {
  const releases = [];
  for (let page = 1; page <= 100; page += 1) {
    const { bytes, hasNextPage } = await fetchBytes(RELEASES_API + page, {
      maxBytes: 1024 * 1024,
      json: true,
      contentTypes: ["application/json", "application/vnd.github+json"],
      pagination: true,
    });
    let pageReleases;
    try { pageReleases = JSON.parse(bytes.toString("utf8")); }
    catch { fail("GitHub Releases 返回了无效响应。"); }
    if (!Array.isArray(pageReleases) || pageReleases.some((item) =>
      !isRecord(item) || typeof item.tag_name !== "string" ||
      typeof item.draft !== "boolean" || typeof item.prerelease !== "boolean" || !Array.isArray(item.assets)
    )) fail("GitHub Releases 返回了无效响应。");
    releases.push(...pageReleases);
    if (!hasNextPage) return releases;
  }
  fail("GitHub Releases 分页数量超过允许范围。");
}

function releaseCandidates(releases) {
  const candidates = [];
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const isSkillTag = release.tag_name.startsWith("skill-v");
    const isLegacyTag = !isSkillTag && release.tag_name.startsWith("v");
    if (!isSkillTag && !isLegacyTag) continue;
    const tagVersion = release.tag_name.slice(isSkillTag ? 7 : 1);
    const version = parseVersion(tagVersion);
    if (!version) {
      if (isSkillTag) fail("Skill Release 标签版本无效。");
      continue;
    }
    const archiveAssetExists = release.assets.some((asset) => asset?.name === ARCHIVE_NAME(version));
    if (!archiveAssetExists && isLegacyTag) continue;
    if (!archiveAssetExists || release.tag_name !== (isSkillTag ? "skill-v" : "v") + version) {
      fail("Skill Release 资源元数据无效。");
    }
    candidates.push({ release, version, isSkillTag });
  }
  return candidates.sort((a, b) => compareVersions(b.version, a.version) || Number(b.isSkillTag) - Number(a.isSkillTag));
}

function releasePackage(release, version) {
  const archive = releaseAsset(release, version, ARCHIVE_NAME(version), MAX_DOWNLOAD_BYTES,
    ARCHIVE_CONTENT_TYPES);
  releaseAsset(release, version, SKILL_ZIP_NAME(version), MAX_DOWNLOAD_BYTES,
    ["application/zip", "application/octet-stream"]);
  const checksums = releaseAsset(release, version, "SHA256SUMS", 64 * 1024,
    ["text/plain", "application/octet-stream"]);
  return { archive, checksums };
}

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function checksumFor(text, assetName) {
  const matchingRows = text.split(/\r?\n/).filter((row) => row.endsWith("  " + assetName));
  if (matchingRows.length !== 1) fail("SHA256SUMS 中没有唯一匹配的 Skill 包校验值。");
  const match = matchingRows[0].match(/^([0-9a-f]{64})  [A-Za-z0-9._-]+$/);
  if (!match) fail("SHA256SUMS 格式无效。");
  return match[1];
}

function safeArchivePath(name) {
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    !normalized || normalized.startsWith("/") || normalized.includes("\\") ||
    normalized.includes("\0") || normalized.split("/").some((part) => !isPortableSegment(part)) ||
    (normalized !== "weixin-channels-video" && !normalized.startsWith("weixin-channels-video/"))
  ) fail("Skill TAR 包包含越界路径。");
  return normalized;
}

function isPortableSegment(part) {
  return Boolean(
    part && part !== "." && part !== ".." &&
    !/[<>:"|?*\u0000-\u001f]/.test(part) &&
    !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
    part === part.normalize("NFC")
  );
}

function parseTarText(field) {
  const end = field.indexOf(0);
  const bytes = end < 0 ? field : field.subarray(0, end);
  if (end >= 0 && field.subarray(end).some((byte) => byte !== 0)) fail("Skill TAR 包头部无效。");
  try { return TEXT_DECODER.decode(bytes); }
  catch { fail("Skill TAR 包路径不是有效的 UTF-8。"); }
}

function parseTarNumber(field) {
  const text = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) fail("Skill TAR 包成员大小无效。");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail("Skill TAR 包成员大小无效。");
  return value;
}

function parseSkillTar(tar) {
  const blockSize = 512;
  if (!Buffer.isBuffer(tar) || tar.length < blockSize * 2 || tar.length % blockSize !== 0) {
    fail("Skill TAR 包格式无效。");
  }
  const members = new Map();
  const canonicalPaths = new Set();
  let totalBytes = 0;
  let offset = 0;
  let ended = false;

  while (offset + blockSize <= tar.length) {
    const header = tar.subarray(offset, offset + blockSize);
    if (header.every((byte) => byte === 0)) {
      if (offset + blockSize * 2 > tar.length ||
          tar.subarray(offset, offset + blockSize * 2).some((byte) => byte !== 0) ||
          tar.subarray(offset + blockSize * 2).some((byte) => byte !== 0)) {
        fail("Skill TAR 包结束标记无效。");
      }
      ended = true;
      break;
    }
    if (header.subarray(257, 263).toString("ascii") !== "ustar\0" ||
        header.subarray(263, 265).toString("ascii") !== "00") {
      fail("Skill TAR 包必须使用 USTAR 格式。");
    }

    let checksum = 0;
    for (let index = 0; index < blockSize; index += 1) {
      checksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (checksum !== parseTarNumber(header.subarray(148, 156))) fail("Skill TAR 包校验无效。");

    const name = parseTarText(header.subarray(0, 100));
    const prefix = parseTarText(header.subarray(345, 500));
    const fullName = prefix ? prefix + "/" + name : name;
    const typeFlag = header[156];
    const directory = typeFlag === 53;
    if (!directory && typeFlag !== 0 && typeFlag !== 48) fail("Skill TAR 包只能包含普通文件和目录。");
    if (!directory && fullName.endsWith("/")) fail("Skill TAR 包成员类型与路径不一致.");
    const path = safeArchivePath(fullName);
    const canonicalPath = path.split("/").map((part) => part.toLowerCase()).join("/");
    if (canonicalPaths.has(canonicalPath)) fail("Skill TAR 包包含重复路径。");
    canonicalPaths.add(canonicalPath);

    const size = parseTarNumber(header.subarray(124, 136));
    if (directory && size !== 0) fail("Skill TAR 包目录成员大小无效。");
    totalBytes += size;
    if (totalBytes > MAX_UNPACKED_BYTES || members.size >= MAX_ARCHIVE_FILES) {
      fail("Skill TAR 包解压后超过允许大小。");
    }
    const dataStart = offset + blockSize;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + Math.ceil(size / blockSize) * blockSize;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > tar.length ||
        tar.subarray(dataEnd, nextOffset).some((byte) => byte !== 0)) {
      fail("Skill TAR 包成员范围无效。");
    }
    if (members.has(path)) fail("Skill TAR 包包含重复路径。");
    members.set(path, {
      directory,
      size,
      data: directory ? undefined : tar.subarray(dataStart, dataEnd),
    });
    offset = nextOffset;
  }

  if (!ended || members.get("weixin-channels-video")?.directory !== true) {
    fail("Skill TAR 包缺少根目录。");
  }
  for (const path of members.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (members.get(parent)?.directory !== true) fail("Skill TAR 包目录层级无效。");
    }
  }
  return members;
}

export function parseSkillArchive(archiveBytes) {
  if (
    !Buffer.isBuffer(archiveBytes) || archiveBytes.length < 18 ||
    archiveBytes.length > MAX_DOWNLOAD_BYTES ||
    archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b
  ) fail("Skill TAR 包格式无效。");
  let tar;
  try { tar = gunzipSync(archiveBytes, { maxOutputLength: MAX_TAR_BYTES }); }
  catch { fail("Skill TAR 包无法读取或解压后超过允许大小。"); }
  return parseSkillTar(tar);
}

export async function unpackSkillArchive(archiveBytes, destination, parsedMembers = parseSkillArchive(archiveBytes)) {
  const members = parsedMembers;
  const destinationRoot = resolve(destination);
  await ensureNewCacheDirectory(destinationRoot);
  const directories = [...members].filter(([, member]) => member.directory)
    .sort(([first], [second]) => first.split("/").length - second.split("/").length);
  for (const [path] of directories) {
    const target = resolve(destinationRoot, ...path.split("/"));
    if (target !== destinationRoot && !target.startsWith(destinationRoot + sep)) fail("Skill TAR 包包含越界路径。");
    await ensureNewCacheDirectory(target);
  }
  for (const [path, member] of members) {
    if (member.directory) continue;
    const target = resolve(destinationRoot, ...path.split("/"));
    if (target !== destinationRoot && !target.startsWith(destinationRoot + sep)) fail("Skill TAR 包包含越界路径。");
    await writeCacheFile(target, member.data);
  }
}

async function ensureCacheRoot() {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    fail("此 Skill 目前支持 macOS 和 Windows。");
  }
  const appCacheRoot = dirname(LEGACY_CACHE_ROOT);
  if (process.platform === "win32") {
    await createOrAssertCacheDirectory(appCacheRoot);
  } else {
    await createOrAssertCacheDirectory(appCacheRoot, true);
  }
  await createOrAssertCacheDirectory(LEGACY_CACHE_ROOT);
  await createOrAssertCacheDirectory(CACHE_ROOT);
  if (process.platform === "darwin") {
    await chmod(LEGACY_CACHE_ROOT, 0o700);
    await chmod(CACHE_ROOT, 0o700);
  }
}

async function readCurrentMarker({ missingOk = false } = {}) {
  const markerPath = join(CACHE_ROOT, "current.json");
  try {
    await assertRegularFile(markerPath);
    if (process.platform === "win32") await assertWindowsPrivatePath(markerPath);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (
      !isRecord(marker) || ![2, 3].includes(Object.keys(marker).length) ||
      !parseVersion(marker.version) || marker.runtimeProtocol !== RUNTIME_PROTOCOL ||
      (Object.hasOwn(marker, "packageHash") &&
        (Object.keys(marker).length !== 3 || typeof marker.packageHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(marker.packageHash))) ||
      (!Object.hasOwn(marker, "packageHash") && Object.keys(marker).length !== 2)
    ) fail("运行资源缓存标记无效，已保留原文件。");
    return marker;
  } catch (error) {
    if (error.code === "ENOENT" && missingOk) return null;
    throw error;
  }
}

async function writeCurrentVersion(version, packageHash) {
  await readCurrentMarker({ missingOk: true });
  const markerPath = join(CACHE_ROOT, "current.json");
  const tempPath = join(CACHE_ROOT, ".current-" + randomUUID() + ".tmp");
  const marker = { version, runtimeProtocol: RUNTIME_PROTOCOL };
  if (packageHash) marker.packageHash = packageHash;
  try {
    await writeCacheFile(tempPath, Buffer.from(JSON.stringify(marker) + "\n"));
    if (process.platform === "darwin") await chmod(tempPath, 0o600);
    await rename(tempPath, markerPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function prepareFromRelease() {
  const candidates = releaseCandidates(await skillReleases());
  if (!candidates.length) fail("没有可用的稳定 Skill Release。");
  for (const { release, version } of candidates) {
    const destination = join(CACHE_ROOT, version);
    let destinationInfo;
    try { destinationInfo = await lstat(destination); }
    catch (error) { if (error.code !== "ENOENT") throw error; }

    if (destinationInfo) {
      if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
        fail("同版本运行资源缓存不是普通目录，已保留原数据。");
      }
      const runtime = await readRuntime(destination, version, { requirePrivate: true, allowIncompatible: true });
      if (!runtime.compatible) continue;
      await ensureCacheRoot();
      return materializeRuntime(runtime);
    }

    const { archive, checksums } = releasePackage(release, version);
    const releaseBase = RELEASE_DOWNLOADS + "/" + release.tag_name;
    const archiveName = archive.name;
    const [sumsBytes, archiveBytes] = await Promise.all([
      fetchBytes(releaseBase + "/SHA256SUMS", {
        maxBytes: 64 * 1024,
        expectedSize: checksums.size,
        contentTypes: ["text/plain", "application/octet-stream"],
      }),
      fetchBytes(releaseBase + "/" + archiveName, {
        expectedSize: archive.size,
        contentTypes: ARCHIVE_CONTENT_TYPES,
      }),
    ]);
    const expectedHash = checksumFor(sumsBytes.toString("utf8"), archiveName);
    const actualHash = createHash("sha256").update(archiveBytes).digest("hex");
    if (actualHash !== expectedHash) fail("Skill TAR 包 SHA256 校验失败。");

    const members = parseSkillArchive(archiveBytes);
    const metadataMember = members.get("weixin-channels-video/runtime.json");
    if (!metadataMember || metadataMember.directory) fail("Skill TAR 包缺少运行资源元数据。");
    const metadata = parseRuntimeMetadata(metadataMember.data.toString("utf8"), version);
    if (!isCompatibleRuntime(metadata)) continue;

    await ensureCacheRoot();
    const stage = await mkdtemp(join(CACHE_ROOT, ".prepare-" + version + "-"));
    try {
      await secureNewCacheDirectory(stage);
      const payload = join(stage, "payload");
      await unpackSkillArchive(archiveBytes, payload, members);
      const source = join(payload, "weixin-channels-video");
      const runtime = await readRuntime(source, version, { requirePrivate: true });
      const cached = await cacheRuntime(source, runtime, "release");
      return await materializeRuntime(cached);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  fail("没有与当前运行环境兼容的稳定 Skill Release。");
}

async function cacheRuntime(source, runtime, stagePrefix) {
  const packageHash = stagePrefix === "package" ? await runtimeContentHash(source) : null;
  const destination = join(CACHE_ROOT, packageHash
    ? runtime.version + "-package-" + packageHash
    : runtime.version);
  let destinationInfo;
  try { destinationInfo = await lstat(destination); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  if (destinationInfo) {
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
      fail("同版本运行资源缓存不是普通目录，已保留原数据。");
    }
    const cachedRuntime = await readRuntime(destination, runtime.version, { requirePrivate: true });
    if (packageHash && await runtimeContentHash(destination) !== packageHash) {
      fail("同版本运行资源缓存内容与包不一致，已保留原数据。");
    }
    return cachedRuntime;
  }

  const stage = await mkdtemp(join(CACHE_ROOT, "." + stagePrefix + "-" + runtime.version + "-"));
  try {
    await secureNewCacheDirectory(stage);
    const scripts = join(stage, "scripts");
    await ensureNewCacheDirectory(scripts);
    await copyCacheFile(join(source, "runtime.json"), join(stage, "runtime.json"));
    await copyCacheFile(runtime.runtimeCLI, join(scripts, "cli.mjs"));
    await copyCacheFile(join(dirname(runtime.runtimeCLI), "native-host.mjs"), join(scripts, "native-host.mjs"));
    await readRuntime(stage, runtime.version, { requirePrivate: true });
    if (packageHash && await runtimeContentHash(stage) !== packageHash) {
      fail("Skill 包内运行资源复制校验失败。");
    }

    try {
      await rename(stage, destination);
    } catch (error) {
      let existing;
      try { existing = await lstat(destination); }
      catch { throw error; }
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw error;
    }
    const cachedRuntime = await readRuntime(destination, runtime.version, { requirePrivate: true });
    if (packageHash && await runtimeContentHash(destination) !== packageHash) {
      fail("同版本运行资源缓存内容与包不一致，已保留原数据。");
    }
    return cachedRuntime;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function materializeRuntime(runtime, { writeMarker = writeCurrentVersion } = {}) {
  const previous = await readCurrentMarker({ missingOk: true });
  const runtimeRoot = dirname(dirname(runtime.runtimeCLI));
  const relativeRuntimeRoot = relative(CACHE_ROOT, runtimeRoot);
  const packagePrefix = runtime.version + "-package-";
  const packageHash = relativeRuntimeRoot.startsWith(packagePrefix)
    ? relativeRuntimeRoot.slice(packagePrefix.length)
    : null;
  if (packageHash && !/^[a-f0-9]{64}$/.test(packageHash)) {
    fail("运行资源缓存路径无效。");
  }
  if (!previous || previous.version !== runtime.version || (previous.packageHash ?? null) !== packageHash) {
    await writeMarker(runtime.version, packageHash);
  }
  return runtime;
}

async function packagedRuntime() {
  try { await lstat(join(SKILL_ROOT, "runtime.json")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const runtime = await readRuntime(SKILL_ROOT);
  await ensureCacheRoot();
  return cacheRuntime(SKILL_ROOT, runtime, "package");
}

async function currentRuntime() {
  const bundled = await packagedRuntime();
  if (bundled) {
    return materializeRuntime(bundled);
  }

  await ensureCacheRoot();
  const marker = await readCurrentMarker({ missingOk: true });
  if (!marker) {
    return prepareFromRelease();
  }
  const runtimeRoot = join(CACHE_ROOT, marker.packageHash
    ? marker.version + "-package-" + marker.packageHash
    : marker.version);
  const runtimeInfo = await lstat(runtimeRoot);
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) fail("当前运行资源缓存目录无效。");
  const runtime = await readRuntime(runtimeRoot, marker.version, { requirePrivate: true });
  if (marker.packageHash && await runtimeContentHash(runtimeRoot) !== marker.packageHash) {
    fail("当前 Skill 包运行资源缓存内容校验失败。请重新运行 prepare。");
  }
  return runtime;
}

function execute(runtimeCLI, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [runtimeCLI, ...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}

export async function run(args = process.argv.slice(2)) {
  assertSupportedNode();
  if (args[0] === "prepare") {
    if (args.length !== 1) fail("Usage: run.mjs prepare");
    const bundled = await packagedRuntime();
    const runtime = bundled ? await materializeRuntime(bundled) : await prepareFromRelease();
    process.stdout.write(JSON.stringify(runtime) + "\n");
    return 0;
  }
  if (!args.length) fail("Usage: run.mjs prepare | <cli-command> [options]");
  const runtime = await currentRuntime();
  return execute(runtime.runtimeCLI, args);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  run().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
}
