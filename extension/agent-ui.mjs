import { initializeUpdateUi } from "./update-ui.mjs";

import {
  CONNECTION_STORAGE_KEY,
  INSTANCE_STORAGE_KEY,
  LOGIN_REFRESH_TYPE,
  LOGIN_STORAGE_KEY,
} from "./agent-state.mjs";

const BRIDGE_STAGES = new Set(["host_starting", "host_ready", "failed"]);
const BRIDGE_REASONS = new Set([
  "connect_native_failed", "host_not_found", "host_not_registered", "host_start_failed",
  "host_access_forbidden", "host_exited", "host_communication_failed", "host_disconnected",
  "invalid_ready_message", "invalid_host_message", "protocol_unsupported",
]);
const BRIDGE_MESSAGES = Object.freeze({
  host_starting: "正在连接本地程序。",
  host_ready: "浏览器已连接本地程序。",
  failed: "连接本地程序失败。请让 AI 检查 Skill 状态。",
});
const BRIDGE_FAILURES = Object.freeze({
  connect_native_failed: "浏览器连接本地程序失败。请让 AI 检查 Skill 配置。",
  host_not_found: "找不到本地程序。请让 AI 检查 Skill 是否安装。",
  host_not_registered: "本地程序尚未注册。请让 AI 检查 Skill 配置。",
  host_start_failed: "本地程序启动失败。请让 AI 检查运行环境。",
  host_access_forbidden: "浏览器未获准访问本地程序。请让 AI 检查扩展配置。",
  host_exited: "本地程序已退出，连接未建立或已中断。请让 AI 检查本地桥接。",
  host_communication_failed: "浏览器与本地程序通信失败。请让 AI 检查连接。",
  host_disconnected: "与本地程序的连接已断开。请让 AI 检查连接。",
  invalid_ready_message: "本地程序返回的启动状态无效。请让 AI 检查扩展和 Skill 版本。",
  invalid_host_message: "本地程序返回的数据无法识别。请让 AI 检查扩展和 Skill 版本。",
  protocol_unsupported: "扩展与本地程序协议不兼容。请让 AI 更新 Skill。",
});

const PROMPT = [
  "扩展已安装。请先阅读并遵守安装指引：https://github.com/MC0571/weixin-channels-video/blob/main/skills/weixin-channels-video/references/agent-installation.md",
  "确认当前宿主能否访问装有扩展的目标 Chrome 用户，再按宿主官方入口安装或复用完整 Skill。尽量在后台复用已有浏览器；扩展缺失时默认引导安装 Chrome Web Store 版本，只有我明确选择时才使用非商店版。",
  "按 Skill 配置桥接，以 Agent 与扩展真实通信往返成功为准。需要我选择 Chrome 用户、首次打开浏览器或完成系统授权时再交接；完成后报告连接结果并停止。本次不要求我登录元宝，也不要求解析或下载视频。",
].join("\n");

function validBridgeState(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    value.version === 1 && BRIDGE_STAGES.has(value.stage) &&
    Object.keys(value).every((key) => ["version", "stage", "reason"].includes(key)) &&
    (!Object.hasOwn(value, "reason") || BRIDGE_REASONS.has(value.reason)));
}

function validLoginState(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    ["authenticated", "anonymous", "failed", "not_checked"].includes(value.login) &&
    (value.checkedAt === null || Number.isFinite(value.checkedAt)) &&
    (!Object.hasOwn(value, "error") || value.error === "LOGIN_CHECK_FAILED"));
}

function initializeBridgeStatus(chromeApi, documentApi) {
  const status = documentApi.querySelector("#bridge-connection-status");
  const storage = chromeApi?.storage?.local;
  const changes = chromeApi?.storage?.onChanged;
  if (!status || typeof storage?.get !== "function" || typeof changes?.addListener !== "function") return;

  let changeVersion = 0;
  const render = (value) => {
    if (!validBridgeState(value)) {
      status.textContent = "";
      status.hidden = true;
      status.removeAttribute("data-error");
      return;
    }
    status.textContent = value.stage === "failed"
      ? BRIDGE_FAILURES[value.reason] ?? BRIDGE_MESSAGES.failed
      : BRIDGE_MESSAGES[value.stage];
    status.hidden = false;
    status.dataset.error = String(value.stage === "failed");
  };
  changes.addListener((items, area) => {
    if (area !== "local" || !Object.hasOwn(items ?? {}, CONNECTION_STORAGE_KEY)) return;
    changeVersion += 1;
    render(items[CONNECTION_STORAGE_KEY].newValue);
  });
  const version = changeVersion;
  Promise.resolve().then(() => storage.get(CONNECTION_STORAGE_KEY)).then((stored) => {
    if (version === changeVersion) render(stored?.[CONNECTION_STORAGE_KEY]);
  }).catch(() => {
    if (version === changeVersion) render(undefined);
  });
}

function initializeLoginStatus(chromeApi, windowApi, documentApi) {
  const status = documentApi.querySelector("#login-status");
  const link = documentApi.querySelector("#yuanbao-login-link");
  if (!status || !link) return;

  let changeVersion = 0;
  const render = (value) => {
    if (!validLoginState(value)) {
      status.textContent = "";
      status.hidden = true;
      link.hidden = true;
      return;
    }
    status.hidden = false;
    link.hidden = value.login !== "anonymous";
    status.textContent = ({
      authenticated: "腾讯元宝：已登录。",
      anonymous: "腾讯元宝：未登录。",
      failed: "腾讯元宝登录状态检查失败。",
      not_checked: "腾讯元宝登录状态尚未检查。",
    })[value.login];
  };
  chromeApi?.storage?.onChanged?.addListener((items, area) => {
    if (area === "local" && Object.hasOwn(items ?? {}, LOGIN_STORAGE_KEY)) {
      changeVersion += 1;
      render(items[LOGIN_STORAGE_KEY].newValue);
    }
  });
  const initialChangeVersion = changeVersion;
  Promise.resolve().then(() => chromeApi?.storage?.local?.get?.(LOGIN_STORAGE_KEY)).then((stored) => {
    if (initialChangeVersion === changeVersion) render(stored?.[LOGIN_STORAGE_KEY]);
  }).catch(() => {
    if (initialChangeVersion === changeVersion) render(undefined);
  });
  try { void Promise.resolve(chromeApi?.runtime?.sendMessage?.({ type: LOGIN_REFRESH_TYPE })).catch(() => {}); }
  catch { /* A closed or unavailable extension runtime cannot refresh this snapshot. */ }
}

function initializeAgentIdentity(chromeApi, documentApi) {
  const version = documentApi.querySelector("#extension-version");
  const instance = documentApi.querySelector("#agent-instance-id");
  try {
    const manifestVersion = chromeApi?.runtime?.getManifest?.()?.version;
    if (version) version.textContent = typeof manifestVersion === "string" && manifestVersion ? manifestVersion : "unknown";
  } catch {
    if (version) version.textContent = "unknown";
  }
  const storage = chromeApi?.storage?.local;
  if (instance && typeof storage?.get === "function") {
    Promise.resolve().then(() => storage.get(INSTANCE_STORAGE_KEY)).then((stored) => {
      const id = stored?.[INSTANCE_STORAGE_KEY];
      instance.textContent = typeof id === "string" && id.length >= 8 ? id.slice(0, 8) : "暂不可用";
    }).catch(() => { instance.textContent = "暂不可用"; });
  }
}

function initializePrompt(windowApi, documentApi) {
  const openButton = documentApi.querySelector("#ai-download-prompt-open");
  const popover = documentApi.querySelector("#ai-download-prompt-popover");
  const promptText = documentApi.querySelector("#ai-download-prompt-text");
  const copyButton = documentApi.querySelector("#ai-download-prompt-copy");
  const copyStatus = documentApi.querySelector("#ai-prompt-copy-status");
  const copyLabel = documentApi.querySelector("#ai-download-prompt-copy-label");
  const copyIcon = documentApi.querySelector("#ai-download-prompt-copy-icon");
  const successIcon = documentApi.querySelector("#ai-download-prompt-copy-success");
  if (!openButton || !popover || !promptText || !copyButton || !copyStatus || !copyLabel || !copyIcon || !successIcon) return;
  promptText.value = PROMPT;

  const updatePosition = () => {
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
  let copiedTimer;
  let copyAttempt = 0;
  const resetCopied = () => {
    delete copyButton.dataset.copied;
    copyLabel.textContent = "复制提示词";
    copyIcon.hidden = false;
    successIcon.hidden = true;
  };
  const showCopied = () => {
    windowApi.clearTimeout(copiedTimer);
    copyButton.dataset.copied = "true";
    copyLabel.textContent = "已复制";
    copyIcon.hidden = true;
    successIcon.hidden = false;
    copiedTimer = windowApi.setTimeout(() => {
      delete copyButton.dataset.copied;
      copyLabel.textContent = "复制提示词";
      copyIcon.hidden = false;
      successIcon.hidden = true;
    }, 2000);
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
    updatePosition();
    popover.dataset.positioned = "true";
    promptText.focus({ preventScroll: true });
    promptText.setSelectionRange(0, 0);
    promptText.scrollTop = 0;
  });
  windowApi.addEventListener("resize", updatePosition);
  windowApi.addEventListener("scroll", updatePosition, true);
  copyButton.addEventListener("click", async () => {
    const attempt = ++copyAttempt;
    windowApi.clearTimeout(copiedTimer);
    resetCopied();
    try {
      await windowApi.navigator.clipboard.writeText(promptText.value);
      if (attempt !== copyAttempt) return;
      copyStatus.textContent = "提示词已复制。请切换到 Agent 对话框并自行粘贴。";
      copyStatus.dataset.error = "false";
      showCopied();
      updatePosition();
    } catch {
      if (attempt !== copyAttempt) return;
      promptText.focus();
      promptText.select();
      copyStatus.textContent = "复制失败，全文已选中。请按 Command+C（Mac）或 Ctrl+C（Windows/Linux）手动复制。";
      copyStatus.dataset.error = "true";
      updatePosition();
    }
  });
}

export function initializeAgentUI({
  chromeApi = globalThis.chrome,
  windowApi = globalThis,
  documentApi = globalThis.document,
} = {}) {
  if (!documentApi?.querySelector) return;
  initializeBridgeStatus(chromeApi, documentApi);
  initializeLoginStatus(chromeApi, windowApi, documentApi);
  initializeAgentIdentity(chromeApi, documentApi);
  initializePrompt(windowApi, documentApi);
  initializeUpdateUi({ documentApi, chromeApi });
}
