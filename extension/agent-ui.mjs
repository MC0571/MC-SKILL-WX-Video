import { initializeUpdateUi } from "./update-ui.mjs";

import {
  CONNECTION_STORAGE_KEY,
  INSTANCE_STORAGE_KEY,
  LOGIN_REFRESH_TYPE,
  LOGIN_STORAGE_KEY,
} from "./agent-state.mjs";
import { INSTANCE_ID_PATTERN } from "../src/native-messaging.mjs";

const BRIDGE_STAGES = new Set(["host_starting", "host_ready", "failed"]);
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const IDENTITY_WAITING = "正在准备安装提示词，请稍候。";
const IDENTITY_READ_FAILED = "暂时无法准备安装提示词，请重新打开插件页。";
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

function buildPrompt({ extensionId, instanceId }) {
  return [
    "扩展已安装。此提示词来自用户当前选定的 Chrome 用户，身份如下：",
    `当前扩展 ID：${extensionId}`,
    `当前扩展实例 UUID：${instanceId}`,
    "请先阅读并遵守安装指引：https://github.com/MC0571/weixin-channels-video/blob/main/skills/weixin-channels-video/references/agent-installation.md",
    "按宿主官方入口安装或复用完整 Skill，再按 Skill 指引使用上述身份检查或修复桥接。复制这份提示词代表用户选择了这个 Chrome 用户，不要改选其他实例。",
    "以 Agent 与扩展真实通信往返成功为准；完成后用普通语言简短报告连接与元宝登录状态及下一步。若指引要求我完成权限或其他人工操作，只交接那一步并停止。",
  ].join("\n");
}

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

function initializeBridgeStatus(chromeApi, windowApi, documentApi) {
  const light = documentApi.querySelector("#agent-connection-light");
  const button = documentApi.querySelector("#ai-download-prompt-open");
  const tooltip = documentApi.querySelector("#agent-connection-tooltip");
  const storage = chromeApi?.storage?.local;
  const changes = chromeApi?.storage?.onChanged;
  if (!light || !button || !tooltip || typeof storage?.get !== "function" || typeof changes?.addListener !== "function") return;

  const resetTooltip = () => { delete button.dataset.tooltipDismissed; };
  button.addEventListener("pointerenter", resetTooltip);
  button.addEventListener("focus", resetTooltip);
  button.addEventListener("click", () => { button.dataset.tooltipDismissed = "true"; });
  windowApi.addEventListener("keydown", (event) => {
    if (event.key === "Escape") button.dataset.tooltipDismissed = "true";
  });

  let changeVersion = 0;
  const render = (value) => {
    const stage = validBridgeState(value) ? value.stage : undefined;
    const label = ({
      host_ready: "已连接", host_starting: "正在连接", failed: "未连接",
    })[stage] ?? "连接状态尚未确认";
    light.dataset.state = ({
      host_ready: "connected", host_starting: "connecting", failed: "disconnected",
    })[stage] ?? "unknown";
    button.setAttribute("aria-label", `Agent 设置，${label}`);
    const description = stage === "failed"
      ? BRIDGE_FAILURES[value.reason] ?? BRIDGE_MESSAGES.failed
      : BRIDGE_MESSAGES[stage] ?? label;
    tooltip.textContent = description;
  };
  render(undefined);
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
    status.hidden = value.login === "authenticated";
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

function initializeAgentIdentity(chromeApi, setPromptIdentity) {
  const extensionId = chromeApi?.runtime?.id;
  const validExtensionId = typeof extensionId === "string" && EXTENSION_ID_PATTERN.test(extensionId);
  const storage = chromeApi?.storage?.local;
  const changes = chromeApi?.storage?.onChanged;
  const render = (id, errorMessage) => {
    const validInstanceId = typeof id === "string" && INSTANCE_ID_PATTERN.test(id);
    if (validExtensionId && validInstanceId) {
      setPromptIdentity?.({ extensionId, instanceId: id });
    } else {
      setPromptIdentity?.(undefined, !validExtensionId
        ? IDENTITY_READ_FAILED
        : errorMessage ?? (id === undefined ? IDENTITY_WAITING : IDENTITY_READ_FAILED));
    }
  };
  if (!validExtensionId) {
    render(undefined, IDENTITY_READ_FAILED);
    return;
  }
  if (typeof storage?.get !== "function" || typeof changes?.addListener !== "function") {
    render(undefined, IDENTITY_READ_FAILED);
    return;
  }
  let changeVersion = 0;
  changes.addListener((items, area) => {
    if (area !== "local" || !Object.hasOwn(items ?? {}, INSTANCE_STORAGE_KEY)) return;
    changeVersion += 1;
    render(items[INSTANCE_STORAGE_KEY].newValue,
      items[INSTANCE_STORAGE_KEY].newValue === undefined ? undefined : IDENTITY_READ_FAILED);
  });
  const initialChangeVersion = changeVersion;
  Promise.resolve().then(() => storage.get(INSTANCE_STORAGE_KEY)).then((stored) => {
    if (initialChangeVersion !== changeVersion) return;
    const id = stored?.[INSTANCE_STORAGE_KEY];
    render(id, id === undefined ? undefined : IDENTITY_READ_FAILED);
  }).catch(() => {
    if (initialChangeVersion === changeVersion) render(undefined, IDENTITY_READ_FAILED);
  });
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
  let identityReady = false;
  copyButton.disabled = true;
  promptText.value = "";
  copyStatus.textContent = IDENTITY_WAITING;
  copyStatus.dataset.error = "false";
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
  const setPromptIdentity = (identity, errorMessage) => {
    copyAttempt += 1;
    windowApi.clearTimeout(copiedTimer);
    resetCopied();
    identityReady = Boolean(identity);
    copyButton.disabled = !identityReady;
    promptText.value = identity ? buildPrompt(identity) : "";
    copyStatus.textContent = identity ? "" : errorMessage;
    copyStatus.dataset.error = String(!identity && errorMessage !== IDENTITY_WAITING);
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
    if (identityReady) {
      copyStatus.textContent = "";
      copyStatus.dataset.error = "false";
    }
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
    if (!identityReady || copyButton.disabled) return;
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
  return setPromptIdentity;
}

export function initializeAgentUI({
  chromeApi = globalThis.chrome,
  windowApi = globalThis,
  documentApi = globalThis.document,
} = {}) {
  if (!documentApi?.querySelector) return;
  const versionBadge = documentApi.querySelector("#extension-version");
  if (versionBadge) {
    const version = chromeApi.runtime.getManifest().version;
    versionBadge.textContent = `v${version}`;
    versionBadge.setAttribute("aria-label", `扩展版本 ${version}`);
    versionBadge.hidden = false;
  }
  initializeBridgeStatus(chromeApi, windowApi, documentApi);
  initializeLoginStatus(chromeApi, windowApi, documentApi);
  const setPromptIdentity = initializePrompt(windowApi, documentApi);
  initializeAgentIdentity(chromeApi, setPromptIdentity);
  initializeUpdateUi({ documentApi, chromeApi });
}
