import {
  UPDATE_ACTION_TYPE,
  UPDATE_STATE_CHANGED_TYPE,
  UPDATE_STATE_TYPE,
} from "./update-state.mjs";

export function initializeUpdateUi({ documentApi = globalThis.document, chromeApi = globalThis.chrome } = {}) {
  const shell = documentApi?.querySelector(".shell");
  const inputCard = documentApi?.querySelector(".input-card");
  if (!shell || !inputCard || !chromeApi?.runtime?.sendMessage) return;

  const card = documentApi.createElement("section");
  card.className = "card update-card";
  card.hidden = true;
  card.setAttribute("aria-live", "polite");
  const message = documentApi.createElement("p");
  message.className = "status update-message";
  const link = documentApi.createElement("a");
  link.target = "_blank";
  link.rel = "noreferrer";
  const actions = documentApi.createElement("div");
  actions.className = "form-row update-actions";
  const applyButton = documentApi.createElement("button");
  applyButton.type = "button";
  applyButton.className = "primary-button";
  applyButton.textContent = "立即更新";
  const laterButton = documentApi.createElement("button");
  laterButton.type = "button";
  laterButton.className = "secondary-button";
  laterButton.textContent = "稍后";
  actions.append(applyButton, laterButton);
  const dismissButton = documentApi.createElement("button");
  dismissButton.type = "button";
  dismissButton.className = "secondary-button update-dismiss";
  dismissButton.textContent = "关闭提示";
  dismissButton.setAttribute("aria-label", "关闭扩展更新提示");
  dismissButton.hidden = true;
  card.append(message, link, actions, dismissButton);
  const header = documentApi.querySelector(".page-header");
  const anchor = header?.parentNode === shell ? header : inputCard;
  const container = anchor.parentNode;
  if (!container) return;
  container.insertBefore(card, anchor === header ? anchor.nextSibling : anchor);
  const dismissedNotices = new Set();
  let renderedNoticeKey = null;

  async function request(messageValue) {
    try { return await chromeApi.runtime.sendMessage(messageValue); }
    catch { return null; }
  }

  function showDismissibleNotice(key) {
    renderedNoticeKey = key;
    if (dismissedNotices.has(key)) return false;
    dismissButton.hidden = false;
    card.hidden = false;
    return true;
  }

  function render(state) {
    if (!state?.ok) return;
    card.hidden = true;
    link.hidden = true;
    actions.hidden = true;
    dismissButton.hidden = true;
    if (state.updated?.version) {
      if (!showDismissibleNotice(`updated:${state.updated.version}`)) return;
      message.textContent = `扩展已更新到 v${state.updated.version}。`;
      if (state.updated.changelogUrl) {
        link.href = state.updated.changelogUrl;
        link.textContent = "查看更新说明";
        link.hidden = false;
      }
      void request({ type: UPDATE_ACTION_TYPE, action: "acknowledge-updated" });
      return;
    }
    if (state.source === "store" && ["available", "waiting"].includes(state.status)) {
      message.textContent = state.status === "waiting"
        ? `v${state.availableVersion} 已准备就绪；当前任务和下载完成后会安全应用。`
        : `已下载扩展更新 v${state.availableVersion}。`;
      if (state.changelogUrl) {
        link.href = state.changelogUrl;
        link.textContent = "查看更新说明";
        link.hidden = false;
      }
      actions.hidden = false;
      card.hidden = false;
      return;
    }
    if (state.source === "unknown" || (state.source === "external" && state.releaseStatus === "unknown")) {
      message.textContent = state.source === "unknown"
        ? "暂时无法确认扩展安装来源，无法检查更新。"
        : "暂时无法检查扩展更新，请稍后再试。";
      showDismissibleNotice(`unknown:${state.source}`);
      return;
    }
    if (state.source === "external" && state.releaseUrl) {
      if (state.releaseStatus !== "available" || !state.releaseVersion ||
          !showDismissibleNotice(`release:${state.releaseVersion}`)) return;
      message.textContent = `扩展有新版 v${state.releaseVersion}。请按原安装方式更新。`;
      link.href = state.releaseChangelogUrl ?? state.releaseUrl;
      link.textContent = "查看新版";
      link.hidden = false;
    }
  }

  chromeApi.runtime.onMessage?.addListener((message) => {
    if (message?.type === UPDATE_STATE_CHANGED_TYPE) void request({ type: UPDATE_STATE_TYPE }).then(render);
  });
  void request({ type: UPDATE_STATE_TYPE }).then(render);
  applyButton.addEventListener("click", async () => {
    const response = await request({ type: UPDATE_ACTION_TYPE, action: "apply" });
    render(response);
  });
  laterButton.addEventListener("click", async () => {
    await request({ type: UPDATE_ACTION_TYPE, action: "later" });
    card.hidden = true;
  });
  dismissButton.addEventListener("click", () => {
    dismissedNotices.add(renderedNoticeKey);
    card.hidden = true;
  });
}
