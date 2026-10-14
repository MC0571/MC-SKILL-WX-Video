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
  host_starting: "正在连接本地程序",
  host_ready: "浏览器已连接本地程序",
  failed: "复制提示词让你的 Agent 来代劳吧",
});
const BRIDGE_FAILURES = Object.freeze({
  connect_native_failed: "浏览器连接本地程序失败，请让 AI 检查 Skill 配置",
  host_not_found: "找不到本地程序，请让 AI 检查 Skill 是否安装",
  host_not_registered: "本地程序尚未注册，请让 AI 检查 Skill 配置",
  host_start_failed: "本地程序启动失败，请让 AI 检查运行环境",
  host_access_forbidden: "浏览器未获准访问本地程序，请让 AI 检查扩展配置",
  host_exited: "本地程序已退出，连接未建立或已中断，请让 AI 检查本地桥接",
  host_communication_failed: "浏览器与本地程序通信失败，请让 AI 检查连接",
  host_disconnected: "与本地程序的连接已断开，请让 AI 检查连接",
  invalid_ready_message: "本地程序返回的启动状态无效，请让 AI 检查扩展和 Skill 版本",
  invalid_host_message: "本地程序返回的数据无法识别，请让 AI 检查扩展和 Skill 版本",
  protocol_unsupported: "扩展与本地程序协议不兼容，请让 AI 更新 Skill",
});

function buildPrompt({ extensionId, instanceId, extensionVersion, bridgeState, loginState }) {
  const bridge = validBridgeState(bridgeState) ? bridgeState : undefined;
  const login = validLoginState(loginState) ? loginState : undefined;
  const stage = ({ host_ready: "ready", host_starting: "connecting", failed: "failed" })[bridge?.stage] ?? "unknown";
  const reason = bridge?.stage === "failed" ? bridge.reason ?? "unknown" : "none";
  const bridgeCheckedAt = Number.isFinite(bridge?.checkedAt)
    ? `${bridge.checkedAt}（Unix epoch 毫秒）`
    : bridge ? "未知（旧快照缺少时间）" : "未知（没有有效快照）";
  const loginStatus = login?.login === "failed" ? "check_failed" : login?.login ?? "not_checked";
  const loginCheckedAt = Number.isFinite(login?.checkedAt)
    ? `${login.checkedAt}（Unix epoch 毫秒）`
    : "未知（尚未检查或快照没有时间）";
  const connectCommand = `node <skill-root>/scripts/run.mjs connect --instance ${instanceId} --extension-id ${extensionId}`;
  const diagnoseCommand = `node <skill-root>/scripts/run.mjs diagnose --instance ${instanceId} --extension-id ${extensionId}`;
  const nextStep = {
    ready: `快照显示连接已就绪，但可能已过期。用以下命令对同一实例做真实往返核验；connect 成功后才读取一次 status 确认元宝登录状态。若失败，按 Skill 的一次诊断、证据支持的必要修复和同身份核验流程处理：\n${connectCommand}\n成功后：node <skill-root>/scripts/run.mjs status\n失败后诊断：${diagnoseCommand}`,
    connecting: `快照显示连接中。只对同一实例执行一次有界 connect（总等待上限 90 秒）；connect 成功后读取一次 status 确认元宝登录状态。超时后停止等待，按同一身份诊断和 Skill 的一次修复流程处理，不循环重试：\n${connectCommand}\n成功后：node <skill-root>/scripts/run.mjs status\n超时后诊断：${diagnoseCommand}`,
    failed: `快照显示连接失败，类别为 ${reason}。先对同一实例诊断一次，按 Skill 中该类别和诊断证据完成最多一次必要修复，再用原身份核验一次；connect 成功后读取一次 status 确认元宝登录状态。无证据或仍失败时停止并说明具体人工动作：\n${diagnoseCommand}\n${connectCommand}\n成功后：node <skill-root>/scripts/run.mjs status`,
    unknown: `连接状态未知，先对同一实例做真实往返核验；connect 成功后读取一次 status 确认元宝登录状态。若失败，按 Skill 的一次诊断、证据支持的必要修复和同身份核验流程处理，不扫描或选择其他 Chrome 用户：\n${connectCommand}\n成功后：node <skill-root>/scripts/run.mjs status\n失败后诊断：${diagnoseCommand}`,
  }[stage];
  return [
    "此提示词来自用户当前选定的 Chrome 用户，身份和扩展状态快照如下：",
    `当前扩展 ID：${extensionId}`,
    `当前扩展实例 UUID：${instanceId}`,
    `本机扩展版本：${typeof extensionVersion === "string" && extensionVersion ? extensionVersion : "未知"}`,
    "本机 Native Messaging host / Skill CLI 版本：未知（扩展快照未提供）",
    `桥接 stage：${stage}${bridge ? `（${bridge.stage}）` : ""}`,
    `桥接 reason：${reason}`,
    `桥接 checkedAt：${bridgeCheckedAt}`,
    `元宝 login：${loginStatus}`,
    `元宝 checkedAt：${loginCheckedAt}`,
    "请先阅读并遵守安装指引：https://github.com/MC0571/weixin-channels-video/blob/main/skills/weixin-channels-video/references/agent-installation.md",
    "按宿主官方入口安装或复用完整 Skill；修复依据只采用 Skill 指引和本次诊断证据。上述快照可能已过期，连接是否就绪以 Agent 与这个扩展实例的真实通信往返为准。",
    nextStep,
    "桥接连接与腾讯元宝登录完全分开判断：check_failed 表示登录检查失败，不等于未登录或桥接失败；anonymous 才表示明确未登录。",
    "复制这份提示词表示用户选择了这个 Chrome 用户。始终使用上述扩展 ID 和实例 UUID，不自动切换或扫描其他 Chrome 用户。下载任务提交后若超时或断连，不自动重发。若需要用户完成权限或其他人工操作，只交接那一步并停止。",
    "完成后用普通语言简短报告真实连接往返、登录状态和下一步。",
  ].join("\n");
}

function validBridgeState(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    value.version === 1 && BRIDGE_STAGES.has(value.stage) &&
    Object.keys(value).every((key) => ["version", "stage", "reason", "checkedAt"].includes(key)) &&
    (!Object.hasOwn(value, "checkedAt") || value.checkedAt === null || Number.isFinite(value.checkedAt)) &&
    (!Object.hasOwn(value, "reason") || BRIDGE_REASONS.has(value.reason)));
}

function validLoginState(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    ["authenticated", "anonymous", "failed", "not_checked"].includes(value.login) &&
    (value.checkedAt === undefined || value.checkedAt === null || Number.isFinite(value.checkedAt)) &&
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

function initializeAgentIdentity(chromeApi, setPromptState, extensionVersion) {
  const extensionId = chromeApi?.runtime?.id;
  const validExtensionId = typeof extensionId === "string" && EXTENSION_ID_PATTERN.test(extensionId);
  const storage = chromeApi?.storage?.local;
  const changes = chromeApi?.storage?.onChanged;
  const state = { instanceId: undefined, bridgeState: undefined, loginState: undefined };
  const versions = new Map([
    [INSTANCE_STORAGE_KEY, 0],
    [CONNECTION_STORAGE_KEY, 0],
    [LOGIN_STORAGE_KEY, 0],
  ]);
  let identityReadFailed = false;
  const render = () => {
    const validInstanceId = typeof state.instanceId === "string" && INSTANCE_ID_PATTERN.test(state.instanceId);
    if (validExtensionId && validInstanceId) {
      setPromptState?.({
        extensionId,
        instanceId: state.instanceId,
        extensionVersion,
        bridgeState: state.bridgeState,
        loginState: state.loginState,
      });
    } else {
      setPromptState?.(undefined, !validExtensionId
        ? IDENTITY_READ_FAILED
        : identityReadFailed ? IDENTITY_READ_FAILED
        : state.instanceId === undefined ? IDENTITY_WAITING : IDENTITY_READ_FAILED);
    }
  };
  if (!validExtensionId) {
    render();
    return;
  }
  if (typeof storage?.get !== "function" || typeof changes?.addListener !== "function") {
    identityReadFailed = true;
    render();
    return;
  }
  changes.addListener((items, area) => {
    if (area !== "local") return;
    let changed = false;
    for (const [key, property] of [
      [INSTANCE_STORAGE_KEY, "instanceId"],
      [CONNECTION_STORAGE_KEY, "bridgeState"],
      [LOGIN_STORAGE_KEY, "loginState"],
    ]) {
      if (!Object.hasOwn(items ?? {}, key)) continue;
      versions.set(key, versions.get(key) + 1);
      state[property] = items[key].newValue;
      if (key === INSTANCE_STORAGE_KEY) identityReadFailed = false;
      changed = true;
    }
    if (changed) render();
  });
  for (const [key, property] of [
    [INSTANCE_STORAGE_KEY, "instanceId"],
    [CONNECTION_STORAGE_KEY, "bridgeState"],
    [LOGIN_STORAGE_KEY, "loginState"],
  ]) {
    const initialVersion = versions.get(key);
    Promise.resolve().then(() => storage.get(key)).then((stored) => {
      if (initialVersion !== versions.get(key)) return;
      state[property] = stored?.[key];
      if (key === INSTANCE_STORAGE_KEY) identityReadFailed = false;
      render();
    }).catch(() => {
      if (initialVersion !== versions.get(key)) return;
      if (key === INSTANCE_STORAGE_KEY) identityReadFailed = true;
      render();
    });
  }
}

function initializePrompt(windowApi, documentApi) {
  const openButton = documentApi.querySelector("#ai-download-prompt-open");
  const popover = documentApi.querySelector("#ai-download-prompt-popover");
  const promptText = documentApi.querySelector("#ai-download-prompt-text");
  const copyButton = documentApi.querySelector("#ai-download-prompt-copy");
  const copyStatus = documentApi.querySelector("#ai-prompt-copy-status");
  const copyAlert = documentApi.querySelector("#ai-prompt-copy-alert");
  const copyAlertHeading = documentApi.querySelector("#ai-prompt-copy-alert-heading");
  const copyLabel = documentApi.querySelector("#ai-download-prompt-copy-label");
  const copyIcon = documentApi.querySelector("#ai-download-prompt-copy-icon");
  const spinner = documentApi.querySelector("#ai-download-prompt-copy-spinner");
  const successIcon = documentApi.querySelector("#ai-download-prompt-copy-success");
  if (!openButton || !popover || !promptText || !copyButton || !copyStatus || !copyAlert || !copyAlertHeading || !copyLabel || !copyIcon || !spinner || !successIcon) return;
  const setCopyStatus = (message, error = false, heading = "提示词暂不可用") => {
    copyStatus.textContent = message;
    copyStatus.dataset.error = String(error);
    copyAlertHeading.textContent = heading;
    copyAlertHeading.hidden = !error;
    copyAlert.variant = error ? "danger" : "neutral";
    copyAlert.hidden = !message;
  };
  let identityReady = false;
  let promptSnapshot;
  copyButton.disabled = true;
  promptText.value = "";
  setCopyStatus(IDENTITY_WAITING);
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
    windowApi.clearTimeout(copiedTimer);
    delete copyButton.dataset.copying;
    delete copyButton.dataset.copied;
    copyButton.removeAttribute("aria-busy");
    copyLabel.textContent = "复制提示词";
    copyIcon.hidden = false;
    spinner.hidden = true;
    successIcon.hidden = true;
  };
  const setPromptSnapshot = (snapshot, errorMessage) => {
    const identityChanged = !snapshot || snapshot.extensionId !== promptSnapshot?.extensionId ||
      snapshot.instanceId !== promptSnapshot?.instanceId;
    promptSnapshot = snapshot;
    identityReady = Boolean(snapshot);
    copyButton.disabled = !identityReady;
    promptText.value = snapshot ? buildPrompt(snapshot) : "";
    if (identityChanged) {
      copyAttempt += 1;
      resetCopied();
      setCopyStatus(snapshot ? "" : errorMessage, !snapshot && errorMessage !== IDENTITY_WAITING);
    }
  };
  const showCopied = () => {
    windowApi.clearTimeout(copiedTimer);
    delete copyButton.dataset.copying;
    copyButton.removeAttribute("aria-busy");
    copyButton.dataset.copied = "true";
    copyLabel.textContent = "已复制";
    copyIcon.hidden = true;
    spinner.hidden = true;
    successIcon.hidden = false;
    copiedTimer = windowApi.setTimeout(resetCopied, 2500);
  };

  popover.addEventListener("beforetoggle", (event) => {
    if (event.newState !== "open") return;
    if (identityReady) {
      setCopyStatus("");
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
    resetCopied();
    setCopyStatus("");
    copyButton.dataset.copying = "true";
    copyButton.setAttribute("aria-busy", "true");
    copyIcon.hidden = true;
    spinner.hidden = false;
    copyLabel.textContent = "复制中…";
    const startedAt = windowApi.performance.now();
    const textToCopy = buildPrompt(promptSnapshot);
    promptText.value = textToCopy;
    try {
      await windowApi.navigator.clipboard.writeText(textToCopy);
      if (attempt !== copyAttempt) return;
      const delay = windowApi.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 0 : Math.max(0, 250 - (windowApi.performance.now() - startedAt));
      if (delay > 0) copiedTimer = windowApi.setTimeout(showCopied, delay);
      else showCopied();
    } catch {
      if (attempt !== copyAttempt) return;
      resetCopied();
      promptText.focus();
      promptText.select();
      setCopyStatus("全文已选中，请按 ⌘C（Mac）或 Ctrl+C（Windows/Linux）手动复制。", true, "自动复制失败");
      updatePosition();
    }
  });
  return setPromptSnapshot;
}

export function initializeAgentUI({
  chromeApi = globalThis.chrome,
  windowApi = globalThis,
  documentApi = globalThis.document,
} = {}) {
  if (!documentApi?.querySelector) return;
  const versionBadge = documentApi.querySelector("#extension-version");
  const extensionVersion = chromeApi?.runtime?.getManifest?.()?.version;
  if (versionBadge) {
    if (typeof extensionVersion === "string" && extensionVersion) {
      versionBadge.textContent = `v${extensionVersion}`;
      versionBadge.setAttribute("aria-label", `扩展版本 ${extensionVersion}`);
      versionBadge.hidden = false;
    }
  }
  initializeBridgeStatus(chromeApi, windowApi, documentApi);
  initializeLoginStatus(chromeApi, windowApi, documentApi);
  const setPromptState = initializePrompt(windowApi, documentApi);
  initializeAgentIdentity(chromeApi, setPromptState, extensionVersion);
  initializeUpdateUi({ documentApi, chromeApi });
}
