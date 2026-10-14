import {
  STORE_EXTENSION_URL,
  UPDATE_STATE_CHANGED_TYPE,
  UPDATE_STATE_TYPE,
} from "./update-state.mjs";

export function initializeUpdateUi({ documentApi = globalThis.document, chromeApi = globalThis.chrome } = {}) {
  const version = documentApi?.querySelector("#extension-version");
  if (!version?.parentNode || !chromeApi?.runtime?.sendMessage) return;

  const flag = documentApi.createElement("a");
  flag.className = "product-new";
  const image = documentApi.createElement("img");
  image.src = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAYAAAA6/NlyAAAACXBIWXMAAAsTAAALEwEAmpwYAAAFAUlEQVR4nO2bTYgcRRTHOxpQEwVNQi56UPCLTaLJwUNO6wfKQoZ0/19ZMeCYPah48SAaDBElxhxkVwWTg+hls+rBdQUP0agHwYORjaDJhoBCsn6cFjUmB1F2Xo1a8nq6Oz2d3vnoHqd3ZufBg2xV9ev6zavqevWq4jgDGchABtKi2OHhlUz0ChNdYOA8A+NW68udfhUmeskQ2bgycMDpR1nQ+mYmqqQAc4XodqdXhJW6g4k+NUQ/GaJpdt1NyTa2XF7NwPEkbAz6uLS5xLbrbjJEH4htJvokzXZXxZZK65jo90Tn/zbAZFWp+1ipDUz0kAFOLQYb01lpW9F6qArca4DDvq24baJzVus1hQGzUqMtgHRUGdhVGLAheqbbwIbo6eKAgT0FAD9bGDATHer6kCY6VAis1foqA/xQgIfn7OjolUXAvlsAbE2Bd/43aCtLj3yNZb4Ce/xhXIxnk9Bnmehg1C9gV+4li2tBRd06u5SVgd8Y2JgdmPwIqnCQNqGPZgY2tXDR9pQCP+YBni4coH2dzgxc0XqIiao9NJz/YaW2ZAYWkSC+h4bzpJNXqrJzKRqkRZW+5gZmpTYUDdKqyhTMDwzsjBk9LWXWcVYYog+TL2SiN8PnwrJGtu327dcEnrk/zIokbH4Ts/dtHVyQJakq9UD0fmBnLlhbLq9ObN5PR3Xbtl1ngJ87AczAmP+346yQ4CEGMB62lX/H3nNB2gblY7E+zKZlTlqSiufdmpKWiYBFjOdtZcC0AmyInvRD0rheXOcvehI4EpuTI2F5wpOfLeZ5Jvq6ovVt7aVSgQOSXEuZJ3XAyT1xQ2DghUbLifW8tcFze4MyY7W+OupXqbQqTAIy8GJQtk6eTbHHwmCHh1c2BWbg1QYfhgiYXXez/9J9+y6TX7wF4N1+PjquwJ/RnAQe9D1JdE/Q6WPBc3eFaysDX8Q9z4Bu9BHjYKo0Az7fEjDwuWwufGhgPRPNtzuHWalycnSIVyV5JznsaGQAzwU2n2eif+X7EdS91RCY6FwngY8Zou/Cj4SfpQTeWAxY9q/S0bga4InINnA29uzJqlJ3B+/5iom+9Ms9b6sBvo+1m+sE8HgbwNLRw2FZheiWLHM41AXXvTGw/ZodGblCfpTA21X/R6od1RyUNgta39TMHgMvNwWWsx4G9qedEqQCi2Glykk7WYCZ6FFp+5fW1/vvUGpH7B07/DrgBr/O8x5vYKciDLadcyt/WSKaaQmY6A9p3wiYgcdk+UnoyYT99xI2JmJ1E3V1wNQisDPJvrQXeNR3KhU4GNonZBhmCTxinf01DCj8IIRoPlY3H9XVVoYoQKnrQ6m0yul0aJkKnEihZgEO5t2dvn3X3XxJXbg8KbUl1bvBsM8lFa2Hms29paJtRVh9sT0MlrJcYoDJokHa0LoPW7Y0beLIcimrv2bnOUM2vZjEA6aWV5qWaC4zMANHe9DDR/IAb0xd4JeoSuCSO69ltV4jB1V1h2lNdild8uSZusM0okfCbWP/HZcSvV3MGTEV4GngTNdhC73yALzuLKtLLcDu5XVtCXiqMGCWr3f3h/TDhQFbz1ubXKeD2HtC0q3+cWstTTPbgudOSNq1ydXDX6zrXusUKSzBCdHHwWnCVKbLpUQzaZkK2bwY4H2xzUQfdeSwbElcH+7Exr2HLojvd/pVbO3cakyuQkmSXPLGff1fAAYykIE4nZb/AJDOLTi65W3+AAAAAElFTkSuQmCC";
  image.alt = "";
  image.width = 24;
  image.height = 24;
  flag.append(image);
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
