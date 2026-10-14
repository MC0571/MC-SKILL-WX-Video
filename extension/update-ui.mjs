import {
  STORE_EXTENSION_URL,
  UPDATE_STATE_CHANGED_TYPE,
  UPDATE_STATE_TYPE,
} from "./update-state.mjs";

export function initializeUpdateUi({ documentApi = globalThis.document, chromeApi = globalThis.chrome } = {}) {
  const version = documentApi?.querySelector("#extension-version");
  if (!version?.parentNode || !chromeApi?.runtime?.sendMessage) return;

  const flag = documentApi.createElement("a");
  flag.className = "product-version product-new";
  flag.textContent = "NEW";
  flag.hidden = true;
  version.parentNode.append(flag);

  async function request() {
    try { return await chromeApi.runtime.sendMessage({ type: UPDATE_STATE_TYPE }); }
    catch { return null; }
  }

  function render(state) {
    if (!state?.ok) return;
    version.hidden = false;
    flag.hidden = true;
    if (state.source === "store" && ["available", "waiting"].includes(state.status)) {
      flag.href = STORE_EXTENSION_URL;
      flag.target = "_blank";
      flag.rel = "noreferrer";
      flag.title = `在 Chrome 商店查看扩展 v${state.availableVersion}`;
    } else if (state.source === "external" && state.releaseStatus === "available" && state.releaseDownloadUrl) {
      flag.href = state.releaseDownloadUrl;
      flag.target = "_self";
      flag.rel = "";
      flag.title = `下载扩展 v${state.releaseVersion} ZIP 安装包并打开扩展管理页`;
    } else {
      return;
    }
    flag.setAttribute("aria-label", `NEW，${flag.title}`);
    version.hidden = true;
    flag.hidden = false;
  }

  chromeApi.runtime.onMessage?.addListener((message) => {
    if (message?.type === UPDATE_STATE_CHANGED_TYPE) void request().then(render);
  });
  flag.addEventListener("click", async () => {
    if (flag.target !== "_self") return;
    try { await chromeApi.tabs.create({ url: "chrome://extensions/" }); }
    catch { console.warn("无法打开扩展管理页，请手动访问 chrome://extensions/。"); }
  });
  void request().then(render);
}
