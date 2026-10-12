import test from "node:test";
import assert from "node:assert/strict";
import { LOGIN_STORAGE_KEY, createLoginStateManager } from "../extension/agent-state.mjs";

function storageChrome(initial, set = async (data, patch) => Object.assign(data, patch)) {
  const data = { [LOGIN_STORAGE_KEY]: initial };
  return {
    data,
    chromeApi: {
      storage: {
        local: {
          async get(key) { return { [key]: data[key] }; },
          async set(patch) { return set(data, patch); },
        },
      },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("fresh status snapshot is returned without a remote login check", async () => {
  const cached = { login: "authenticated", checkedAt: 90_000 };
  const { chromeApi } = storageChrome(cached);
  let checks = 0;
  const manager = createLoginStateManager({
    chromeApi,
    clock: () => 100_000,
    requestFactory: () => ({}),
    checker: async () => { checks += 1; return { status: "anonymous" }; },
  });

  assert.deepEqual(await manager.status({ refreshLogin: false }), cached);
  assert.deepEqual(await manager.status({ refreshLogin: true }), cached);
  assert.equal(checks, 0);
});

test("unknown and stale snapshots share one in-flight refresh", async (t) => {
  for (const [name, cached] of [["unknown", undefined], ["stale", { login: "anonymous", checkedAt: 1 }]]) {
    await t.test(name, async () => {
      const { chromeApi } = storageChrome(cached);
      const check = deferred();
      let checks = 0;
      const manager = createLoginStateManager({
        chromeApi,
        clock: () => 400_000,
        requestFactory: () => ({}),
        checker: () => { checks += 1; return check.promise; },
      });

      const first = manager.status({ refreshLogin: true });
      const second = manager.status({ refreshLogin: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(checks, 1);
      check.resolve({ status: "authenticated" });
      assert.deepEqual(await Promise.all([first, second]), [
        { login: "authenticated", checkedAt: 400_000 },
        { login: "authenticated", checkedAt: 400_000 },
      ]);
    });
  }
});

test("failed checks stay distinct from anonymous login", async () => {
  const failedSetup = storageChrome(undefined);
  const failed = createLoginStateManager({
    chromeApi: failedSetup.chromeApi,
    clock: () => 100_000,
    requestFactory: () => ({}),
    checker: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(await failed.status({ refreshLogin: true }), {
    login: "failed", checkedAt: 100_000, error: "LOGIN_CHECK_FAILED",
  });

  const anonymousSetup = storageChrome(undefined);
  const anonymous = createLoginStateManager({
    chromeApi: anonymousSetup.chromeApi,
    clock: () => 100_000,
    requestFactory: () => ({}),
    checker: async () => ({ status: "anonymous" }),
  });
  assert.deepEqual(await anonymous.status({ refreshLogin: true }), {
    login: "anonymous", checkedAt: 100_000,
  });
});

test("a future checkedAt value is stale and triggers a login check", async () => {
  const { chromeApi } = storageChrome({ login: "authenticated", checkedAt: 101_000 });
  let checks = 0;
  const manager = createLoginStateManager({
    chromeApi,
    clock: () => 100_000,
    requestFactory: () => ({}),
    checker: async () => { checks += 1; return { status: "anonymous" }; },
  });

  assert.deepEqual(await manager.status({ refreshLogin: true }), { login: "anonymous", checkedAt: 100_000 });
  assert.equal(checks, 1);
});

test("a late authenticated result cannot replace a newer AUTH_EXPIRED snapshot", async () => {
  const { chromeApi } = storageChrome({ login: "not_checked", checkedAt: null });
  const check = deferred();
  const manager = createLoginStateManager({
    chromeApi,
    clock: () => 100_000,
    requestFactory: () => ({}),
    checker: () => check.promise,
  });

  const pending = manager.status({ refreshLogin: true });
  await new Promise((resolve) => setImmediate(resolve));
  await manager.markAuthenticationFailure({ code: "AUTH_EXPIRED" });
  check.resolve({ status: "authenticated" });
  assert.deepEqual(await pending, { login: "anonymous", checkedAt: 100_000 });
  assert.deepEqual(await manager.read(), { login: "anonymous", checkedAt: 100_000 });
});

test("a storage write failure is surfaced instead of becoming LOGIN_CHECK_FAILED", async () => {
  const writeError = new Error("storage unavailable");
  const { chromeApi } = storageChrome(
    { login: "not_checked", checkedAt: null },
    async () => { throw writeError; },
  );
  const manager = createLoginStateManager({
    chromeApi,
    clock: () => 100_000,
    requestFactory: () => ({}),
    checker: async () => ({ status: "authenticated" }),
  });

  await assert.rejects(manager.status({ refreshLogin: true }), (error) => error === writeError);
});
