import { checkLogin, PARSE_ERROR_MESSAGES, ParseError, parseShareLink } from "../src/core.mjs";
import { BRIDGE_ERROR_MESSAGES, isAbsoluteDownloadPath, SESSION_ID_PATTERN, validateBridgeCommand } from "../src/native-messaging.mjs";
import { createExtensionRequest, startDownload, waitForDownload } from "./app.mjs";

const ERROR_MESSAGES = Object.freeze({ ...PARSE_ERROR_MESSAGES, ...BRIDGE_ERROR_MESSAGES });

const VIDEO_RESULT_FIELDS = ["title", "author", "coverUrl", "previewUrl", "downloadUrl"];
const BRIDGE_CONNECTION_STORAGE_KEY = "weixin-channels-video:bridge-connection-state";
const BRIDGE_SESSION_STORAGE_KEY = "weixin-channels-video:bridge-session";
const BRIDGE_CONNECTION_STAGES = new Set(["pairing_saved", "host_starting", "host_ready", "failed"]);
const BRIDGE_CONNECTION_REASONS = new Set([
  "connect_native_failed",
  "host_not_found",
  "host_not_registered",
  "host_start_failed",
  "host_access_forbidden",
  "host_exited",
  "host_communication_failed",
  "host_disconnected",
  "invalid_ready_message",
  "invalid_host_message",
]);
const BRIDGE_CONNECTION_MESSAGES = Object.freeze({
  pairing_saved: "已保存配对信息，正在连接。",
  host_starting: "正在连接本地程序。",
  host_ready: "浏览器已连接本地程序，AI 仍需确认连接和登录状态。",
  failed: "连接本地程序失败。请让 AI 检查 Skill 状态。",
});
const BRIDGE_CONNECTION_FAILURE_MESSAGES = Object.freeze({
  connect_native_failed: "浏览器连接本地程序失败。请让 AI 检查 Skill 配置。",
  host_not_found: "找不到本地程序。请让 AI 检查 Skill 是否安装。",
  host_not_registered: "本地程序尚未注册。请让 AI 检查 Skill 配置。",
  host_start_failed: "本地程序启动失败。请让 AI 检查运行环境。",
  host_access_forbidden: "浏览器未获准访问本地程序。请让 AI 检查扩展 ID 和配置。",
  host_exited: "本地程序已退出。请让 AI 检查运行状态。",
  host_communication_failed: "浏览器与本地程序通信失败。请让 AI 检查连接。",
  host_disconnected: "与本地程序的连接已断开。请让 AI 检查连接。",
  invalid_ready_message: "本地程序返回的启动状态无效。请让 AI 检查扩展和 Skill 版本。",
  invalid_host_message: "本地程序返回的数据无法识别。请让 AI 检查扩展和 Skill 版本。",
});

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

function isBridgeConnectionState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return value.version === 1 &&
    BRIDGE_CONNECTION_STAGES.has(value.stage) &&
    keys.every((key) => key === "version" || key === "stage" || key === "reason") &&
    (!Object.hasOwn(value, "reason") || BRIDGE_CONNECTION_REASONS.has(value.reason));
}

function initializeBridgeConnectionStatus({ chromeApi = globalThis.chrome } = {}) {
  const statusElement = document.querySelector("#bridge-connection-status");
  const storage = chromeApi?.storage?.local;
  const storageChanges = chromeApi?.storage?.onChanged;
  if (!statusElement || typeof storage?.get !== "function" || typeof storageChanges?.addListener !== "function") return;

  let changeVersion = 0;
  const render = (value) => {
    if (!isBridgeConnectionState(value)) {
      statusElement.textContent = "";
      statusElement.hidden = true;
      statusElement.removeAttribute("data-error");
      return;
    }

    statusElement.textContent = value.stage === "failed"
      ? BRIDGE_CONNECTION_FAILURE_MESSAGES[value.reason] ?? BRIDGE_CONNECTION_MESSAGES.failed
      : BRIDGE_CONNECTION_MESSAGES[value.stage];
    statusElement.hidden = false;
    statusElement.dataset.error = String(value.stage === "failed");
  };
  storageChanges.addListener((changes, areaName) => {
    if (areaName !== "local" || !Object.hasOwn(changes ?? {}, BRIDGE_CONNECTION_STORAGE_KEY)) return;
    changeVersion += 1;
    render(changes[BRIDGE_CONNECTION_STORAGE_KEY].newValue);
  });

  const initialChangeVersion = changeVersion;
  Promise.resolve().then(() => storage.get(BRIDGE_CONNECTION_STORAGE_KEY)).then((stored) => {
    if (initialChangeVersion === changeVersion) render(stored?.[BRIDGE_CONNECTION_STORAGE_KEY]);
  }).catch(() => {
    if (initialChangeVersion === changeVersion) render(undefined);
  });
}

export function initializeManualPairing({ chromeApi = globalThis.chrome, documentApi = globalThis.document } = {}) {
  const form = documentApi?.querySelector("#manual-pairing-form");
  const input = documentApi?.querySelector("#pairing-session-id");
  const status = documentApi?.querySelector("#manual-pairing-status");
  const storageStatus = documentApi?.querySelector("#pairing-storage-status");
  const version = documentApi?.querySelector("#extension-version");
  const storage = chromeApi?.storage?.local;
  if (!form || !input || !status || !storageStatus || !version) return;

  let manifestVersion;
  try { manifestVersion = chromeApi?.runtime?.getManifest?.()?.version; }
  catch { /* A non-extension preview has no manifest version. */ }
  version.textContent = typeof manifestVersion === "string" && manifestVersion ? manifestVersion : "unknown";

  const readStorage = async () => {
    if (typeof storage?.get !== "function") {
      storageStatus.textContent = "配对信息存储状态：扩展存储不可用。";
      storageStatus.dataset.error = "true";
      return;
    }
    try {
      const stored = await storage.get(BRIDGE_SESSION_STORAGE_KEY);
      storageStatus.textContent = SESSION_ID_PATTERN.test(stored?.[BRIDGE_SESSION_STORAGE_KEY] ?? "")
        ? "已保存配对信息。"
        : "尚未保存配对信息。";
      storageStatus.dataset.error = "false";
    } catch {
      storageStatus.textContent = "配对信息存储状态：无法读取 Chrome 扩展存储。";
      storageStatus.dataset.error = "true";
    }
  };
  void readStorage();
  chromeApi.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && Object.hasOwn(changes ?? {}, BRIDGE_SESSION_STORAGE_KEY)) void readStorage();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const sessionId = input.value.trim();
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      status.textContent = "请粘贴完整的配对码。";
      status.dataset.error = "true";
      input.setAttribute?.("aria-invalid", "true");
      input.focus();
      return;
    }
    input.removeAttribute?.("aria-invalid");
    status.textContent = "正在保存配对信息并连接。";
    status.dataset.error = "false";
    try {
      const response = await chromeApi.runtime.sendMessage({ type: PAIRING_MESSAGE_TYPE, sessionId });
      if (response?.ok !== true) throw new Error();
      status.textContent = "配对信息已保存；请查看上方连接状态。若连接失败，请让 AI 运行 diagnose。";
      status.dataset.error = "false";
      await readStorage();
    } catch {
      status.textContent = "提交失败。请确认当前页面由此扩展打开后重试。";
      status.dataset.error = "true";
    }
  });
}

export function createAgentCommandHandler({
  chromeApi = globalThis.chrome,
  requestFactory = () => createExtensionRequest(),
  loginChecker = checkLogin,
  parser = parseShareLink,
  downloadStarter = startDownload,
  downloadWaiter = waitForDownload,
} = {}) {
  return async (request) => {
    if (!validateBridgeCommand(request)) {
      return { id: request?.id, ok: false, error: { code: "INVALID_COMMAND", message: BRIDGE_ERROR_MESSAGES.INVALID_COMMAND } };
    }
    try {
      if (request.command === "status") {
        const login = await loginChecker(requestFactory());
        let version = "unknown";
        try { version = chromeApi?.runtime?.getManifest?.()?.version || version; }
        catch { /* A non-extension runtime does not expose a manifest version. */ }
        return { id: request.id, ok: true, result: { login: login.status, versions: { extension: version } } };
      }

      const video = await parser(request.url, { request: requestFactory() });
      if (request.command === "parse") {
        return { id: request.id, ok: true, result: projectVideoResult(video) };
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
          ...projectVideoResult(video),
          state: download.state,
          path: download.path,
          bytes: download.bytes,
        },
      };
    } catch (error) {
      return { id: request.id, ok: false, error: safeError(error) };
    }
  };
}

const PAIRING_MESSAGE_TYPE = "weixin-channels-video:pair";

export function startAgent({ chromeApi = globalThis.chrome, windowApi = globalThis } = {}) {
  const acceptPairing = async () => {
    const match = windowApi.location.hash.match(/^#agent-connect=(.*)$/);
    if (!match) return;
    const sessionId = match[1];
    try {
      windowApi.history.replaceState(windowApi.history.state, "", chromeApi.runtime.getURL("index.html"));
    } catch {
      return;
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) return;
    try {
      const response = await chromeApi.runtime.sendMessage({ type: PAIRING_MESSAGE_TYPE, sessionId });
      if (response?.ok !== true) return;
      const tab = await chromeApi.tabs.getCurrent();
      if (Number.isInteger(tab?.id)) await chromeApi.tabs.remove(tab.id);
    } catch {
      // Keep the bootstrap page open when pairing was not acknowledged.
    }
  };
  windowApi.addEventListener("hashchange", () => { void acceptPairing(); });
  void acceptPairing();
}

function initializeAIDownloadPrompt({ windowApi = globalThis } = {}) {
  const openButton = document.querySelector("#ai-download-prompt-open");
  const popover = document.querySelector("#ai-download-prompt-popover");
  const promptText = document.querySelector("#ai-download-prompt-text");
  const copyButton = document.querySelector("#ai-download-prompt-copy");
  const copyStatus = document.querySelector("#ai-prompt-copy-status");
  if (!openButton || !popover || !promptText || !copyButton || !copyStatus) return;

  const prompt = [
    "请为我安装并准备视频号分享链接解析工具。本次仅安装并完成连接准备，暂不解析或下载。之后我明确提供分享链接并要求下载时，直接按 Skill 执行。",
    "",
    "先确定你实际运行的 Agent、OS、CPU 架构、Shell/执行环境，以及能否操作目标机器上的 Chrome。若处于云端、远端或隔离环境，不要假设能访问本机 Chrome。",
    "先在我选定的 Chrome 用户中检查扩展是否已安装、启用，并通过真实 Native Messaging 握手确认连接。若扩展 ID、profile 和桥接配置未变化且握手有效，直接复用。需要配置桥接时，只从 chrome://extensions 读取我选定扩展的实际 ID 一次，并用该 ID 执行 `install-bridge --extension-id <extension-id>`；不要从提示词推断或代填 ID。确需选择用户时只问我一次，不逐个尝试账号或创建新 profile。",
    "缺少扩展时，默认按仓库 README 的 Chrome 扩展章节，通过其中的官方商店链接安装：https://github.com/MC0571/weixin-channels-video#chrome-扩展。商店版可能晚于 Release；核对 Chrome 中实际安装版本与所需功能对应的发布版本，未确认前不要假设该功能已生效，也不要自动覆盖或重装已安装的商店版。只有我选择非商店版时，才从 GitHub Releases（https://github.com/MC0571/weixin-channels-video/releases）下载独立的扩展 ZIP，核对同版本 SHA256SUMS 后解压并保留解压目录；或按仓库构建说明从源码构建。扩展不随 Skill 包分发，`prepare` 不下载或更新扩展。",
    "尽量在后台打开或复用 Chrome 窗口与标签页，避免抢桌面或浏览器焦点。",
    "",
    "在运行任何 node/npm/npx/prepare 命令前，先读取并遵守此安装说明（当前可从 GitHub 直接读取）：",
    "https://github.com/MC0571/weixin-channels-video/blob/main/skills/weixin-channels-video/references/agent-installation.md",
    "Skill 最低需要 Node.js 22.22.2。核实目标 Agent 的实际执行环境、Node 版本和绝对路径；已有兼容 Node 直接复用。缺失或版本过低时，沿用我当前任务或仍有效的安装委托，只从 Node 官方来源获取匹配 OS/架构的版本并核验 SHA-256；保留已有 Node 与 Shell 配置。Windows 原生与 WSL 分别处理；WSL 的 Linux Node 不能注册 Windows Chrome host。若宿主/系统实际拦截或要求额外审批，准确交接并由我完成该确认，不关闭安全策略。",
    "",
    "获取完整 Skill：优先下载 GitHub Releases 中的正式 Skill TAR.GZ/ZIP，先按同版本 SHA256SUMS 校验，再安装 SKILL.md、scripts、references 和所有随包资源；不要求克隆源码仓库或自行构建。只有确认目标是受支持的 CLI 且 Node 已满足要求时，才使用 skills CLI。先检查用户级目标中没有同名 Skill 或本地修改；若已有则按官方更新方式处理，不能用自动确认覆盖。目标为空时明确安装范围并指定单个 Agent 与 Skill；例如 codex 命令为：",
    "npx --yes skills add MC0571/weixin-channels-video --global --yes --skill weixin-channels-video --agent codex",
    "其他 Agent 必须按实际产品换成唯一对应的键，不能照抄 codex 示例。",
    "不要省略 --agent、不要用 --all。WorkBuddy、豆包工作和 QwenWork 使用各自官方入口；产品、导入包格式或本地命令能力未明确时，说明未知并交接，不借用 CodeBuddy/Qwen Code 映射。",
    "",
    "Skill 安装后读取完整 SKILL.md 和 references，运行 prepare，再运行普通 diagnose；先处理顶层 nextAction 并重新诊断。runtime 描述包内资源版本，status.versions 显示 CLI、host 和扩展的实际版本，unknown 表示该组件未提供版本。currentNode 是运行 CLI 的 Node，bridge.node / bridge.nodeVersion 是桥接使用的 Node。目标扩展 ID 已从我选定的扩展确认且无需指定 profile 时，运行 `install-bridge --extension-id <extension-id>`；只有需要指定 Chrome 用户时才加 `--profile <目录名或名称>`。需要选择用户时先让我选择；枚举 Chrome 用户或读取 profile 元数据不是安装和连接的前提。已有扩展且 ID、profile 和桥接有效时直接复用；扩展缺失时按我选择的安装方式获取并保留扩展目录，不从 `prepare` 获取扩展。配对时运行 `pairing-info`，将输出的配对码粘贴到扩展的 Agent 设置表单，再运行 connect 和 status，以真实握手与登录检查确认就绪。",
    "若缺少桌面操作能力但仍能在目标机读写文件、运行命令并下载 Release，先完成可代办的 Skill 资源准备，再默认交接按 README 官方商店链接安装扩展的步骤。只有我选择非商店版时，才下载、校验并解压独立扩展，再交接加载步骤。若无法操作目标机文件或运行命令，就说明哪些准备无法代办，不要声称已完成。首次打开、系统授权、扫码和验证码由我完成；普通可逆安装沿用我当前任务中的授权，不重复询问。",
    "",
    "隐私边界：不要请求、复制或公开 Cookie、登录凭据、配对 secret 或 generalToken，也不要把它们写入公共日志。解析产生的临时媒体链接仅用于本次视频展示或下载，不写入公共日志。",
  ].join("\n");
  promptText.value = prompt;

  const updatePopoverPosition = () => {
    if (!popover.matches(":popover-open")) return;
    const anchor = openButton.getBoundingClientRect();
    const viewportWidth = windowApi.innerWidth;
    const viewportHeight = windowApi.innerHeight;
    const panel = popover.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const maxLeft = Math.max(margin, viewportWidth - panel.width - margin);
    const left = Math.min(maxLeft, Math.max(margin, anchor.right - panel.width));
    const below = anchor.bottom + gap;
    const above = anchor.top - panel.height - gap;
    const top = below + panel.height <= viewportHeight - margin
      ? below
      : above >= margin ? above : Math.max(margin, viewportHeight - panel.height - margin);
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  };

  popover.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "open") return;
    copyStatus.textContent = "";
    copyStatus.dataset.error = "false";
    delete popover.dataset.positioned;
  });
  popover.addEventListener("toggle", (event) => {
    const isOpen = event.newState === "open";
    openButton.setAttribute("aria-expanded", String(isOpen));
    if (!isOpen) {
      delete popover.dataset.positioned;
      return;
    }
    updatePopoverPosition();
    popover.dataset.positioned = "true";
    promptText.focus({ preventScroll: true });
    promptText.setSelectionRange(0, 0);
    promptText.scrollTop = 0;
  });
  windowApi.addEventListener("resize", updatePopoverPosition);
  windowApi.addEventListener("scroll", updatePopoverPosition, true);
  copyButton.addEventListener("click", async () => {
    try {
      await windowApi.navigator.clipboard.writeText(promptText.value);
      copyStatus.textContent = "提示词已复制。请切换到 Agent 对话框并自行粘贴。";
      copyStatus.dataset.error = "false";
      updatePopoverPosition();
    } catch {
      promptText.focus();
      promptText.select();
      copyStatus.textContent = "复制失败，全文已选中。请按 Command+C（Mac）或 Ctrl+C（Windows/Linux）手动复制。";
      copyStatus.dataset.error = "true";
      updatePopoverPosition();
    }
  });
}

if (typeof document !== "undefined") {
  void startAgent();
  initializeAIDownloadPrompt();
  initializeBridgeConnectionStatus();
  initializeManualPairing();
}
