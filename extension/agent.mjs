import { checkLogin, PARSE_ERROR_MESSAGES, ParseError, parseShareLink } from "../src/core.mjs";
import { BRIDGE_ERROR_MESSAGES, isAbsoluteDownloadPath, validateBridgeCommand } from "../src/native-messaging.mjs";
import { createExtensionRequest, startDownload, waitForDownload } from "./app.mjs";
import { initializeAgentUI } from "./agent-ui.mjs";

const ERROR_MESSAGES = Object.freeze({ ...PARSE_ERROR_MESSAGES, ...BRIDGE_ERROR_MESSAGES });
const VIDEO_RESULT_FIELDS = ["title", "author", "coverUrl", "previewUrl", "downloadUrl"];

function safeError(error) {
  const candidate = error instanceof ParseError ? error.code : error?.message;
  const code = candidate === "DOWNLOAD_STATUS_UNAVAILABLE"
    ? "DOWNLOAD_FAILED"
    : Object.hasOwn(ERROR_MESSAGES, candidate) ? candidate : "UPSTREAM_ERROR";
  return { code, message: ERROR_MESSAGES[code] };
}

function projectVideoResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("UPSTREAM_ERROR");
  const output = {};
  for (const key of VIDEO_RESULT_FIELDS) {
    if (typeof result[key] !== "string") throw new Error("UPSTREAM_ERROR");
    output[key] = result[key];
  }
  if (!Array.isArray(result.mediaVariants)) throw new Error("UPSTREAM_ERROR");
  output.mediaVariants = result.mediaVariants.map((variant) => {
    if (!variant || typeof variant.label !== "string" || typeof variant.downloadUrl !== "string") {
      throw new Error("UPSTREAM_ERROR");
    }
    return { label: variant.label, downloadUrl: variant.downloadUrl };
  });
  return output;
}

export function createAgentCommandHandler({
  chromeApi = globalThis.chrome,
  requestFactory = () => createExtensionRequest(),
  loginChecker = checkLogin,
  statusProvider,
  instanceIdProvider = async () => "unknown",
  onAuthenticationFailure = () => {},
  onParseSuccess = async () => {},
  parser = parseShareLink,
  downloadStarter = startDownload,
  downloadWaiter = waitForDownload,
} = {}) {
  return async (request, { source = "agent" } = {}) => {
    if (!validateBridgeCommand(request)) {
      return { id: request?.id, ok: false, error: { code: "INVALID_COMMAND", message: BRIDGE_ERROR_MESSAGES.INVALID_COMMAND } };
    }
    try {
      if (request.command === "status") {
        const state = statusProvider
          ? await statusProvider({ refreshLogin: request.refreshLogin === true })
          : { login: (await loginChecker(requestFactory())).status, checkedAt: null };
        let version = "unknown";
        try { version = chromeApi?.runtime?.getManifest?.()?.version || version; }
        catch { /* A non-extension runtime does not expose a manifest version. */ }
        return {
          id: request.id,
          ok: true,
          result: {
            instanceId: await instanceIdProvider(),
            nativeProtocol: 2,
            login: state.login,
            checkedAt: state.checkedAt,
            ...(state.error ? { error: state.error } : {}),
            versions: { extension: version },
          },
        };
      }

      const video = projectVideoResult(await parser(request.url, { request: requestFactory() }));
      try { await onParseSuccess({ source }); }
      catch { /* Parse success remains valid if optional engagement storage is unavailable. */ }
      if (request.command === "parse") {
        return { id: request.id, ok: true, result: video };
      }

      let downloadId;
      try { downloadId = await downloadStarter(video, chromeApi, request.filename); }
      catch { throw new Error("DOWNLOAD_FAILED"); }
      const download = await downloadWaiter(downloadId, chromeApi);
      if (
        !download ||
        !["complete", "interrupted"].includes(download.state) ||
        typeof download.path !== "string" ||
        !download.path ||
        !isAbsoluteDownloadPath(download.path) ||
        !Number.isInteger(download.bytes) ||
        download.bytes <= 0
      ) throw new Error("DOWNLOAD_EMPTY");
      if (download.state === "interrupted") {
        return {
          id: request.id,
          ok: false,
          error: { code: "DOWNLOAD_INTERRUPTED", message: ERROR_MESSAGES.DOWNLOAD_INTERRUPTED },
          result: { state: download.state, path: download.path, bytes: download.bytes },
        };
      }
      return {
        id: request.id,
        ok: true,
        result: {
          ...video,
          state: download.state,
          path: download.path,
          bytes: download.bytes,
        },
      };
    } catch (error) {
      if (error?.code === "AUTH_EXPIRED" || error?.message === "AUTH_EXPIRED") await onAuthenticationFailure(error);
      return { id: request.id, ok: false, error: safeError(error) };
    }
  };
}

if (typeof document !== "undefined") {
  const initialize = () => initializeAgentUI();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
}
