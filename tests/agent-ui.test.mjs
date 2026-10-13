import test from "node:test";
import assert from "node:assert/strict";
import { initializeAgentUI } from "../extension/agent-ui.mjs";
import {
  CONNECTION_STORAGE_KEY,
  INSTANCE_STORAGE_KEY,
  LOGIN_REFRESH_TYPE,
  LOGIN_STORAGE_KEY,
} from "../extension/agent-state.mjs";

function element() {
  const listeners = new Map();
  return {
    dataset: {},
    hidden: false,
    textContent: "",
    value: "",
    style: {},
    attributes: {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type, event = {}) { return listeners.get(type)?.(event); },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; delete this.dataset[name.slice(5)]; },
    matches: () => true,
    getBoundingClientRect: () => ({ left: 0, right: 120, top: 20, bottom: 60, width: 280, height: 300 }),
    focus() { this.focused = true; },
    select() { this.selected = true; },
    setSelectionRange() {},
  };
}

function setup({
  stored = { [INSTANCE_STORAGE_KEY]: "123e4567-e89b-42d3-a456-426614174000" },
  writeText = async () => {},
  read = async () => stored,
  extensionId = "abcdefghijklmnopabcdefghijklmnop",
} = {}) {
  const selectors = [
    "#bridge-connection-status", "#login-status", "#yuanbao-login-link", "#extension-version",
    "#agent-instance-id", "#ai-download-prompt-open", "#ai-download-prompt-popover",
    "#ai-download-prompt-text", "#ai-download-prompt-copy", "#ai-prompt-copy-status",
    "#ai-download-prompt-copy-label", "#ai-download-prompt-copy-icon", "#ai-download-prompt-copy-success",
  ];
  const controls = new Map(selectors.map((selector) => [selector, element()]));
  const changes = [];
  const messages = [];
  const timers = new Map();
  let timerId = 0;
  const windowApi = {
    innerWidth: 800,
    innerHeight: 600,
    navigator: { clipboard: { writeText } },
    addEventListener() {},
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const chromeApi = {
    storage: {
      local: { get: read },
      onChanged: { addListener(listener) { changes.push(listener); } },
    },
    runtime: {
      id: extensionId,
      getManifest: () => ({ version: "9.8.7" }),
      sendMessage: (message) => { messages.push(message); return Promise.resolve({ ok: true }); },
    },
  };
  initializeAgentUI({ chromeApi, windowApi, documentApi: { querySelector: (selector) => controls.get(selector) } });
  return { controls, changes, messages, timers, windowApi };
}

test("login and bridge snapshots control status, login entry, and browser diagnostic id", async () => {
  const { controls, changes, messages } = setup({ stored: {
    [LOGIN_STORAGE_KEY]: { login: "failed", checkedAt: 123, error: "LOGIN_CHECK_FAILED" },
    [CONNECTION_STORAGE_KEY]: { version: 1, stage: "host_ready" },
    [INSTANCE_STORAGE_KEY]: "123e4567-e89b-42d3-a456-426614174000",
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [{ type: LOGIN_REFRESH_TYPE }]);
  assert.equal(controls.get("#login-status").textContent, "腾讯元宝登录状态检查失败。");
  assert.equal(controls.get("#yuanbao-login-link").hidden, true);
  assert.equal(controls.get("#bridge-connection-status").textContent, "浏览器已连接本地程序。");
  assert.equal(controls.get("#extension-version").textContent, "9.8.7");
  assert.equal(controls.get("#agent-instance-id").textContent, "123e4567");

  changes.forEach((listener) => listener({ [LOGIN_STORAGE_KEY]: { newValue: { login: "anonymous", checkedAt: 456 } } }, "local"));
  assert.equal(controls.get("#yuanbao-login-link").hidden, false);
  changes.forEach((listener) => listener({ [CONNECTION_STORAGE_KEY]: { newValue: { version: 1, stage: "failed", reason: "host_exited" } } }, "local"));
  assert.equal(controls.get("#bridge-connection-status").textContent, "本地程序已退出，连接未建立或已中断。请让 AI 检查本地桥接。");
  changes.forEach((listener) => listener({ [CONNECTION_STORAGE_KEY]: { newValue: { version: 1, stage: "failed", reason: "protocol_unsupported" } } }, "local"));
  assert.equal(controls.get("#bridge-connection-status").textContent, "扩展与本地程序协议不兼容。请让 AI 更新 Skill。");
});

test("prompt copy reports success briefly, resets on repeated clicks, and selects text on failure", async () => {
  let fail = false;
  const { controls, timers, windowApi } = setup({ writeText: async () => { if (fail) throw new Error("clipboard unavailable"); } });
  const popover = controls.get("#ai-download-prompt-popover");
  const button = controls.get("#ai-download-prompt-copy");
  const openButton = controls.get("#ai-download-prompt-open");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(controls.get("#ai-download-prompt-text").value, /扩展已安装/);
  assert.match(controls.get("#ai-download-prompt-text").value, /当前扩展 ID：abcdefghijklmnopabcdefghijklmnop/);
  assert.match(controls.get("#ai-download-prompt-text").value, /当前扩展实例 UUID：123e4567-e89b-42d3-a456-426614174000/);
  assert.match(controls.get("#ai-download-prompt-text").value, /按 Skill 指引使用上述身份/);
  assert.match(controls.get("#ai-download-prompt-text").value, /安装指引/);
  assert.match(controls.get("#ai-download-prompt-text").value, /真实通信往返成功/);
  assert.doesNotMatch(controls.get("#ai-download-prompt-text").value, /\breference\b|\bprofile\b|配对码|pairing-info|不运行登录检查/);
  assert.match(controls.get("#ai-download-prompt-text").value, /Chrome 用户/);
  popover.dispatch("toggle", { newState: "open" });
  assert.equal(controls.get("#ai-download-prompt-text").focused, true);
  assert.equal(openButton.attributes["aria-expanded"], "true");

  await button.dispatch("click");
  assert.equal(controls.get("#ai-download-prompt-copy-label").textContent, "已复制");
  assert.equal(controls.get("#ai-download-prompt-copy-success").hidden, false);
  assert.equal([...timers.values()][0].delay, 2000);
  await button.dispatch("click");
  assert.equal(timers.size, 1);
  const [{ callback }] = timers.values();
  callback();
  assert.equal(controls.get("#ai-download-prompt-copy-label").textContent, "复制提示词");

  fail = true;
  await button.dispatch("click");
  assert.equal(controls.get("#ai-prompt-copy-status").dataset.error, "true");
  assert.equal(controls.get("#ai-download-prompt-text").selected, true);
  assert.equal(controls.get("#ai-download-prompt-copy-success").hidden, true);
  assert.equal(controls.get("#ai-download-prompt-copy-label").textContent, "复制提示词");
  assert.equal(windowApi.innerWidth, 800);
});

test("prompt identity follows the selected Chrome instance and never copies while identity is unavailable", async () => {
  const written = [];
  const { controls, changes } = setup({
    stored: {},
    writeText: async (value) => written.push(value),
  });
  const prompt = controls.get("#ai-download-prompt-text");
  const button = controls.get("#ai-download-prompt-copy");
  const status = controls.get("#ai-prompt-copy-status");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prompt.value, "");
  assert.equal(button.disabled, true);
  assert.equal(status.textContent, "正在准备安装提示词，请稍候。");
  await button.dispatch("click");
  assert.deepEqual(written, []);

  changes.forEach((listener) => listener({
    [INSTANCE_STORAGE_KEY]: { newValue: "223e4567-e89b-42d3-a456-426614174001" },
  }, "local"));
  assert.equal(button.disabled, false);
  assert.match(prompt.value, /当前扩展 ID：abcdefghijklmnopabcdefghijklmnop/);
  assert.match(prompt.value, /当前扩展实例 UUID：223e4567-e89b-42d3-a456-426614174001/);
  await button.dispatch("click");
  assert.equal(written.length, 1);
  assert.equal(written[0], prompt.value);

  const other = setup({
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    stored: { [INSTANCE_STORAGE_KEY]: "323e4567-e89b-42d3-a456-426614174002" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(other.controls.get("#ai-download-prompt-text").value, /当前扩展实例 UUID：323e4567-e89b-42d3-a456-426614174002/);
  assert.notEqual(other.controls.get("#ai-download-prompt-text").value, prompt.value);

  const reopened = setup({
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    stored: { [INSTANCE_STORAGE_KEY]: "223e4567-e89b-42d3-a456-426614174001" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reopened.controls.get("#ai-download-prompt-text").value, prompt.value);

  const rebuilt = setup({ extensionId: "p".repeat(32) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(rebuilt.controls.get("#ai-download-prompt-text").value, /当前扩展 ID：pppppppppppppppppppppppppppppppp/);
});

test("prompt identity read failure remains disabled and recovers from a storage change", async () => {
  const written = [];
  const { controls, changes } = setup({
    read: async () => { throw new Error("storage unavailable"); },
    writeText: async (value) => written.push(value),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const button = controls.get("#ai-download-prompt-copy");
  assert.equal(button.disabled, true);
  assert.equal(controls.get("#ai-prompt-copy-status").textContent, "暂时无法准备安装提示词，请重新打开插件页。");
  await button.dispatch("click");
  assert.deepEqual(written, []);

  changes.forEach((listener) => listener({
    [INSTANCE_STORAGE_KEY]: { newValue: "not-a-uuid" },
  }, "local"));
  assert.equal(button.disabled, true);
  assert.equal(controls.get("#ai-download-prompt-text").value, "");
  changes.forEach((listener) => listener({
    [INSTANCE_STORAGE_KEY]: { newValue: "423e4567-e89b-42d3-a456-426614174003" },
  }, "local"));
  assert.equal(button.disabled, false);
  assert.match(controls.get("#ai-download-prompt-text").value, /423e4567-e89b-42d3-a456-426614174003/);
});

test("prompt remains unavailable when the browser extension ID is invalid", async () => {
  const written = [];
  const { controls } = setup({
    extensionId: "short",
    writeText: async (value) => written.push(value),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controls.get("#ai-download-prompt-text").value, "");
  assert.equal(controls.get("#ai-download-prompt-copy").disabled, true);
  assert.equal(controls.get("#ai-prompt-copy-status").textContent, "暂时无法准备安装提示词，请重新打开插件页。");
  await controls.get("#ai-download-prompt-copy").dispatch("click");
  assert.deepEqual(written, []);
});

test("a newer storage change wins over a delayed identity read", async () => {
  let resolveRead;
  const { controls, changes } = setup({
    read: (key) => key === INSTANCE_STORAGE_KEY
      ? new Promise((resolve) => { resolveRead = resolve; })
      : Promise.resolve({}),
  });
  await Promise.resolve();
  changes.forEach((listener) => listener({
    [INSTANCE_STORAGE_KEY]: { newValue: "523e4567-e89b-42d3-a456-426614174004" },
  }, "local"));
  resolveRead({ [INSTANCE_STORAGE_KEY]: "623e4567-e89b-42d3-a456-426614174005" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(controls.get("#ai-download-prompt-text").value, /523e4567-e89b-42d3-a456-426614174004/);
  assert.doesNotMatch(controls.get("#ai-download-prompt-text").value, /623e4567-e89b-42d3-a456-426614174005/);
});

test("an identity change invalidates a pending clipboard result", async () => {
  let resolveCopy;
  const { controls, changes } = setup({
    writeText: () => new Promise((resolve) => { resolveCopy = resolve; }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const copy = controls.get("#ai-download-prompt-copy").dispatch("click");
  changes.forEach((listener) => listener({ [INSTANCE_STORAGE_KEY]: {} }, "local"));
  resolveCopy();
  await copy;
  assert.equal(controls.get("#ai-download-prompt-copy").disabled, true);
  assert.equal(controls.get("#ai-download-prompt-text").value, "");
  assert.equal(controls.get("#ai-prompt-copy-status").textContent, "正在准备安装提示词，请稍候。");
  assert.equal(controls.get("#ai-download-prompt-copy-success").hidden, true);
});

test("a late clipboard success cannot override a newer failed attempt", async () => {
  let resolveFirst;
  let rejectSecond;
  let calls = 0;
  const writeText = () => ++calls === 1
    ? new Promise((resolve) => { resolveFirst = resolve; })
    : new Promise((_resolve, reject) => { rejectSecond = reject; });
  const { controls } = setup({ writeText });
  const button = controls.get("#ai-download-prompt-copy");
  await new Promise((resolve) => setImmediate(resolve));
  const first = button.dispatch("click");
  const second = button.dispatch("click");
  rejectSecond(new Error("clipboard unavailable"));
  await second;
  resolveFirst();
  await first;
  assert.equal(controls.get("#ai-prompt-copy-status").dataset.error, "true");
  assert.equal(controls.get("#ai-download-prompt-copy-label").textContent, "复制提示词");
  assert.equal(controls.get("#ai-download-prompt-copy-success").hidden, true);
});
