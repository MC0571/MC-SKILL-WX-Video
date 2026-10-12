import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { connect, createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";
import { createAgentCommandHandler } from "../extension/agent.mjs";
import { BRIDGE_ERROR_MESSAGES, BridgeFrameDecoder, encodeBridgeFrame, isAbsoluteDownloadPath, isSafeRelativeMp4Filename, NATIVE_HOST_NAME, validateBridgeCommand, validateBridgeResponse } from "../src/native-messaging.mjs";
import { createIpcNonce, createIpcProof, createWindowsPipeServer, isIpcSession, verifyIpcProof, windowsPipeName } from "../src/native-ipc.mjs";
import { startNativeHost } from "../src/native-host.mjs";
import { BridgeSetupError, bridgeSocketPath, installBridge, inspectBridgeComponents, readBridgeConnections, readBridgeInstallation, readBridgeSelection, readBridgeSession } from "../skills/weixin-channels-video/scripts/bridge-install.mjs";
import { BridgeError, discoverBridgeConnections, requestBridge, selectBridgeConnection, waitForBridge } from "../skills/weixin-channels-video/scripts/bridge-client.mjs";
import { runCli } from "../skills/weixin-channels-video/scripts/cli.mjs";
import { secureWindowsPath } from "../skills/weixin-channels-video/scripts/windows-security.mjs";

const EXTENSION_ID = "a".repeat(32);
const SESSION_1 = "123e4567-e89b-42d3-a456-426614174000";
const SESSION_2 = "223e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000";
const IPC_SECRET = "a".repeat(64);
const SESSION_INFO = { sessionId: SESSION_1, ipcProtocol: 2, ipcSecret: IPC_SECRET };

async function withTempDir(callback) {
  const root = await mkdtemp(join(tmpdir(), "weixin-native-bridge-test-"));
  try { await callback(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function withShortTempDir(callback) {
  const root = await mkdtemp("/tmp/wcv-");
  try { await callback(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function chromeProfileFixture(root, profiles = [["Profile 3", "Research"]]) {
  const chromeRoot = join(root, "Chrome User Data");
  const infoCache = {};
  for (const [directory, name] of profiles) {
    await mkdir(join(chromeRoot, directory), { recursive: true });
    infoCache[directory] = { name };
  }
  await writeFile(join(chromeRoot, "Local State"), JSON.stringify({ profile: { info_cache: infoCache } }));
  return chromeRoot;
}

function collectFrames(stream) {
  const decoder = new BridgeFrameDecoder();
  const messages = [];
  const waiters = [];
  stream.on("data", (chunk) => {
    let frames;
    try { frames = decoder.push(chunk); }
    catch (error) {
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      return;
    }
    for (const frame of frames) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else messages.push(frame);
    }
  });
  return {
    next() {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

function createAuthenticatedFakeServer({ sessionInfo = SESSION_INFO, hostSecret = sessionInfo.ipcSecret, hostNonce = "b".repeat(64), onClientProof = () => {}, onTask = () => {} } = {}) {
  return createServer((socket) => {
    const decoder = new BridgeFrameDecoder();
    let phase = "hello";
    let clientNonce;
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (phase === "hello") {
          phase = "proof";
          clientNonce = message.nonce;
          socket.write(Buffer.from(encodeBridgeFrame({
            type: "challenge", version: 2, nonce: hostNonce,
          })));
        } else if (phase === "proof") {
          phase = "task";
          onClientProof(message, clientNonce, hostNonce);
          socket.write(Buffer.from(encodeBridgeFrame({
            type: "proof",
            version: 2,
            role: "host",
            proof: createIpcProof(hostSecret, "host", clientNonce, hostNonce),
          })));
        } else {
          onTask(message.request, socket);
        }
      }
    });
  });
}

async function createHostFixture(root, sessionId = SESSION_1, startHost = startNativeHost) {
  const appSupportDir = join(root, "app");
  await mkdir(appSupportDir, { mode: 0o700 });
  await chmod(appSupportDir, 0o700);
  const configPath = join(appSupportDir, "bridge.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    hostName: NATIVE_HOST_NAME,
    platform: process.platform,
    ipcProtocol: 2,
    extensionId: EXTENSION_ID,
    appSupportDir,
  }), { mode: 0o600, flag: "wx" });
  await writeFile(join(appSupportDir, "session.json"), JSON.stringify({ version: 1, sessionId, ipcProtocol: 2, ipcSecret: IPC_SECRET }), { mode: 0o600, flag: "wx" });
  if (process.platform === "win32") {
    await secureWindowsPath(appSupportDir, { directory: true, newlyCreated: true });
    await secureWindowsPath(configPath, { newlyCreated: true });
    await secureWindowsPath(join(appSupportDir, "session.json"), { newlyCreated: true });
  }
  const input = new PassThrough();
  const output = new PassThrough();
  const outputFrames = collectFrames(output);
  const host = await startHost({
    configPath,
    extensionOrigin: `chrome-extension://${EXTENSION_ID}/`,
    input,
    output,
  });
  return { appSupportDir, configPath, config: { platform: process.platform, appSupportDir }, host, input, output, outputFrames, sessionInfo: { sessionId, ipcProtocol: 2, ipcSecret: IPC_SECRET } };
}

test("Native Messaging frames handle partial input and reject malformed or oversized frames", () => {
  const first = encodeBridgeFrame({ command: "status" });
  const second = encodeBridgeFrame({ command: "parse", url: "https://weixin.qq.com/sph/demo" });
  const decoder = new BridgeFrameDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(first.subarray(2)), [{ command: "status" }]);
  assert.deepEqual(decoder.push(Buffer.concat([Buffer.from(first), Buffer.from(second)])), [
    { command: "status" },
    { command: "parse", url: "https://weixin.qq.com/sph/demo" },
  ]);
  decoder.finish();

  const oversized = new Uint8Array(4);
  new DataView(oversized.buffer).setUint32(0, 5, true);
  assert.throws(() => new BridgeFrameDecoder(4).push(oversized), /size is invalid/);
  const truncated = new BridgeFrameDecoder();
  truncated.push(first.subarray(0, 3));
  assert.throws(() => truncated.finish(), /closed mid-message/);
  assert.throws(() => new BridgeFrameDecoder().push(Buffer.from([1, 0, 0, 0, 0xff])), /encoded data/);
});

test("IPC2 sessions use private keys, fresh nonces, and endpoint-specific pipe names", () => {
  const clientNonce = createIpcNonce();
  const hostNonce = createIpcNonce();
  const proof = createIpcProof(IPC_SECRET, "client", clientNonce, hostNonce);
  assert.equal(isIpcSession(SESSION_INFO), true);
  assert.equal(isIpcSession({ ...SESSION_INFO, extra: true }), false);
  assert.equal(verifyIpcProof(proof, proof), true);
  assert.equal(verifyIpcProof(proof, "0".repeat(64)), false);
  assert.notEqual(windowsPipeName("C:\\Users\\Example\\AppData", SESSION_1), windowsPipeName("C:\\Users\\Example\\AppData", SESSION_2));
  assert.notEqual(windowsPipeName("C:\\Users\\Example\\AppData", SESSION_1), windowsPipeName("C:\\Users\\Other\\AppData", SESSION_1));
});

test("extension status reports its installed manifest version", async () => {
  const instanceId = "423e4567-e89b-42d3-a456-426614174000";
  const handler = createAgentCommandHandler({
    chromeApi: { runtime: { getManifest: () => ({ version: "0.2.2" }) } },
    statusProvider: async ({ refreshLogin }) => {
      assert.equal(refreshLogin, true);
      return { login: "authenticated", checkedAt: 1234 };
    },
    instanceIdProvider: async () => instanceId,
  });
  assert.deepEqual(await handler({ id: REQUEST_ID, command: "status", refreshLogin: true }), {
    id: REQUEST_ID,
    ok: true,
    result: { instanceId, nativeProtocol: 2, login: "authenticated", checkedAt: 1234, versions: { extension: "0.2.2" } },
  });
});

test("Skill CLI and host versions stay independent from the extension manifest over wire v2 and IPC2", {
  timeout: 10_000,
}, async () => {
  const cliSource = fileURLToPath(new URL("../skills/weixin-channels-video/scripts/cli.mjs", import.meta.url));
  const hostSource = fileURLToPath(new URL("../src/native-host.mjs", import.meta.url));

  for (const [skillVersion, extensionVersion] of [["0.2.3", "0.2.2"], ["0.2.2", "0.2.3"]]) {
    await withShortTempDir(async (root) => {
      const cliPath = join(root, `cli-${skillVersion}.mjs`);
      const hostPath = join(root, `host-${skillVersion}.mjs`);
      const define = { __WCV_VERSION__: JSON.stringify(skillVersion) };
      await build({ entryPoints: [cliSource], outfile: cliPath, bundle: true, platform: "node", format: "esm", target: "node22", define });
      await build({ entryPoints: [hostSource], outfile: hostPath, bundle: true, platform: "node", format: "esm", target: "node22", define });
      const [{ runCli: runSkillCli }, { startNativeHost: startSkillHost }] = await Promise.all([
        import(pathToFileURL(cliPath).href),
        import(pathToFileURL(hostPath).href),
      ]);
      const fixture = await createHostFixture(root, SESSION_1, startSkillHost);
      try {
        const instanceId = "423e4567-e89b-42d3-a456-426614174000";
        fixture.input.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 2, instanceId })));
        assert.deepEqual(await fixture.outputFrames.next(), { type: "ready", version: 2, instanceId });

        const extensionHandler = createAgentCommandHandler({
          chromeApi: { runtime: { getManifest: () => ({ version: extensionVersion }) } },
          statusProvider: async ({ refreshLogin }) => {
            assert.equal(refreshLogin, true);
            return { login: "authenticated", checkedAt: 55 };
          },
          instanceIdProvider: async () => instanceId,
        });
        const output = [];
        const errors = [];
        const statusPromise = runSkillCli(["status"], {
          readInstallation: async () => fixture.config,
          readSession: async () => fixture.sessionInfo,
          readConnections: readBridgeConnections,
          readSelection: async () => instanceId,
          stdout: (value) => output.push(value),
          stderr: (value) => errors.push(value),
        });
        const request = await fixture.outputFrames.next();
        assert.equal(request.command, "status");
        fixture.input.write(Buffer.from(encodeBridgeFrame(await extensionHandler(request))));

        assert.equal(await statusPromise, 0, errors.join("\n"));
        const status = JSON.parse(output[0]);
        assert.equal(status.connection, "connected");
        assert.equal(status.login, "authenticated");
        assert.deepEqual(status.versions, { cli: skillVersion, host: skillVersion, extension: extensionVersion });
      } finally {
        await fixture.host.close();
      }
    });
  }
});

test("Windows pipe transport close waits for PowerShell exit and settles startup", async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
    }
    kill() {
      this.killed = true;
      setTimeout(() => {
        this.exitCode = 1;
        this.emit("exit", 1, null);
        this.emit("close", 1, null);
      }, 20);
      return true;
    }
  }
  let child;
  let unexpectedFatal = false;
  const transport = createWindowsPipeServer(`weixin-channels-video-${"a".repeat(32)}`, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnImpl: () => (child = new FakeChild()),
    onFatal: () => { unexpectedFatal = true; },
  });
  const ready = assert.rejects(transport.ready, /WINDOWS_PIPE_START_FAILED/);
  let closed = false;
  const closing = transport.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(child.killed, true);
  assert.equal(closed, false);
  await Promise.all([ready, closing]);
  assert.equal(closed, true);
  assert.equal(unexpectedFatal, false);
});

test("Windows pipe transport reports an unexpected PowerShell exit after READY", async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
    }
    kill() { this.killed = true; return true; }
  }
  let child;
  let fatalCount = 0;
  const transport = createWindowsPipeServer(`weixin-channels-video-${"b".repeat(32)}`, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnImpl: () => (child = new FakeChild()),
    onFatal: () => { fatalCount += 1; },
  });
  child.stderr.write("READY\r\n");
  await transport.ready;
  child.exitCode = 1;
  child.emit("exit", 1, null);
  child.emit("close", 1, null);
  assert.equal(fatalCount, 1);
  await transport.close();
});

test("bridge commands and download paths are narrow and exact", () => {
  assert.equal(isAbsoluteDownloadPath("/Users/example/clip.mp4"), true);
  assert.equal(isAbsoluteDownloadPath("C:\\Users\\example\\clip.mp4"), true);
  assert.equal(isAbsoluteDownloadPath("C:/Users/example/clip.mp4"), true);
  assert.equal(isAbsoluteDownloadPath("\\\\server\\share\\clip.mp4"), true);
  assert.equal(isAbsoluteDownloadPath("//server/share/clip.mp4"), true);
  assert.equal(isAbsoluteDownloadPath("C:clip.mp4"), false);
  assert.equal(isAbsoluteDownloadPath("\\clip.mp4"), false);
  assert.equal(isAbsoluteDownloadPath("\\\\server"), false);
  assert.equal(isAbsoluteDownloadPath("\\\\server\\"), false);
  assert.equal(isAbsoluteDownloadPath("\\\\?\\C:\\clip.mp4"), false);
  assert.equal(isAbsoluteDownloadPath("clips/clip.mp4"), false);
  assert.equal(validateBridgeCommand({ id: REQUEST_ID, command: "status" }), true);
  assert.equal(validateBridgeCommand({ id: REQUEST_ID, command: "parse", url: "https://weixin.qq.com/sph/demo" }), true);
  assert.equal(validateBridgeCommand({ id: REQUEST_ID, command: "download", url: "https://weixin.qq.com/sph/demo", filename: "Clips/demo.mp4" }), true);
  assert.equal(validateBridgeCommand({ id: REQUEST_ID, command: "download", url: "https://weixin.qq.com/sph/demo", output: "/tmp/demo.mp4" }), false);
  assert.equal(validateBridgeCommand({ id: REQUEST_ID, command: "fetch", url: "https://attacker.invalid" }), false);
  for (const filename of ["../demo.mp4", "/tmp/demo.mp4", "a/../../demo.mp4", "a\\demo.mp4", "a.txt", "a/./demo.mp4"]) {
    assert.equal(isSafeRelativeMp4Filename(filename), false, filename);
  }
  assert.equal(isSafeRelativeMp4Filename("Clips/clip.mp4"), true);
  assert.equal(validateBridgeResponse({ id: REQUEST_ID, ok: true, result: {} }, REQUEST_ID), true);
  assert.equal(validateBridgeResponse({ id: REQUEST_ID, ok: true, result: {}, error: "ignored" }, REQUEST_ID), false);
});

test("CLI and Native Messaging host entry guards follow symlinked paths with spaces and hashes", async () => {
  await withShortTempDir(async (root) => {
    const linksDir = join(root, "linked scripts # fixture");
    await mkdir(linksDir);
    const cliLink = join(linksDir, "cli entry #.mjs");
    const hostLink = join(linksDir, "native host #.mjs");
    await symlink(new URL("../skills/weixin-channels-video/scripts/cli.mjs", import.meta.url), cliLink);
    await symlink(new URL("../src/native-host.mjs", import.meta.url), hostLink);

    const cli = spawnSync(process.execPath, [cliLink, "--help"], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^Usage: cli\.mjs/);

    const host = spawnSync(process.execPath, [hostLink], { encoding: "utf8" });
    assert.equal(host.status, 1);
    assert.equal(host.stderr, "Native messaging host failed.\n");
  });
});

test("installer uses profile metadata only and writes private, exact user-level registration", async () => {
  await withShortTempDir(async (root) => {
    const chromeRoot = await chromeProfileFixture(root);
    const appSupportDir = join(root, "private", "bridge");
    const registryDir = join(chromeRoot, "NativeMessagingHosts");
    const nativeHostSource = join(root, "native-host-bundle.mjs");
    await writeFile(nativeHostSource, "// synthetic host bundle\n");

    const installed = await installBridge({
      extensionId: EXTENSION_ID,
      profile: "Research",
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir,
      nodeExecutable: "/Applications/Node Runtime/bin/node",
      nativeHostSource,
      platform: "darwin",
    });
    const manifest = JSON.parse(await readFile(installed.hostManifestPath, "utf8"));
    assert.deepEqual(manifest, {
      name: NATIVE_HOST_NAME,
      description: "Local bridge for the Weixin Channels Video Chrome extension.",
      path: installed.launcherPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    });
    assert.equal(installed.profile.directory, "Profile 3");
    assert.equal((await readBridgeInstallation({ appSupportDir })).profileDirectory, "Profile 3");
    const sessionId = await readBridgeSession(installed.config);
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.equal((await stat(appSupportDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(appSupportDir, "bridge.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(installed.hostManifestPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(appSupportDir, "session.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(installed.launcherPath)).mode & 0o777, 0o700);
    const launcher = await readFile(installed.launcherPath, "utf8");
    assert.match(launcher, /'\/Applications\/Node Runtime\/bin\/node'/);
    assert.match(launcher, /"\$@"/);
    assert.equal((await readFile(join(chromeRoot, "Local State"), "utf8")).includes("Cookies"), false);

    assert.deepEqual(await inspectBridgeComponents(installed.config, { registryDir }), {
      registration: "valid",
      host: "present",
      launcher: "valid",
      node: "missing",
      nodeVersion: null,
      session: "available",
      security: "unknown",
    });

    const sessionPath = join(appSupportDir, "session.json");
    await writeFile(sessionPath, JSON.stringify({ version: 1, sessionId, unexpected: true }));
    assert.equal((await inspectBridgeComponents(installed.config, { registryDir })).session, "invalid");
    assert.equal(await readBridgeSession(installed.config), null);
    await writeFile(sessionPath, JSON.stringify({ version: 1, sessionId }));

    const updated = await installBridge({
      extensionId: EXTENSION_ID,
      profile: "Profile 3",
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir,
      nodeExecutable: "/Applications/Node Runtime/bin/node",
      nativeHostSource,
      platform: "darwin",
    });
    assert.equal(updated.profile.directory, "Profile 3");
    assert.notEqual(await readBridgeSession(updated.config), sessionId);
    const reconfigured = await installBridge({
      extensionId: "b".repeat(32),
      profile: "Profile 3",
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir,
      nodeExecutable: "/Applications/Node Runtime/bin/node",
      nativeHostSource,
      platform: "darwin",
    });
    assert.notEqual(await readBridgeSession(reconfigured.config), sessionId);
  });
});

test("installer supports manual pairing without profile metadata and preserves its session on upgrade", async () => {
  await withShortTempDir(async (root) => {
    const chromeRoot = join(root, "Chrome User Data");
    const appSupportDir = join(root, "private", "bridge");
    const nativeHostSource = join(root, "native-host-bundle.mjs");
    await mkdir(chromeRoot, { recursive: true });
    await writeFile(nativeHostSource, "// synthetic host bundle\n");
    const options = {
      extensionId: EXTENSION_ID,
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir: join(chromeRoot, "NativeMessagingHosts"),
      nodeExecutable: "/Applications/Node Runtime/bin/node",
      nativeHostSource,
      platform: "darwin",
    };
    const installed = await installBridge(options);
    assert.equal(installed.profile, null);
    assert.equal(Object.hasOwn(installed.config, "profileDirectory"), false);
    const sessionId = await readBridgeSession(installed.config);
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.equal((await readBridgeInstallation({ appSupportDir })).profileDirectory, undefined);
    assert.equal(await readBridgeSession((await installBridge(options)).config), sessionId);
  });
});

test("omitting profile on a same-install upgrade preserves profile and IPC secret; explicit profile change rotates them", async () => {
  await withShortTempDir(async (root) => {
    const chromeRoot = await chromeProfileFixture(root, [["Profile 3", "Research"], ["Default", "Personal"]]);
    const appSupportDir = join(root, "private", "bridge");
    const nativeHostSource = join(root, "native-host-bundle.mjs");
    await writeFile(nativeHostSource, "// synthetic host bundle\n");
    const options = {
      extensionId: EXTENSION_ID,
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir: join(chromeRoot, "NativeMessagingHosts"),
      nodeExecutable: "/Applications/Node Runtime/bin/node",
      nativeHostSource,
      platform: "darwin",
    };

    const installed = await installBridge({ ...options, profile: "Research" });
    const sessionPath = join(appSupportDir, "session.json");
    const originalSession = JSON.parse(await readFile(sessionPath, "utf8"));
    assert.equal(installed.config.profileDirectory, "Profile 3");
    assert.equal(installed.config.profileName, "Research");

    await rm(join(chromeRoot, "Local State"));
    const upgraded = await installBridge(options);
    const upgradedSession = JSON.parse(await readFile(sessionPath, "utf8"));
    assert.equal(upgraded.config.profileDirectory, "Profile 3");
    assert.equal(upgraded.config.profileName, "Research");
    assert.deepEqual(upgradedSession, originalSession);

    await writeFile(join(chromeRoot, "Local State"), JSON.stringify({
      profile: { info_cache: { "Profile 3": { name: "Research" }, Default: { name: "Personal" } } },
    }));
    const switched = await installBridge({ ...options, profile: "Personal" });
    const switchedSession = JSON.parse(await readFile(sessionPath, "utf8"));
    assert.equal(switched.config.profileDirectory, "Default");
    assert.notEqual(switchedSession.sessionId, originalSession.sessionId);
    assert.notEqual(switchedSession.ipcSecret, originalSession.ipcSecret);
  });
});

test("installer reports Chrome registration access failures as a distinct setup stage", async () => {
  await withShortTempDir(async (root) => {
    const chromeRoot = join(root, "Chrome User Data");
    const appSupportDir = join(root, "private", "bridge");
    const nativeHostSource = join(root, "native-host-bundle.mjs");
    const registryDir = join(chromeRoot, "NativeMessagingHosts");
    await mkdir(chromeRoot, { recursive: true });
    await writeFile(registryDir, "unavailable");
    await writeFile(nativeHostSource, "// synthetic host bundle\n");
    await assert.rejects(installBridge({
      extensionId: EXTENSION_ID,
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir,
      nativeHostSource,
      platform: "darwin",
    }), (error) => error instanceof BridgeSetupError && error.code === "HOST_REGISTRATION_UNAVAILABLE");
  });
});

test("installer refuses an unrelated Native Messaging host registration", async () => {
  await withShortTempDir(async (root) => {
    const chromeRoot = await chromeProfileFixture(root);
    const registryDir = join(chromeRoot, "NativeMessagingHosts");
    const appSupportDir = join(root, "bridge");
    await mkdir(registryDir, { recursive: true });
    await writeFile(join(registryDir, `${NATIVE_HOST_NAME}.json`), JSON.stringify({
      name: NATIVE_HOST_NAME,
      path: "/Applications/Unrelated.app/Contents/MacOS/host",
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    }));
    const nativeHostSource = join(root, "host.mjs");
    await writeFile(nativeHostSource, "// host\n");
    await assert.rejects(installBridge({
      extensionId: EXTENSION_ID,
      profile: "Research",
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir,
      nativeHostSource,
      platform: "darwin",
    }), /Native Messaging 注册/);
    await assert.rejects(stat(appSupportDir), { code: "ENOENT" });
  });
});

test("installer does not replace orphaned host or launcher files without app ownership", async () => {
  await withShortTempDir(async (root) => {
    const chromeRoot = await chromeProfileFixture(root);
    const appSupportDir = join(root, "bridge");
    const registryDir = join(chromeRoot, "NativeMessagingHosts");
    const nativeHostSource = join(root, "host.mjs");
    await mkdir(appSupportDir, { recursive: true });
    await writeFile(join(appSupportDir, "native-host.mjs"), "unrelated host contents");
    await writeFile(nativeHostSource, "// packaged host\n");
    await assert.rejects(installBridge({
      extensionId: EXTENSION_ID,
      profile: "Research",
      appSupportDir,
      chromeUserDataDir: chromeRoot,
      registryDir,
      nativeHostSource,
      platform: "darwin",
    }), /本地桥接文件/);
    assert.equal(await readFile(join(appSupportDir, "native-host.mjs"), "utf8"), "unrelated host contents");
  });
});

test("installer rejects unsupported platforms before touching bridge paths", async () => {
  await withShortTempDir(async (root) => {
    const appSupportDir = join(root, "bridge");
    await assert.rejects(installBridge({
      extensionId: EXTENSION_ID,
      profile: "Research",
      appSupportDir,
      chromeUserDataDir: join(root, "Chrome User Data"),
      registryDir: join(root, "NativeMessagingHosts"),
      platform: "linux",
    }), (error) => error instanceof BridgeSetupError &&
      error.code === "UNSUPPORTED_PLATFORM" &&
      error.message === "本地桥接安装仅支持 macOS 和 Windows。");
    await assert.rejects(stat(appSupportDir), { code: "ENOENT" });
  });
});

test("Native Messaging host binds the socket to one extension origin and one session", async () => {
  await withShortTempDir(async (root) => {
    const fixture = await createHostFixture(root);
    await assert.rejects(startNativeHost({
      configPath: fixture.configPath,
      extensionOrigin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
      input: new PassThrough(),
      output: new PassThrough(),
    }), /BRIDGE_NOT_CONFIGURED/);

    fixture.input.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 1, sessionId: SESSION_2 })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(stat(fixture.host.socketPath), { code: "ENOENT" });
    assert.equal(fixture.input.destroyed, true);
  });
});

test("Native Messaging host authenticates the local client, forwards one command, and cleans up", async () => {
  await withShortTempDir(async (root) => {
    const fixture = await createHostFixture(root);
    fixture.input.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 1, sessionId: SESSION_1 })));
    assert.deepEqual(await fixture.outputFrames.next(), { type: "ready", version: 1 });
    const legacyRecords = await readBridgeConnections(fixture.config, fixture.sessionInfo);
    assert.equal(legacyRecords[0].nativeProtocol, 1);

    const command = { id: REQUEST_ID, command: "parse", url: "https://weixin.qq.com/sph/synthetic" };
    const responsePromise = requestBridge(fixture.config, fixture.sessionInfo, command);
    assert.deepEqual(await fixture.outputFrames.next(), command);
    const response = { id: REQUEST_ID, ok: true, result: { title: "synthetic" } };
    fixture.input.write(Buffer.from(encodeBridgeFrame(response)));
    assert.deepEqual(await responsePromise, response.result);
    await fixture.host.close();
    await assert.rejects(stat(fixture.host.socketPath), { code: "ENOENT" });
  });
});

test("connection discovery skips stale sockets, rejects malformed status, and identifies legacy protocol immediately", async () => {
  const instanceId = "423e4567-e89b-42d3-a456-426614174000";
  const records = [{ instanceId, nativeProtocol: 2 }];
  const skipped = await discoverBridgeConnections({}, SESSION_INFO, {
    readConnections: async () => records,
    request: async () => { throw new BridgeError("BRIDGE_DISCONNECTED", "stale"); },
    waitForLegacyBridge: async () => { throw new BridgeError("BRIDGE_TIMEOUT", "stale legacy"); },
  });
  assert.deepEqual(skipped, []);

  await assert.rejects(discoverBridgeConnections({}, SESSION_INFO, {
    readConnections: async () => records,
    request: async () => ({ instanceId, nativeProtocol: 2, login: "bad", checkedAt: null, versions: {} }),
  }), { code: "BRIDGE_PROTOCOL_ERROR" });
  await assert.rejects(discoverBridgeConnections({}, SESSION_INFO, {
    readConnections: async () => [{ instanceId, nativeProtocol: 1 }],
    request: async () => { throw new Error("legacy health check must not be requested"); },
    waitForLegacyBridge: async () => {},
  }), { code: "BRIDGE_PROTOCOL_UNSUPPORTED" });
  await assert.rejects(discoverBridgeConnections({}, SESSION_INFO, {
    readConnections: async () => records,
    request: async () => { throw new BridgeError("BRIDGE_SESSION_MISMATCH", "wrong session"); },
  }), { code: "BRIDGE_SESSION_MISMATCH" });

  let legacyProbeCount = 0;
  const liveV2 = await discoverBridgeConnections({}, SESSION_INFO, {
    readConnections: async () => [{ instanceId, nativeProtocol: 1 }, ...records],
    request: async () => ({ instanceId, nativeProtocol: 2, login: "authenticated", checkedAt: 50, versions: {} }),
    waitForLegacyBridge: async () => { legacyProbeCount += 1; },
  });
  assert.equal(liveV2.length, 1);
  assert.equal(legacyProbeCount, 0, "a stale legacy hint cannot block a live v2 instance");
});

test("connection discovery detects a live legacy host without discovery records using IPC authentication only", async () => {
  await withShortTempDir(async (root) => {
    const config = { appSupportDir: root };
    const sessionInfo = { ...SESSION_INFO, sessionId: SESSION_1 };
    let clientProofs = 0;
    let taskFrames = 0;
    const server = createAuthenticatedFakeServer({
      sessionInfo,
      onClientProof(message, clientNonce, hostNonce) {
        clientProofs += 1;
        assert.equal(message.type, "proof");
        assert.equal(message.role, "client");
        assert.equal(message.proof, createIpcProof(IPC_SECRET, "client", clientNonce, hostNonce));
      },
      onTask() { taskFrames += 1; },
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(bridgeSocketPath(config, SESSION_1), resolve);
    });
    try {
      assert.deepEqual(await readBridgeConnections(config, sessionInfo), []);
      await assert.rejects(discoverBridgeConnections(config, sessionInfo), { code: "BRIDGE_PROTOCOL_UNSUPPORTED" });
      assert.equal(clientProofs, 1, "the live endpoint completed an authenticated IPC handshake");
      assert.equal(taskFrames, 0, "discovery does not send status or task requests to a legacy host");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("connection discovery ignores an absent legacy endpoint, and selected offline profiles never probe it", async () => {
  await withTempDir(async (root) => {
    const config = { appSupportDir: root };
    const sessionInfo = { ...SESSION_INFO, sessionId: SESSION_1 };
    const noLegacy = await discoverBridgeConnections(config, sessionInfo, {
      waitForLegacyBridge: (cfg, session, options) => waitForBridge(cfg, session, { ...options, timeoutMs: 0 }),
    });
    assert.deepEqual(noLegacy, []);

    let legacyProbeCount = 0;
    const selected = await selectBridgeConnection(config, sessionInfo, {
      instanceId: "423e4567-e89b-42d3-a456-426614174000",
      readConnections: async () => [{ instanceId: "423e4567-e89b-42d3-a456-426614174000", nativeProtocol: 2 }],
      request: async () => { throw new BridgeError("BRIDGE_DISCONNECTED", "offline"); },
      waitForLegacyBridge: async () => { legacyProbeCount += 1; },
    });
    assert.equal(selected.connection, null);
    assert.equal(selected.selectedInstanceId, "423e4567-e89b-42d3-a456-426614174000");
    assert.equal(legacyProbeCount, 0, "an explicit selection remains isolated from global legacy discovery");
  });
});

test("connection and selection readers reject unsafe filesystem object types", async () => {
  await withShortTempDir(async (root) => {
    const external = join(root, "external");
    const appSupportDir = join(root, "support");
    await mkdir(external, { recursive: true });
    await mkdir(appSupportDir, { recursive: true });
    await symlink(external, join(appSupportDir, "connections"));
    const config = { appSupportDir };
    await assert.rejects(readBridgeConnections(config, SESSION_INFO), { code: "BRIDGE_CONFIG_INVALID" });

    await rm(join(appSupportDir, "connections"), { force: true });
    const selected = join(external, "selection.json");
    await writeFile(selected, JSON.stringify({ version: 1, sessionId: SESSION_1, instanceId: "423e4567-e89b-42d3-a456-426614174000" }));
    await symlink(selected, join(appSupportDir, "selection.json"));
    await assert.rejects(readBridgeSelection(config, SESSION_INFO), { code: "BRIDGE_CONFIG_INVALID" });
  });
});

test("CLI resolves ambiguity before login refresh and refreshes only the selected instance", async () => {
  const first = "423e4567-e89b-42d3-a456-426614174000";
  const second = "523e4567-e89b-42d3-a456-426614174000";
  const records = [{ instanceId: first, nativeProtocol: 2 }, { instanceId: second, nativeProtocol: 2 }];
  const errors = [];
  const outputs = [];
  const ambiguousCalls = [];
  const common = {
    readInstallation: async () => ({ appSupportDir: "/tmp/bridge" }),
    readSession: async () => SESSION_INFO,
    readConnections: async () => records,
    readSelection: async () => null,
    bridgeRequest: async (_config, _session, request, options) => {
      ambiguousCalls.push({ request, options });
      return { instanceId: options.instanceId, nativeProtocol: 2, login: "authenticated", checkedAt: 1, versions: {} };
    },
  };
  assert.equal(await runCli(["status"], { ...common, stdout: (value) => outputs.push(value), stderr: (value) => errors.push(value) }), 1);
  assert.equal(ambiguousCalls.length, 2);
  assert.equal(ambiguousCalls.some(({ request }) => request.refreshLogin), false);
  assert.deepEqual(JSON.parse(outputs[0]), {
    configuration: "configured",
    connection: "failed:BRIDGE_PROFILE_AMBIGUOUS",
    login: "not_checked",
    error: "BRIDGE_PROFILE_AMBIGUOUS",
    message: BRIDGE_ERROR_MESSAGES.BRIDGE_PROFILE_AMBIGUOUS,
    nextAction: "connect --instance <UUID>",
    versions: { cli: "unknown", host: "unknown", extension: "unknown" },
  });

  const refreshCalls = [];
  const selected = await runCli(["parse", "--url", "https://weixin.qq.com/sph/synthetic"], {
    ...common,
    readSelection: async () => second,
    bridgeRequest: async (_config, _session, request, options) => {
      refreshCalls.push({ request, options });
      if (request.command === "status") return { instanceId: second, nativeProtocol: 2, login: "authenticated", checkedAt: 1, versions: {} };
      return { title: "synthetic" };
    },
    stdout() {},
    stderr: (value) => errors.push(value),
  });
  assert.equal(selected, 0);
  assert.equal(refreshCalls.length, 2);
  assert.deepEqual(refreshCalls.map(({ options }) => options.instanceId), [second, second]);
  assert.equal(refreshCalls[0].request.refreshLogin, true);
});

test("CLI requires a confirmed authenticated login before dispatching parse or download", async () => {
  const instanceId = "423e4567-e89b-42d3-a456-426614174000";
  for (const command of ["parse", "download"]) {
    for (const login of ["anonymous", "failed", "not_checked"]) {
      const calls = [];
      const errors = [];
      const exitCode = await runCli([command, "--url", "https://weixin.qq.com/sph/synthetic"], {
        stderr: (value) => errors.push(value),
        readInstallation: async () => ({ appSupportDir: "/tmp/bridge" }),
        readSession: async () => SESSION_INFO,
        readSelection: async () => instanceId,
        readConnections: async () => [{ instanceId, nativeProtocol: 2 }],
        bridgeRequest: async (_config, _session, request, options) => {
          calls.push({ request, options });
          return request.command === "status"
            ? { instanceId, nativeProtocol: 2, login, checkedAt: 100, versions: {} }
            : { title: "must-not-dispatch" };
        },
      });
      assert.equal(exitCode, 1);
      assert.deepEqual(calls.map(({ request }) => request.command), ["status"]);
      assert.equal(calls[0].request.refreshLogin, true);
      assert.match(errors[0], login === "anonymous" ? /AUTH_EXPIRED/ : /LOGIN_CHECK_FAILED/);
    }
    let dispatched;
    assert.equal(await runCli([command, "--url", "https://weixin.qq.com/sph/synthetic"], {
      readInstallation: async () => ({ appSupportDir: "/tmp/bridge" }),
      readSession: async () => SESSION_INFO,
      readSelection: async () => instanceId,
      readConnections: async () => [{ instanceId, nativeProtocol: 2 }],
      bridgeRequest: async (_config, _session, request) => {
        if (request.command === "status") return { instanceId, nativeProtocol: 2, login: "authenticated", checkedAt: 100, versions: {} };
        dispatched = request.command;
        return { title: "synthetic", state: "complete" };
      },
      stdout() {},
    }), 0);
    assert.equal(dispatched, command);
  }
});

test("wire v2 binds an authenticated status to a private per-instance discovery record", async () => {
  await withShortTempDir(async (root) => {
    const fixture = await createHostFixture(root);
    const instanceId = "423e4567-e89b-42d3-a456-426614174000";
    fixture.input.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 2, instanceId })));
    assert.deepEqual(await fixture.outputFrames.next(), { type: "ready", version: 2, instanceId });
    const recordPath = join(fixture.appSupportDir, "connections", `${instanceId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.deepEqual(Object.keys(record).sort(), ["generation", "instanceId", "nativeProtocol", "sessionId", "version"]);
    assert.equal(record.sessionId, SESSION_1);
    assert.equal(record.nativeProtocol, 2);
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);

    const request = { id: REQUEST_ID, command: "status" };
    const resultPromise = requestBridge(fixture.config, fixture.sessionInfo, request, { instanceId });
    assert.deepEqual(await fixture.outputFrames.next(), request);
    fixture.input.write(Buffer.from(encodeBridgeFrame({ id: REQUEST_ID, ok: true, result: {
      instanceId, nativeProtocol: 2, login: "anonymous", checkedAt: null, versions: { extension: "0.2.3" },
    } })));
    const result = await resultPromise;
    assert.equal(result.instanceId, instanceId);
    assert.equal(result.nativeProtocol, 2);
    assert.equal(result.versions.host, "unknown");
    await fixture.host.close();
    await assert.rejects(readFile(recordPath), { code: "ENOENT" });
  });
});

test("status adds the host version while accepting an older extension status result", async () => {
  await withShortTempDir(async (root) => {
    const fixture = await createHostFixture(root);
    try {
      fixture.input.write(Buffer.from(encodeBridgeFrame({ type: "hello", version: 1, sessionId: SESSION_1 })));
      assert.deepEqual(await fixture.outputFrames.next(), { type: "ready", version: 1 });
      const command = { id: REQUEST_ID, command: "status" };
      const responsePromise = requestBridge(fixture.config, fixture.sessionInfo, command);
      assert.deepEqual(await fixture.outputFrames.next(), command);
      fixture.input.write(Buffer.from(encodeBridgeFrame({ id: REQUEST_ID, ok: true, result: { login: "authenticated" } })));
      assert.deepEqual(await responsePromise, { login: "authenticated", versions: { host: "unknown" } });

      const nextId = "423e4567-e89b-42d3-a456-426614174000";
      const versionedCommand = { id: nextId, command: "status" };
      const versionedResponse = requestBridge(fixture.config, fixture.sessionInfo, versionedCommand);
      assert.deepEqual(await fixture.outputFrames.next(), versionedCommand);
      fixture.input.write(Buffer.from(encodeBridgeFrame({ id: nextId, ok: true, result: { login: "authenticated", versions: { extension: "0.2.2" } } })));
      assert.deepEqual(await versionedResponse, { login: "authenticated", versions: { extension: "0.2.2", host: "unknown" } });
    } finally {
      await fixture.host.close();
    }
  });
});

test("CLI discovers authenticated instances and persists only an explicit selection", async () => {
  const config = { extensionId: EXTENSION_ID, profileDirectory: "Profile 3", chromeUserDataDir: "/tmp/chrome", appSupportDir: "/tmp/bridge" };
  const instanceId = "423e4567-e89b-42d3-a456-426614174000";
  const record = { version: 1, sessionId: SESSION_1, instanceId, generation: REQUEST_ID, nativeProtocol: 2 };
  const outputs = [];
  const errors = [];
  let selected;
  const status = { instanceId, nativeProtocol: 2, login: "failed", checkedAt: 1234, error: "LOGIN_CHECK_FAILED", versions: { extension: "0.2.3", host: "0.2.3" } };
  const common = {
    readInstallation: async () => config,
    readSession: async () => SESSION_INFO,
    readConnections: async () => [record],
    readSelection: async () => null,
    inspectRunning: () => { throw new Error("must not launch when a candidate is active"); },
    bridgeRequest: async (_config, _session, request, options) => {
      assert.equal(options.instanceId, instanceId);
      assert.equal(request.command, "status");
      return status;
    },
  };
  assert.equal(await runCli(["status"], { ...common, stdout: (value) => outputs.push(value) }), 0);
  assert.deepEqual(JSON.parse(outputs.pop()), {
    configuration: "configured", connection: "connected", login: "failed", instanceId, checkedAt: 1234,
    error: "LOGIN_CHECK_FAILED", versions: { cli: "unknown", host: "0.2.3", extension: "0.2.3" },
  });
  assert.equal(await runCli(["connections"], { ...common, stdout: (value) => outputs.push(value) }), 0);
  assert.deepEqual(JSON.parse(outputs.pop()), [{ instanceId, login: "failed", checkedAt: 1234, error: "LOGIN_CHECK_FAILED", versions: status.versions }]);
  assert.equal(await runCli(["connect", "--instance", instanceId], {
    ...common,
    stdout: (value) => outputs.push(value),
    writeSelection: async (_config, _session, value) => { selected = value; },
  }), 0);
  assert.equal(selected, instanceId);
  assert.equal(outputs.pop(), "Connected to the Chrome extension.");
  assert.equal(errors.length, 0);
});

test("CLI parse uses one authenticated instance and never logs the share URL", async () => {
  const outputs = [];
  const errors = [];
  const shareUrl = "https://weixin.qq.com/sph/synthetic";
  const instanceId = "423e4567-e89b-42d3-a456-426614174000";
  let sent;
  const result = { title: "synthetic", previewUrl: "https://media.example/video.mp4", downloadUrl: "https://media.example/video.mp4" };
  assert.equal(await runCli(["parse", "--url", shareUrl], {
    stdout: (value) => outputs.push(value), stderr: (value) => errors.push(value),
    readInstallation: async () => ({ appSupportDir: "/tmp/bridge" }),
    readSession: async () => SESSION_INFO,
    readConnections: async () => [{ instanceId, nativeProtocol: 2 }],
    readSelection: async () => null,
    inspectRunning: () => { throw new Error("must not launch an active profile"); },
    bridgeRequest: async (_config, _session, request, options) => {
      if (request.command === "status") return { instanceId, nativeProtocol: 2, login: "authenticated", checkedAt: 1, versions: {} };
      sent = { request, options };
      return result;
    },
  }), 0);
  assert.equal(sent.request.command, "parse");
  assert.equal(sent.request.url, shareUrl);
  assert.deepEqual(Object.keys(sent.request).sort(), ["command", "id", "url"]);
  assert.equal(sent.options.instanceId, instanceId);
  assert.equal(sent.options.timeoutMs, 90_000);
  assert.deepEqual(JSON.parse(outputs[0]), result);
  assert.equal(errors.length, 0);
});

test("CLI never retries a dispatched task and a saved profile does not fall back", async () => {
  const config = { extensionId: EXTENSION_ID, profileDirectory: "Profile 3", chromeUserDataDir: "/tmp/chrome", appSupportDir: "/tmp/bridge" };
  const errors = [];
  const otherInstance = "423e4567-e89b-42d3-a456-426614174000";
  const selectedInstance = "523e4567-e89b-42d3-a456-426614174000";
  let taskRequestCount = 0;
  const exitCode = await runCli(["download", "--url", "https://weixin.qq.com/sph/synthetic"], {
    stderr: (value) => errors.push(value),
    readInstallation: async () => config,
    readSession: async () => SESSION_INFO,
    readConnections: async () => [{ instanceId: otherInstance, nativeProtocol: 2 }],
    readSelection: async () => selectedInstance,
    inspectRunning: () => { throw new Error("no fallback launch should happen while Chrome is running"); },
    bridgeRequest: async (_config, _session, request) => {
      if (request.command !== "status") taskRequestCount += 1;
      throw new BridgeError("BRIDGE_TIMEOUT", "ignored");
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(taskRequestCount, 0, "a different active instance cannot replace the saved selection");
  assert.equal(errors.length, 1);
});

test("agent returns only selected video fields and waits for Chrome's real download outcome", async () => {
  const parsed = {
    title: "A title",
    author: "An author",
    coverUrl: "https://media.example/cover.jpg?sig=x",
    previewUrl: "https://media.example/video.mp4?sig=x",
    downloadUrl: "https://media.example/video.mp4?sig=x",
    mediaVariants: [{ label: "H.264", downloadUrl: "https://media.example/video.mp4?sig=x" }],
    playableUrl: "https://yuanbao.tencent.com/private?token=must-not-leak&eid=must-not-leak",
    rawResponse: { token: "must-not-leak", authUrl: "must-not-leak" },
  };
  let parsedRequest;
  let downloaded;
  let waitedId;
  const chromeApi = {};
  const handler = createAgentCommandHandler({
    chromeApi,
    requestFactory: () => async () => new Response(null, { status: 200 }),
    parser: async (url, options) => { parsedRequest = { url, request: options.request }; return parsed; },
    downloadStarter: async (video, api, filename) => {
      downloaded = { video, api, filename };
      return 55;
    },
    downloadWaiter: async (id) => { waitedId = id; return { state: "complete", path: "/Users/test/Downloads/clip.mp4", bytes: 321 }; },
  });
  const parseResponse = await handler({ id: REQUEST_ID, command: "parse", url: "https://weixin.qq.com/sph/synthetic" });
  assert.equal(parsedRequest.url, "https://weixin.qq.com/sph/synthetic");
  assert.deepEqual(Object.keys(parseResponse.result).sort(), ["author", "coverUrl", "downloadUrl", "mediaVariants", "previewUrl", "title"]);
  assert.equal(JSON.stringify(parseResponse).includes("must-not-leak"), false);

  const downloadResponse = await handler({
    id: REQUEST_ID,
    command: "download",
    url: "https://weixin.qq.com/sph/synthetic",
    filename: "Clips/clip.mp4",
  });
  assert.deepEqual(downloaded, { video: parseResponse.result, api: chromeApi, filename: "Clips/clip.mp4" });
  assert.equal(JSON.stringify(downloaded).includes("must-not-leak"), false);
  assert.equal(waitedId, 55);
  assert.deepEqual(downloadResponse, {
    id: REQUEST_ID,
    ok: true,
    result: {
      title: "A title",
      author: "An author",
      coverUrl: "https://media.example/cover.jpg?sig=x",
      previewUrl: "https://media.example/video.mp4?sig=x",
      downloadUrl: "https://media.example/video.mp4?sig=x",
      mediaVariants: [{ label: "H.264", downloadUrl: "https://media.example/video.mp4?sig=x" }],
      state: "complete",
      path: "/Users/test/Downloads/clip.mp4",
      bytes: 321,
    },
  });
  assert.equal(JSON.stringify(downloadResponse).includes("must-not-leak"), false);
});

test("agent treats interrupted and zero-byte Chrome downloads as failures", async () => {
  const video = { title: "clip", author: "author", coverUrl: "", previewUrl: "https://media.example/v.mp4", downloadUrl: "https://media.example/v.mp4", mediaVariants: [] };
  const base = {
    parser: async () => video,
    downloadStarter: async () => 9,
    requestFactory: () => async () => new Response(null, { status: 200 }),
  };
  const interrupted = await createAgentCommandHandler({
    ...base,
    downloadWaiter: async () => ({ state: "interrupted", path: "/Users/test/Downloads/clip.mp4", bytes: 10 }),
  })({ id: REQUEST_ID, command: "download", url: "https://weixin.qq.com/sph/demo" });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.error.code, "DOWNLOAD_INTERRUPTED");
  assert.deepEqual(interrupted.result, { state: "interrupted", path: "/Users/test/Downloads/clip.mp4", bytes: 10 });
  assert.equal(validateBridgeResponse(interrupted, REQUEST_ID), true);

  const empty = await createAgentCommandHandler({
    ...base,
    downloadWaiter: async () => ({ state: "complete", path: "/Users/test/Downloads/empty.mp4", bytes: 0 }),
  })({ id: REQUEST_ID, command: "download", url: "https://weixin.qq.com/sph/demo" });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "DOWNLOAD_EMPTY");
});

test("CLI bridge request clears listeners and never retries after a timeout", async () => {
  await withShortTempDir(async (root) => {
    const socketPath = join(root, "bridge.sock");
    const sessionId = SESSION_1;
    const config = { appSupportDir: root };
    const { bridgeSocketPath } = await import("../skills/weixin-channels-video/scripts/bridge-install.mjs");
    const path = bridgeSocketPath(config, sessionId);
    const server = createAuthenticatedFakeServer({ onTask: (request, client) => setTimeout(() => client.write(Buffer.from(encodeBridgeFrame({
      type: "result", version: 2,
      response: { id: request.id, ok: true, result: { title: "late" } },
    }))), 100) });
    await mkdir(root, { recursive: true });
    await new Promise((resolve) => server.listen(path, resolve));
    let connectCount = 0;
    let socket;
    const request = { id: REQUEST_ID, command: "parse", url: "https://weixin.qq.com/sph/demo" };
    await assert.rejects(requestBridge(config, SESSION_INFO, request, {
      timeoutMs: 20,
      connectImpl: (...args) => {
        connectCount += 1;
        socket = connect(...args);
        return socket;
      },
    }), (error) => error instanceof BridgeError && error.code === "BRIDGE_TIMEOUT");
    assert.equal(connectCount, 1);
    assert.equal(socket.listenerCount("data"), 0);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.endsWith(".sock"), true);
  });
});

test("socket access failures stay distinct from disconnected bridge status and redact OS details", async () => {
  const config = { appSupportDir: "/tmp/wcv-private-bridge" };
  const rawError = Object.assign(new Error("EACCES /private/tmp/private-session.sock"), { code: "EACCES" });
  const socketFor = (error) => {
    const socket = new EventEmitter();
    socket.write = () => {};
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit("error", error));
    return socket;
  };

  for (const code of ["ENOENT", "ECONNREFUSED", "ECONNRESET"]) {
    const error = Object.assign(new Error(`${code} private socket path`), { code });
    await assert.rejects(requestBridge(config, SESSION_INFO, { id: REQUEST_ID, command: "status" }, {
      connectImpl: () => socketFor(error),
    }), (failure) => failure instanceof BridgeError &&
      failure.code === "BRIDGE_DISCONNECTED" &&
      failure.message === BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED);
  }

  const stdout = [];
  const stderr = [];
  const status = await runCli(["status"], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    readInstallation: async () => config,
    readSession: async () => SESSION_INFO,
    readConnections: async () => [{ instanceId: "423e4567-e89b-42d3-a456-426614174000", nativeProtocol: 2 }],
    bridgeRequest: (bridgeConfig, sessionInfo, request, options) => requestBridge(
      bridgeConfig,
      sessionInfo,
      request,
      { ...options, connectImpl: () => socketFor(rawError) },
    ),
  });

  assert.equal(status, 1);
  assert.deepEqual(JSON.parse(stdout[0]), {
    configuration: "configured",
    connection: "failed:BRIDGE_CONNECTION_FAILED",
    login: "not_checked",
    versions: { cli: "unknown", host: "unknown", extension: "unknown" },
  });
  assert.equal(stderr.length, 0);
  assert.equal(JSON.stringify(stdout).includes("EACCES"), false);
  assert.equal(JSON.stringify(stdout).includes("private-session.sock"), false);

  const connectErrors = [];
  const connectStatus = await runCli(["connect"], {
    stderr: (value) => connectErrors.push(value),
    readInstallation: async () => config,
    readSession: async () => SESSION_INFO,
    readSelection: async () => "423e4567-e89b-42d3-a456-426614174000",
    readConnections: async () => [{ instanceId: "423e4567-e89b-42d3-a456-426614174000", nativeProtocol: 2 }],
    bridgeRequest: (bridgeConfig, sessionInfo, request, options) => requestBridge(
      bridgeConfig,
      sessionInfo,
      request,
      { ...options, connectImpl: () => socketFor(rawError) },
    ),
  });
  assert.equal(connectStatus, 1);
  assert.equal(connectErrors[0], `bridge-authentication BRIDGE_CONNECTION_FAILED: ${BRIDGE_ERROR_MESSAGES.BRIDGE_CONNECTION_FAILED}`);
  assert.equal(connectErrors[0].includes("EACCES"), false);
});

test("selected connection rejects a mismatched IPC secret without changing selection", async () => {
  await withShortTempDir(async (root) => {
    const config = { appSupportDir: root };
    const instanceId = "423e4567-e89b-42d3-a456-426614174000";
    const socketPath = bridgeSocketPath(config, SESSION_1, instanceId);
    const server = createAuthenticatedFakeServer({ hostSecret: "c".repeat(64) });
    await new Promise((resolve) => server.listen(socketPath, resolve));

    const errors = [];
    const exitCode = await runCli(["connect"], {
      stderr: (value) => errors.push(value),
      readInstallation: async () => config,
      readSession: async () => SESSION_INFO,
      readSelection: async () => instanceId,
      readConnections: async () => [{ version: 1, sessionId: SESSION_1, instanceId, generation: REQUEST_ID, nativeProtocol: 2 }],
    });
    await new Promise((resolve) => server.close(resolve));

    assert.equal(exitCode, 1);
    assert.equal(errors[0], `bridge-authentication BRIDGE_SESSION_MISMATCH: ${BRIDGE_ERROR_MESSAGES.BRIDGE_SESSION_MISMATCH}`);
  });
});
