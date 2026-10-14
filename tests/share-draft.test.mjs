import test from "node:test";
import assert from "node:assert/strict";
import { initializeShareDraft, SHARE_DRAFT_KEY } from "../extension/app.mjs";

const share = "https://weixin.qq.com/sph/draft-test";
function field(value = "") {
  let listener;
  return { value, addEventListener: (_, callback) => { listener = callback; }, edit(value) { this.value = value; listener(); } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("share draft survives page reopen and clearing; media credentials are not stored", async () => {
  const data = {};
  const storage = { get: async () => data, set: async (value) => Object.assign(data, value) };
  const errors = [];
  const first = field();
  await initializeShareDraft(first, storage, (error) => errors.push(error));
  first.edit(share);
  await settle();
  const reopened = field();
  await initializeShareDraft(reopened, storage, (error) => errors.push(error));
  assert.equal(reopened.value, share);
  for (const value of ["", "https://media.example/video.mp4?token=synthetic", `${share}?token=synthetic`]) {
    reopened.edit(value);
    await settle();
    assert.equal(data[SHARE_DRAFT_KEY], "");
  }
  assert.deepEqual(errors, []);
});

test("late storage read does not overwrite typing; clearing is submitted before earlier save completes", async () => {
  let resolveRead;
  let resolveWrite;
  const writes = [];
  const storage = {
    get: () => new Promise((resolve) => { resolveRead = resolve; }),
    set: async (value) => { writes.push(value[SHARE_DRAFT_KEY]); if (writes.length === 1) await new Promise((resolve) => { resolveWrite = resolve; }); },
  };
  const input = field();
  const ready = initializeShareDraft(input, storage, assert.fail);
  input.edit(share);
  input.edit("");
  assert.deepEqual(writes, [share, ""]);
  resolveRead({ [SHARE_DRAFT_KEY]: `${share}-old` });
  await ready;
  assert.equal(input.value, "");
  await settle();
  assert.deepEqual(writes, [share, ""]);
  resolveWrite();
  await settle();
  assert.deepEqual(writes, [share, ""]);
});

test("storage errors are reported and a later edit can still save", async () => {
  const errors = [];
  let attempts = 0;
  const saved = [];
  const storage = {
    get: async () => { throw new Error("read failed"); },
    set: async (value) => { if (++attempts === 1) throw new Error("write failed"); saved.push(value[SHARE_DRAFT_KEY]); },
  };
  const input = field();
  await initializeShareDraft(input, storage, (error) => errors.push(error.message));
  input.edit(share);
  await settle();
  input.edit(`${share}-new`);
  await settle();
  assert.deepEqual(errors, ["read failed", "write failed"]);
  assert.deepEqual(saved, [`${share}-new`]);
});
