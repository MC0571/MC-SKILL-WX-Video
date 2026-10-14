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
  version = "9.8.7",
  reducedMotion = false,
} = {}) {
  const selectors = [
    "#extension-version",
    "#login-status", "#yuanbao-login-link", "#agent-connection-light", "#agent-connection-tooltip", "#ai-download-prompt-open", "#ai-download-prompt-popover",
    "#ai-download-prompt-text", "#ai-download-prompt-copy", "#ai-prompt-copy-status", "#ai-prompt-copy-alert", "#ai-prompt-copy-alert-heading",
    "#ai-download-prompt-copy-label", "#ai-download-prompt-copy-icon", "#ai-download-prompt-copy-spinner", "#ai-download-prompt-copy-success",
  ];
  const controls = new Map(selectors.map((selector) => [selector, element()]));
  const changes = [];
  const messages = [];
  const timers = new Map();
  let timerId = 0;
  const windowListeners = new Map();
  const windowApi = {
    innerWidth: 800,
    innerHeight: 600,
    navigator: { clipboard: { writeText } },
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: reducedMotion }),
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    dispatch(type, event) { windowListeners.get(type)?.(event); },
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
      getManifest: () => ({ version }),
      sendMessage: (message) => { messages.push(message); return Promise.resolve({ ok: true }); },
    },
  };
  initializeAgentUI({ chromeApi, windowApi, documentApi: { querySelector: (selector) => controls.get(selector) } });
  return { controls, changes, messages, timers, windowApi };
}

function runTimer(timers, delay) {
  const [id, { callback }] = [...timers].find(([, timer]) => timer.delay === delay);
  timers.delete(id);
  callback();
}

test("title version badge reads the installed extension manifest", () => {
  const { controls } = setup({ version: "3.2.1" });
  const badge = controls.get("#extension-version");
  assert.equal(badge.textContent, "v3.2.1");
  assert.equal(badge.attributes["aria-label"], "扩展版本 3.2.1");
  assert.equal(badge.hidden, false);
});

test("login and bridge snapshots control login entry, connection light, and diagnostic tooltip", async () => {
  const { controls, changes, messages } = setup({ stored: {
    [LOGIN_STORAGE_KEY]: { login: "failed", checkedAt: 123, error: "LOGIN_CHECK_FAILED" },
    [CONNECTION_STORAGE_KEY]: { version: 1, stage: "host_ready" },
    [INSTANCE_STORAGE_KEY]: "123e4567-e89b-42d3-a456-426614174000",
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [{ type: LOGIN_REFRESH_TYPE }]);
  assert.equal(controls.get("#login-status").textContent, "腾讯元宝登录状态检查失败。");
  assert.equal(controls.get("#yuanbao-login-link").hidden, true);
  assert.equal(controls.get("#agent-connection-tooltip").textContent, "浏览器已连接本地程序");
  assert.equal(controls.get("#ai-download-prompt-open").attributes.title, undefined);
  assert.equal(controls.get("#agent-connection-light").dataset.state, "connected");
  assert.equal(controls.get("#ai-download-prompt-open").attributes["aria-label"], "Agent 设置，已连接");

  changes.forEach((listener) => listener({ [LOGIN_STORAGE_KEY]: { newValue: { login: "anonymous", checkedAt: 456 } } }, "local"));
  assert.equal(controls.get("#yuanbao-login-link").hidden, false);
  assert.equal(controls.get("#login-status").hidden, false);
  changes.forEach((listener) => listener({ [LOGIN_STORAGE_KEY]: { newValue: { login: "authenticated", checkedAt: 789 } } }, "local"));
  assert.equal(controls.get("#login-status").hidden, true);
  assert.equal(controls.get("#yuanbao-login-link").hidden, true);
  changes.forEach((listener) => listener({ [CONNECTION_STORAGE_KEY]: { newValue: { version: 1, stage: "failed", reason: "host_exited" } } }, "local"));
  assert.equal(controls.get("#agent-connection-tooltip").textContent, "本地程序已退出，连接未建立或已中断，请让 AI 检查本地桥接");
  assert.equal(controls.get("#agent-connection-light").dataset.state, "disconnected");
  assert.equal(controls.get("#ai-download-prompt-open").attributes["aria-label"], "Agent 设置，未连接");
  changes.forEach((listener) => listener({ [CONNECTION_STORAGE_KEY]: { newValue: { version: 1, stage: "failed", reason: "protocol_unsupported" } } }, "local"));
  assert.equal(controls.get("#agent-connection-tooltip").textContent, "扩展与本地程序协议不兼容，请让 AI 更新 Skill");
  changes.forEach((listener) => listener({ [CONNECTION_STORAGE_KEY]: { newValue: { version: 1, stage: "failed" } } }, "local"));
  assert.equal(controls.get("#agent-connection-tooltip").textContent, "复制提示词让你的 Agent 来代劳吧");
});

test("copied prompt reflects each bridge stage and keeps login state independent", async () => {
  const instanceId = "123e4567-e89b-42d3-a456-426614174000";
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const cases = [
    {
      bridge: { version: 1, stage: "host_ready", checkedAt: 100 },
      login: { login: "authenticated", checkedAt: 200 },
      stage: /桥接 stage：ready（host_ready）/,
      action: /真实往返核验[\s\S]*scripts\/run\.mjs connect --instance/,
      loginStatus: /元宝 login：authenticated/,
    },
    {
      bridge: { version: 1, stage: "host_starting", checkedAt: 300 },
      login: { login: "anonymous", checkedAt: 400 },
      stage: /桥接 stage：connecting（host_starting）/,
      action: /总等待上限 90 秒/,
      loginStatus: /元宝 login：anonymous/,
    },
    {
      bridge: { version: 1, stage: "failed", reason: "host_not_found", checkedAt: 500 },
      login: { login: "failed", checkedAt: 600, error: "LOGIN_CHECK_FAILED" },
      stage: /桥接 stage：failed（failed）/,
      action: /类别为 host_not_found[\s\S]*scripts\/run\.mjs diagnose --instance/,
      loginStatus: /元宝 login：check_failed/,
    },
    {
      bridge: undefined,
      login: { login: "not_checked", checkedAt: null },
      stage: /桥接 stage：unknown/,
      action: /连接状态未知[\s\S]*scripts\/run\.mjs connect --instance/,
      loginStatus: /元宝 login：not_checked/,
    },
  ];

  for (const { bridge, login, stage, action, loginStatus } of cases) {
    const stored = {
      [INSTANCE_STORAGE_KEY]: instanceId,
      [LOGIN_STORAGE_KEY]: login,
      ...(bridge ? { [CONNECTION_STORAGE_KEY]: bridge } : {}),
    };
    const { controls } = setup({ stored, extensionId, version: "2.4.6" });
    await new Promise((resolve) => setImmediate(resolve));
    const prompt = controls.get("#ai-download-prompt-text").value;
    assert.match(prompt, /本机扩展版本：2\.4\.6/);
    assert.match(prompt, /Native Messaging host \/ Skill CLI 版本：未知/);
    assert.match(prompt, stage);
    assert.match(prompt, action);
    assert.match(prompt, loginStatus);
    assert.match(prompt, /connect 成功后(?:才)?读取一次 status/);
    assert.match(prompt, /始终使用上述扩展 ID 和实例 UUID/);
    assert.match(prompt, /不自动重发/);
    if (bridge?.checkedAt) assert.match(prompt, new RegExp(`桥接 checkedAt：${bridge.checkedAt}`));
    if (login.checkedAt) assert.match(prompt, new RegExp(`元宝 checkedAt：${login.checkedAt}`));
  }
});

test("connection light distinguishes unknown and starting states and rejects stale initial snapshots", async () => {
  let resolveRead;
  const read = new Promise((resolve) => { resolveRead = resolve; });
  const { controls, changes } = setup({ read: () => read });
  const light = controls.get("#agent-connection-light");
  const button = controls.get("#ai-download-prompt-open");
  assert.equal(light.dataset.state, "unknown");
  assert.equal(button.attributes["aria-label"], "Agent 设置，连接状态尚未确认");
  changes.forEach((listener) => listener({ [CONNECTION_STORAGE_KEY]: { newValue: { version: 1, stage: "host_starting" } } }, "local"));
  assert.equal(light.dataset.state, "connecting");
  assert.equal(button.attributes["aria-label"], "Agent 设置，正在连接");
  resolveRead({ [CONNECTION_STORAGE_KEY]: { version: 1, stage: "host_ready" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(light.dataset.state, "connecting");
  changes.forEach((listener) => listener({ [CONNECTION_STORAGE_KEY]: { newValue: { version: 1, stage: "unknown" } } }, "local"));
  assert.equal(light.dataset.state, "unknown");
  assert.equal(controls.get("#agent-connection-tooltip").textContent, "连接状态尚未确认");
});

test("Agent tooltip stays dismissed after Escape or click until pointer or focus re-enters", () => {
  const { controls, windowApi } = setup();
  const button = controls.get("#ai-download-prompt-open");
  windowApi.dispatch("keydown", { key: "Escape" });
  assert.equal(button.dataset.tooltipDismissed, "true");
  button.dispatch("pointerenter");
  assert.equal(button.dataset.tooltipDismissed, undefined);
  button.dispatch("click");
  assert.equal(button.dataset.tooltipDismissed, "true");
  button.dispatch("focus");
  assert.equal(button.dataset.tooltipDismissed, undefined);
  windowApi.dispatch("keydown", { key: "Enter" });
  assert.equal(button.dataset.tooltipDismissed, undefined);
});

test("prompt copy reports success briefly, resets on repeated clicks, and selects text on failure", async () => {
  let fail = false;
  const { controls, timers, windowApi } = setup({ writeText: async () => { if (fail) throw new Error("clipboard unavailable"); } });
  const popover = controls.get("#ai-download-prompt-popover");
  const button = controls.get("#ai-download-prompt-copy");
  const openButton = controls.get("#ai-download-prompt-open");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(controls.get("#ai-download-prompt-text").value, /身份和扩展状态快照如下/);
  assert.match(controls.get("#ai-download-prompt-text").value, /当前扩展 ID：abcdefghijklmnopabcdefghijklmnop/);
  assert.match(controls.get("#ai-download-prompt-text").value, /当前扩展实例 UUID：123e4567-e89b-42d3-a456-426614174000/);
  assert.match(controls.get("#ai-download-prompt-text").value, /本机扩展版本：9\.8\.7/);
  assert.match(controls.get("#ai-download-prompt-text").value, /Native Messaging host \/ Skill CLI 版本：未知/);
  assert.match(controls.get("#ai-download-prompt-text").value, /桥接 stage：unknown/);
  assert.match(controls.get("#ai-download-prompt-text").value, /元宝 login：not_checked/);
  assert.match(controls.get("#ai-download-prompt-text").value, /安装指引/);
  assert.match(controls.get("#ai-download-prompt-text").value, /真实通信往返为准/);
  assert.doesNotMatch(controls.get("#ai-download-prompt-text").value, /\breference\b|\bprofile\b|配对码|pairing-info|不运行登录检查/);
  assert.match(controls.get("#ai-download-prompt-text").value, /Chrome 用户/);
  popover.dispatch("toggle", { newState: "open" });
  assert.equal(controls.get("#ai-download-prompt-text").focused, true);
  assert.equal(openButton.attributes["aria-expanded"], "true");

  const firstCopy = button.dispatch("click");
  assert.equal(controls.get("#ai-download-prompt-copy-spinner").hidden, false);
  assert.equal(controls.get("#ai-download-prompt-copy-label").textContent, "复制中…");
  assert.equal(button.attributes["aria-busy"], "true");
  await firstCopy;
  assert.equal(button.dataset.copied, undefined);
  runTimer(timers, 250);
  assert.equal(controls.get("#ai-download-prompt-copy-label").textContent, "已复制");
  assert.equal(controls.get("#ai-download-prompt-copy-success").hidden, false);
  assert.equal(controls.get("#ai-download-prompt-copy-spinner").hidden, true);
  assert.equal(controls.get("#ai-prompt-copy-status").textContent, "");
  assert.equal(controls.get("#ai-prompt-copy-alert").hidden, true);
  assert.equal(button.attributes["aria-busy"], undefined);
  assert.equal([...timers.values()][0].delay, 2500);
  await button.dispatch("click");
  assert.equal(timers.size, 1);
  assert.equal(controls.get("#ai-download-prompt-copy-success").hidden, true);
  runTimer(timers, 250);
  assert.equal(button.dataset.copied, "true");
  runTimer(timers, 2500);
  assert.equal(controls.get("#ai-download-prompt-copy-label").textContent, "复制提示词");
  assert.equal(controls.get("#ai-download-prompt-copy-icon").hidden, false);
  assert.equal(timers.size, 0);

  fail = true;
  await button.dispatch("click");
  assert.equal(controls.get("#ai-prompt-copy-status").dataset.error, "true");
  assert.equal(controls.get("#ai-prompt-copy-alert").hidden, false);
  assert.equal(controls.get("#ai-prompt-copy-alert").variant, "danger");
  assert.equal(controls.get("#ai-prompt-copy-alert-heading").textContent, "自动复制失败");
  assert.equal(controls.get("#ai-download-prompt-text").selected, true);
  assert.equal(controls.get("#ai-download-prompt-copy-success").hidden, true);
  assert.equal(controls.get("#ai-download-prompt-copy-spinner").hidden, true);
  assert.equal(controls.get("#ai-download-prompt-copy-label").textContent, "复制提示词");
  assert.equal(timers.size, 0);
  assert.equal(windowApi.innerWidth, 800);

  fail = false;
  await button.dispatch("click");
  assert.equal(controls.get("#ai-prompt-copy-alert").hidden, true);
  runTimer(timers, 250);
  assert.equal(button.dataset.copied, "true");
});

test("copy feedback waits for the clipboard but adds no delay to a slow write or reduced motion", async () => {
  let resolveCopy;
  const { controls, timers, windowApi } = setup({
    writeText: () => new Promise((resolve) => { resolveCopy = resolve; }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const button = controls.get("#ai-download-prompt-copy");
  const copying = button.dispatch("click");
  assert.equal(button.dataset.copied, undefined);
  assert.equal(timers.size, 0);
  windowApi.performance.now = () => 300;
  resolveCopy();
  await copying;
  assert.equal(button.dataset.copied, "true");
  assert.equal([...timers.values()][0].delay, 2500);

  const reduced = setup({ reducedMotion: true });
  await new Promise((resolve) => setImmediate(resolve));
  await reduced.controls.get("#ai-download-prompt-copy").dispatch("click");
  assert.equal(reduced.controls.get("#ai-download-prompt-copy").dataset.copied, "true");
  assert.equal([...reduced.timers.values()][0].delay, 2500);
});

test("identity changes cancel a scheduled copy confirmation", async () => {
  const { controls, changes, timers } = setup();
  await new Promise((resolve) => setImmediate(resolve));
  const button = controls.get("#ai-download-prompt-copy");
  await button.dispatch("click");
  assert.equal(timers.size, 1);
  changes.forEach((listener) => listener({ [INSTANCE_STORAGE_KEY]: {} }, "local"));
  assert.equal(timers.size, 0);
  assert.equal(button.disabled, true);
  assert.equal(button.dataset.copying, undefined);
  assert.equal(controls.get("#ai-download-prompt-copy-spinner").hidden, true);
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

test("a newer bridge snapshot wins over delayed storage reads and is copied", async () => {
  const stale = { version: 1, stage: "host_starting", checkedAt: 10 };
  const current = { version: 1, stage: "host_ready", checkedAt: 20 };
  const pendingReads = [];
  const written = [];
  const { controls, changes } = setup({
    stored: {
      [INSTANCE_STORAGE_KEY]: "123e4567-e89b-42d3-a456-426614174000",
      [CONNECTION_STORAGE_KEY]: stale,
      [LOGIN_STORAGE_KEY]: { login: "anonymous", checkedAt: 11 },
    },
    read: (key) => key === CONNECTION_STORAGE_KEY
      ? new Promise((resolve) => pendingReads.push(resolve))
      : Promise.resolve({
        [INSTANCE_STORAGE_KEY]: "123e4567-e89b-42d3-a456-426614174000",
        [LOGIN_STORAGE_KEY]: { login: "anonymous", checkedAt: 11 },
      }),
    writeText: async (value) => written.push(value),
  });
  await Promise.resolve();
  assert.equal(pendingReads.length, 2);
  changes.forEach((listener) => listener({ [CONNECTION_STORAGE_KEY]: { newValue: current } }, "local"));
  pendingReads.forEach((resolve) => resolve({ [CONNECTION_STORAGE_KEY]: stale }));
  await new Promise((resolve) => setImmediate(resolve));

  const prompt = controls.get("#ai-download-prompt-text");
  assert.match(prompt.value, /桥接 stage：ready（host_ready）/);
  assert.match(prompt.value, /桥接 checkedAt：20/);
  assert.doesNotMatch(prompt.value, /桥接 checkedAt：10/);
  await controls.get("#ai-download-prompt-copy").dispatch("click");
  assert.equal(written[0], prompt.value);
  assert.match(written[0], /桥接 checkedAt：20/);
});

test("status refresh preserves pending copy feedback and updates the next copy", async () => {
  let resolveCopy;
  const written = [];
  const { controls, changes } = setup({
    reducedMotion: true,
    writeText: (text) => {
      written.push(text);
      return written.length === 1 ? new Promise((resolve) => { resolveCopy = resolve; }) : Promise.resolve();
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const button = controls.get("#ai-download-prompt-copy");
  const copy = button.dispatch("click");
  changes.forEach((listener) => listener({
    [CONNECTION_STORAGE_KEY]: { newValue: { version: 1, stage: "host_ready", checkedAt: 20 } },
    [LOGIN_STORAGE_KEY]: { newValue: { login: "authenticated", checkedAt: 30 } },
  }, "local"));
  resolveCopy();
  await copy;
  assert.equal(button.dataset.copied, "true");
  assert.match(written[0], /桥接 stage：unknown/);
  await button.dispatch("click");
  assert.match(written[1], /桥接 stage：ready/);
  assert.match(written[1], /元宝 checkedAt：30/);
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
