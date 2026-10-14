import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const fixture = await readFile(new URL("./capture-fixture.js", import.meta.url), "utf8");

function loadFixture(search = "") {
  const context = {
    location: {
      href: `http://127.0.0.1/index.html${search}`,
      search,
    },
    URL,
    URLSearchParams,
  };
  runInNewContext(fixture, context, { filename: "capture-fixture.js" });
  return context.chrome;
}

const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const instanceId = "e246b5f1-6fbd-4c9c-870d-ae29dd083126";
const defaultChrome = loadFixture();
const parseReply = await defaultChrome.runtime.sendMessage({
  type: "weixin-channels-video:page-parse",
  url: "https://weixin.qq.com/sph/demo-capture-025",
});
assert.equal(parseReply.ok, true);
assert.equal(parseReply.result.title, "示例视频｜海边片段");
assert.equal(parseReply.result.author, "示例作者");
assert.equal(parseReply.result.mediaVariants.length, 2);
assert.equal(parseReply.result.mediaVariants[0].label, "示例版本 A");
assert.equal(parseReply.result.mediaVariants[1].label, "示例版本 B");
assert.equal(defaultChrome.runtime.getManifest().name, "视频号分享链接解析");
assert.equal(defaultChrome.runtime.getManifest().version, "0.2.5");
const agentIdentity = await defaultChrome.storage.local.get("weixin-channels-video:instance-id");
assert.equal(agentIdentity["weixin-channels-video:instance-id"], instanceId);
const noConnectionOrLoginSnapshot = await defaultChrome.storage.local.get([
  "weixin-channels-video:bridge-connection-state",
  "weixin-channels-video:login-state",
]);
assert.deepEqual(Object.keys(noConnectionOrLoginSnapshot), []);

let storageChange;
defaultChrome.storage.onChanged.addListener((changes, areaName) => {
  storageChange = { changes, areaName };
});
await defaultChrome.storage.local.set({ captureSelfcheck: "saved" });
const stored = await defaultChrome.storage.local.get("captureSelfcheck");
assert.equal(stored.captureSelfcheck, "saved");
assert.equal(storageChange.areaName, "local");
assert.equal(storageChange.changes.captureSelfcheck.newValue, "saved");

const defaultRows = await defaultChrome.downloads.search({ orderBy: ["-startTime"] });
assert.equal(defaultRows.length, 1);
assert.equal(defaultRows[0].byExtensionId, extensionId);

const historyChrome = loadFixture("?capture=history");
const history = await historyChrome.downloads.search({ orderBy: ["-startTime"] });
assert.equal(history.length, 7);
assert.equal(history.every((item) => item.byExtensionId === extensionId), true);
assert.equal(Date.parse(history[0].startTime) > Date.parse(history[1].startTime), true);

const limited = await historyChrome.downloads.search({ limit: 2, orderBy: ["-startTime"] });
assert.equal(limited.length, 2);
assert.equal(limited[0].id, history[0].id);
assert.equal(limited[1].id, history[1].id);

const oneDownload = await historyChrome.downloads.search({ id: 8103 });
assert.equal(oneDownload.length, 1);
assert.equal(oneDownload[0].filename, "示例_公园里的橘猫_2026.mp4");

const emptyChrome = loadFixture("?capture=empty");
assert.equal((await emptyChrome.downloads.search()).length, 0);

console.log("capture fixture self-check passed");
