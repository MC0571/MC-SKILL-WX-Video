import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeError } from "../skills/weixin-channels-video/scripts/bridge-client.mjs";
import { diagnoseEnvironment, inspectChromeInstallation, inspectChromeRunning, launchChrome } from "../skills/weixin-channels-video/scripts/diagnostics.mjs";
import { inspectChromeProfile } from "../skills/weixin-channels-video/scripts/chrome-profile.mjs";
import { installBridge, inspectBridgeComponents } from "../skills/weixin-channels-video/scripts/bridge-install.mjs";
import { runCli } from "../skills/weixin-channels-video/scripts/cli.mjs";

const EXTENSION_ID = "a".repeat(32);
const OTHER_EXTENSION_ID = "b".repeat(32);
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const IPC_SECRET = "c".repeat(64);

async function withChromeProfile(callback) {
  const root = await mkdtemp(join(tmpdir(), "wcv-diagnose-"));
  const userDataDir = join(root, "Chrome User Data");
  const profileDirectory = "Profile 2";
  await mkdir(join(userDataDir, profileDirectory), { recursive: true });
  await writeFile(join(userDataDir, "Local State"), JSON.stringify({
    profile: { info_cache: { [profileDirectory]: { name: "private profile name" } } },
  }));
  try { await callback({ root, userDataDir, profileDirectory }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("profile diagnostics read Chrome extension state without touching cookie files", async () => {
  await withChromeProfile(async ({ userDataDir, profileDirectory }) => {
    const profile = join(userDataDir, profileDirectory);
    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: "/private/extension", disable_reasons: [] } } },
    }));
    await writeFile(join(profile, "Cookies"), "must not be read");
    assert.deepEqual(await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID }), {
      state: "exists",
      extension: "enabled",
    });

    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: "/private/extension", disable_reasons: [1] } } },
    }));
    assert.deepEqual(await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID }), {
      state: "exists",
      extension: "disabled",
    });

    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: "/private/extension", state: 0 } } },
    }));
    assert.equal((await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID })).extension, "disabled");
    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: "/private/extension", state: 1 } } },
    }));
    assert.equal((await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID })).extension, "enabled");

    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { path: "/private/extension" } } },
    }));
    assert.deepEqual(await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID }), {
      state: "exists",
      extension: "recorded_unknown",
    });

    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [OTHER_EXTENSION_ID]: { path: "/private/other" } } },
    }));
    assert.deepEqual(await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID }), {
      state: "exists",
      extension: "missing_or_id_mismatch_possible",
    });
  });
});

test("profile diagnosis checks the directory without requiring Local State metadata", async () => {
  await withChromeProfile(async ({ userDataDir, profileDirectory }) => {
    assert.deepEqual(await inspectChromeProfile({ userDataDir, extensionId: EXTENSION_ID }), {
      state: "not_configured",
      extension: "unknown",
    });
    assert.deepEqual(await inspectChromeProfile({ profileDirectory: "Profile 9", userDataDir, extensionId: EXTENSION_ID }), {
      state: "not_found",
      extension: "unknown",
    });
    await writeFile(join(userDataDir, "Local State"), "not json");
    assert.deepEqual(await inspectChromeProfile({ profileDirectory, userDataDir, extensionId: EXTENSION_ID }), {
      state: "exists",
      extension: "unknown",
    });
  });
});

test("profile inspection preserves access-denied state without exposing filesystem details", async () => {
  const denied = Object.assign(new Error("private path"), { code: "EACCES" });
  const profile = await inspectChromeProfile({
    profileDirectory: "Profile 2",
    userDataDir: "/private/Chrome User Data",
    extensionId: EXTENSION_ID,
    lstatImpl: async () => { throw denied; },
  });
  assert.deepEqual(profile, { state: "access_denied", extension: "unknown" });

  const result = await diagnoseEnvironment({
    configuration: "configured",
    config: { profileDirectory: "Profile 2", chromeUserDataDir: "/private/Chrome User Data", extensionId: EXTENSION_ID },
    sessionInfo: { sessionId: SESSION_ID, ipcProtocol: 2, ipcSecret: IPC_SECRET },
  }, {
    inspectChrome: () => ({ installation: "installed", compatibility: "supported" }),
    inspectProfile: async () => profile,
    inspectBridge: async () => ({ registration: "valid", host: "present", launcher: "valid", node: "available", session: "available", security: "valid" }),
    readConnections: async () => [],
  });
  assert.equal(result.profile.state, "access_denied");
  assert.deepEqual(result.actions, ["open_chrome_extensions"]);
  assert.equal(JSON.stringify(result).includes("EACCES"), false);
  assert.equal(JSON.stringify(result).includes("/private/Chrome User Data"), false);
});

test("profile inspection stops after a preferences access denial and hands off one action", async () => {
  await withChromeProfile(async ({ userDataDir, profileDirectory }) => {
    const profilePath = join(userDataDir, profileDirectory);
    const securePreferencesPath = join(profilePath, "Secure Preferences");
    const preferencesPath = join(profilePath, "Preferences");
    const settings = JSON.stringify({ extensions: { settings: { [EXTENSION_ID]: { state: 1 } } } });
    await writeFile(securePreferencesPath, settings);
    await writeFile(preferencesPath, settings);

    for (const code of ["EPERM", "EACCES"]) {
      const denied = Object.assign(new Error("private path"), { code });
      const inspectedPaths = [];
      const profile = await inspectChromeProfile({
        profileDirectory,
        userDataDir,
        extensionId: EXTENSION_ID,
        lstatImpl: async (path) => { inspectedPaths.push(path); return lstat(path); },
        readFileImpl: async (path, encoding) => {
          inspectedPaths.push(path);
          if (path === securePreferencesPath) throw denied;
          return readFile(path, encoding);
        },
      });
      assert.deepEqual(profile, { state: "access_denied", extension: "unknown" });
      assert.equal(inspectedPaths.includes(preferencesPath), false);

      const result = await diagnoseEnvironment({
        configuration: "configured",
        config: { profileDirectory, chromeUserDataDir: userDataDir, extensionId: EXTENSION_ID },
        sessionInfo: { sessionId: SESSION_ID, ipcProtocol: 2, ipcSecret: IPC_SECRET },
      }, {
        inspectChrome: () => ({ installation: "installed", compatibility: "supported" }),
        inspectRunning: () => "running",
        inspectProfile: async () => profile,
        inspectBridge: async () => ({ registration: "valid", host: "present", launcher: "valid", node: "available", session: "available", security: "valid" }),
        readSelection: async () => null,
        readConnections: async () => [],
        waitForLegacyBridge: async () => { throw new BridgeError("BRIDGE_DISCONNECTED", "ignored"); },
      });
      assert.deepEqual(result.actions, ["open_chrome_extensions"]);
    }
  });
});

test("diagnosis keeps unavailable evidence unknown and redacts local identifiers", async () => {
  const config = {
    extensionId: EXTENSION_ID,
    profileDirectory: "Profile 2",
    chromeUserDataDir: "/private/Chrome User Data",
    appSupportDir: "/private/bridge",
  };
  const sessionInfo = { sessionId: SESSION_ID, ipcProtocol: 2, ipcSecret: IPC_SECRET };
  const result = await diagnoseEnvironment({ configuration: "configured", config, sessionInfo }, {
    inspectChrome: () => ({ installation: "installed", version: "154.0.8037.98", compatibility: "supported", appPath: "/private/Chrome.app" }),
    inspectRunning: () => "running",
    inspectProfile: async () => ({ state: "exists", extension: "recorded_unknown", profileName: "private profile name" }),
    inspectBridge: async () => ({ registration: "valid", host: "present", launcher: "valid", node: "available", session: "available", path: "/private/bridge" }),
    readSelection: async () => null,
    readConnections: async () => [{ instanceId: "423e4567-e89b-42d3-a456-426614174000", nativeProtocol: 2 }],
    bridgeRequest: async () => { throw new BridgeError("BRIDGE_SESSION_MISMATCH", "ignored"); },
  });
  assert.deepEqual(result, {
    configuration: "configured",
    chrome: {
      installation: "installed",
      version: "154.0.8037.98",
      compatibility: "supported",
      running: "running",
    },
    profile: { state: "exists" },
    extension: { state: "recorded_unknown" },
    bridge: { registration: "valid", host: "present", launcher: "valid", node: "available", nodeVersion: null, session: "available", security: "unknown" },
    connection: { state: "session_mismatch" },
    actions: ["check_extension_enabled_state_in_chrome", "repair_bridge_session_mismatch"],
    nextAction: "check_extension_enabled_state_in_chrome",
  });
  const serialized = JSON.stringify(result);
  for (const privateValue of [EXTENSION_ID, SESSION_ID, IPC_SECRET, "/private/", "private profile name"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("diagnosis exposes only validated packaged runtime fields and the current Node identity", async () => {
  const result = await diagnoseEnvironment({ configuration: "unconfigured" }, {
    includeRuntime: true,
    inspectChrome: () => ({ installation: "unknown", version: null, compatibility: "unknown" }),
    inspectRunning: () => "unknown",
  });
  assert.deepEqual(Object.keys(result.runtime), ["version", "runtimeProtocol", "minimumNodeVersion"]);
  assert.deepEqual(result.runtime, {
    version: "unknown",
    runtimeProtocol: "unknown",
    minimumNodeVersion: "unknown",
  });
  assert.deepEqual(result.currentNode, {
    version: process.versions.node,
    absolutePath: process.execPath,
  });
});

test("unsupported or unavailable host tools produce unknown Chrome state", () => {
  assert.deepEqual(inspectChromeInstallation({ platform: "linux" }), {
    installation: "unknown",
    version: null,
    compatibility: "unknown",
    appPath: null,
    executable: null,
  });
  assert.equal(inspectChromeRunning({ platform: "linux" }), "unknown");
});

test("Chrome discovery verifies the macOS bundle id and version before launch", () => {
  const appPath = "/Applications/Google Chrome.app";
  const runner = (_path, args) => {
    if (args[0].startsWith("kMDItem")) return { status: 0, stdout: "" };
    if (args[0] === "-c") {
      const key = args[1].slice("Print :".length);
      return { status: 0, stdout: ({
        CFBundleIdentifier: "com.google.Chrome",
        CFBundleShortVersionString: "154.0.8037.98",
        CFBundleExecutable: "Google Chrome",
      })[key] };
    }
    return { status: 1, stdout: "" };
  };
  assert.deepEqual(inspectChromeInstallation({ platform: "darwin", home: "/Users/test", commandRunner: runner }), {
    installation: "installed",
    version: "154.0.8037.98",
    compatibility: "supported",
    appPath,
    executable: join(appPath, "Contents/MacOS/Google Chrome"),
  });
  const oldRunner = (_path, args) => args[0].startsWith("kMDItem")
    ? { status: 0, stdout: "" }
    : args[0] === "-c" && args[1] === "Print :CFBundleIdentifier"
      ? { status: 0, stdout: "com.google.Chrome" }
      : args[0] === "-c" && args[1] === "Print :CFBundleShortVersionString"
        ? { status: 0, stdout: "115.0.0.0" }
        : { status: 0, stdout: "Google Chrome" };
  assert.equal(inspectChromeInstallation({ platform: "darwin", commandRunner: oldRunner }).compatibility, "too_old");
  const unavailableRunner = () => ({ status: null, error: new Error("unavailable") });
  assert.equal(inspectChromeInstallation({ platform: "darwin", commandRunner: unavailableRunner }).installation, "unknown");
});

test("Windows Chrome discovery checks known installation paths and records supported versions", () => {
  const calls = [];
  const env = {
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
  };
  const expected = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
  const result = inspectChromeInstallation({
    platform: "win32",
    env,
    commandRunner: (_path, args, options) => {
      const candidate = options.env.WCV_CHROME_EXE;
      calls.push(candidate);
      return candidate === expected
        ? { status: 0, stdout: "154.0.8037.98\n" }
        : { status: 10, stdout: "" };
    },
  });
  assert.deepEqual(calls, [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    expected,
  ]);
  assert.deepEqual(result, {
    installation: "installed",
    version: "154.0.8037.98",
    compatibility: "supported",
    appPath: expected,
    executable: expected,
  });
  assert.equal(inspectChromeRunning({ platform: "win32", commandRunner: () => ({ status: 0, stdout: '"chrome.exe","1234"' }) }), "running");
  assert.equal(inspectChromeRunning({ platform: "win32", commandRunner: () => ({ status: 0, stdout: "INFO: No tasks are running" }) }), "not_running");

  const defaultCalls = [];
  const defaultWrapperResult = inspectChromeInstallation({
    platform: "win32",
    env,
    spawnSyncImpl: (path, args, options) => {
      defaultCalls.push({ path, args, env: options.env });
      return { status: 0, stdout: "154.0.8037.98\n" };
    },
  });
  assert.equal(defaultWrapperResult.installation, "installed");
  assert.equal(defaultCalls[0].env.WCV_CHROME_EXE, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  assert.equal(defaultCalls[0].args[3].includes("$env:WCV_CHROME_EXE"), true);
  assert.ok(defaultCalls[0].args[3].indexOf("Microsoft.PowerShell.Management.psd1") < defaultCalls[0].args[3].indexOf("Get-Item -LiteralPath"));
});

test("Windows Chrome launch passes long profile paths as argv without a shell", async () => {
  const calls = [];
  const config = {
    chromeUserDataDir: "C:\\Users\\Test User\\AppData\\Local\\Google\\Chrome\\User Data",
    profileDirectory: "Profile 2",
    extensionId: EXTENSION_ID,
  };
  await launchChrome(config, SESSION_ID, {
    platform: "win32",
    inspectChrome: () => ({ installation: "installed", compatibility: "supported", executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }),
    inspectProfileDirectory: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    processLauncher: async (executable, args) => {
      calls.push({ executable, args });
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [{
    executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: [
      `--user-data-dir=${config.chromeUserDataDir}`,
      "--profile-directory=Profile 2",
      "--no-startup-window",
    ],
  }]);
});

test("macOS Chrome launch requests no startup window and passes no bootstrap URL", async () => {
  await withChromeProfile(async ({ userDataDir, profileDirectory }) => {
    const config = { chromeUserDataDir: userDataDir, profileDirectory, extensionId: EXTENSION_ID };
    const calls = [];
    const inspectChrome = () => ({ installation: "installed", compatibility: "supported", appPath: "/Applications/Google Chrome.app", executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
    const processLauncher = async (executable, args) => {
      calls.push({ executable, args });
      return { status: 0 };
    };
    await launchChrome(config, SESSION_ID, { platform: "darwin", inspectChrome, processLauncher, inspectProfile: async () => { throw new Error("metadata may be inaccessible"); } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, "/usr/bin/open");
    assert.deepEqual(calls[0].args, ["-g", "-a", "/Applications/Google Chrome.app", "--args", `--user-data-dir=${userDataDir}`, `--profile-directory=${profileDirectory}`, "--no-startup-window"]);
    assert.equal(calls[0].args.some((argument) => argument.startsWith("chrome-extension://")), false);
    assert.equal(calls[0].args.includes("--headless"), false);
    assert.equal(calls[0].args.some((argument) => argument.startsWith("--remote-debugging")), false);
  });
});

test("Chrome launch refuses missing, non-directory, and symbolic-link profiles", async () => {
  const launches = [];
  const config = { chromeUserDataDir: "/Users/test/Chrome User Data", profileDirectory: "Profile 2", extensionId: EXTENSION_ID };
  const dependencies = {
    platform: "darwin",
    inspectChrome: () => ({ installation: "installed", compatibility: "supported", executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }),
    processLauncher: async (...args) => { launches.push(args); return { status: 0 }; },
  };
  await assert.rejects(launchChrome(config, SESSION_ID, {
    ...dependencies,
    inspectProfileDirectory: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); },
  }), { code: "CHROME_PROFILE_UNAVAILABLE" });
  await assert.rejects(launchChrome(config, SESSION_ID, {
    ...dependencies,
    inspectProfileDirectory: async () => ({ isDirectory: () => false, isSymbolicLink: () => false }),
  }), { code: "CHROME_PROFILE_UNAVAILABLE" });
  await assert.rejects(launchChrome(config, SESSION_ID, {
    ...dependencies,
    inspectProfileDirectory: async () => ({ isDirectory: () => true, isSymbolicLink: () => true }),
  }), { code: "CHROME_PROFILE_UNAVAILABLE" });
  await assert.rejects(launchChrome({ ...config, profileDirectory: "" }, SESSION_ID, dependencies), { code: "CHROME_PROFILE_UNAVAILABLE" });
  assert.equal(launches.length, 0);
});

test("Chrome launch reports unsupported platforms without reading configuration or launching an app", async () => {
  const calls = [];
  await assert.rejects(launchChrome({}, undefined, {
    platform: "linux",
    inspectChrome: () => { calls.push("inspectChrome"); throw new Error("must not inspect"); },
    processLauncher: () => { calls.push("processLauncher"); return { status: 0 }; },
  }), { code: "CHROME_UNAVAILABLE" });
  assert.deepEqual(calls, []);
});

test("diagnosis preserves native connection failures", async () => {
  const result = await diagnoseEnvironment({
    configuration: "configured",
    config: { profileDirectory: "Default", chromeUserDataDir: "/private/Chrome User Data", extensionId: EXTENSION_ID },
    sessionId: SESSION_ID,
  }, {
    inspectChrome: () => ({ installation: "installed", version: "154.0.8037.98", compatibility: "supported" }),
    inspectRunning: () => "running",
    inspectProfile: async () => ({ state: "exists", extension: "enabled" }),
    inspectBridge: async () => ({ registration: "valid", host: "present", launcher: "valid", node: "available", session: "available" }),
    readSelection: async () => null,
    readConnections: async () => [{ instanceId: "423e4567-e89b-42d3-a456-426614174000", nativeProtocol: 2 }],
    bridgeRequest: async () => { throw new BridgeError("BRIDGE_CONNECTION_FAILED", "ignored"); },
  });
  assert.equal(result.connection.state, "connection_failed");
  assert.deepEqual(result.actions, ["restore_connection_before_next_task"]);
});

test("an authenticated bridge stays connected without metadata-based recovery actions", async () => {
  let profileInspections = 0;
  const result = await diagnoseEnvironment({
    configuration: "configured",
    config: { profileDirectory: "Profile 2", chromeUserDataDir: "/private/Chrome User Data", extensionId: EXTENSION_ID },
    sessionInfo: { sessionId: SESSION_ID, ipcProtocol: 2, ipcSecret: IPC_SECRET },
  }, {
    inspectChrome: () => ({ installation: "installed", version: "154.0.8037.98", compatibility: "supported" }),
    inspectProfile: async () => { profileInspections += 1; return { state: "unknown", extension: "unknown" }; },
    inspectBridge: async () => ({ registration: "valid", host: "present", launcher: "valid", node: "available", session: "available", security: "unknown" }),
    readSelection: async () => null,
    readConnections: async () => [{ instanceId: "423e4567-e89b-42d3-a456-426614174000", nativeProtocol: 2 }],
    bridgeRequest: async () => ({ instanceId: "423e4567-e89b-42d3-a456-426614174000", nativeProtocol: 2, login: "authenticated", checkedAt: 100, versions: {} }),
  });
  assert.deepEqual(result.connection, { state: "connected", instanceId: "423e4567-e89b-42d3-a456-426614174000", login: "authenticated", checkedAt: 100 });
  assert.deepEqual(result.actions, []);
  assert.equal(result.nextAction, undefined);
  assert.equal(profileInspections, 0);
  assert.deepEqual(result.profile, { state: "unknown" });
});

test("profile-less diagnosis reports bridge repairs without suggesting legacy pairing", async () => {
  const base = { registration: "valid", host: "present", launcher: "valid", node: "available", session: "available", security: "valid" };
  const cases = [
    [{ registration: "missing" }, "repair_bridge_if_authorized"],
    [{ host: "missing" }, "repair_bridge_if_authorized"],
    [{ security: "invalid" }, "repair_bridge_if_authorized"],
    [{ node: "missing" }, "register_bridge_with_a_supported_node"],
    [{ session: "missing" }, "repair_bridge_registration"],
    [{ session: "invalid" }, "repair_bridge_registration"],
    [{}, "open_chrome_and_enable_extension"],
  ];
  for (const [override, expected] of cases) {
    const result = await diagnoseEnvironment({
      configuration: "configured",
      config: { extensionId: EXTENSION_ID, appSupportDir: "/private/bridge" },
      sessionInfo: { sessionId: SESSION_ID, ipcProtocol: 2, ipcSecret: IPC_SECRET },
    }, {
      inspectChrome: () => ({ installation: "installed", version: "154.0.8037.98", compatibility: "supported" }),
      inspectBridge: async () => ({ ...base, ...override }),
      readConnections: async () => [],
    });
    assert.equal(result.nextAction, expected, JSON.stringify(override));
    assert.equal(result.actions.some((action) => action.includes("pairing")), false);
  }
  const windowsUnknownSecurity = await diagnoseEnvironment({
    configuration: "configured",
    config: { extensionId: EXTENSION_ID, appSupportDir: "C:\\private\\bridge" },
  }, {
    platform: "win32",
    inspectChrome: () => ({ installation: "installed", compatibility: "supported" }),
    inspectBridge: async () => ({ ...base, security: "unknown" }),
  });
  assert.equal(windowsUnknownSecurity.nextAction, "inspect_chrome_extension_and_bridge_manually");
});

test("diagnosis shares live instance selection and reports ambiguity, offline selection, and legacy protocol", async () => {
  const first = "423e4567-e89b-42d3-a456-426614174000";
  const second = "523e4567-e89b-42d3-a456-426614174000";
  const base = {
    configuration: "configured",
    config: { extensionId: EXTENSION_ID, appSupportDir: "/private/bridge" },
    sessionInfo: { sessionId: SESSION_ID, ipcProtocol: 2, ipcSecret: IPC_SECRET },
  };
  const dependencies = {
    inspectChrome: () => ({ installation: "installed", compatibility: "supported" }),
    inspectBridge: async () => ({ registration: "valid", host: "present", launcher: "valid", node: "available", session: "available", security: "valid" }),
  };
  const ambiguous = await diagnoseEnvironment(base, {
    ...dependencies,
    readConnections: async () => [{ instanceId: first, nativeProtocol: 2 }, { instanceId: second, nativeProtocol: 2 }],
    bridgeRequest: async (_config, _session, request, options) => ({
      instanceId: options.instanceId, nativeProtocol: 2, login: "authenticated", checkedAt: 1, versions: {},
    }),
  });
  assert.equal(ambiguous.connection.state, "profile_ambiguous");
  assert.equal(ambiguous.nextAction, "connect_to_one_chrome_profile");

  const offline = await diagnoseEnvironment(base, {
    ...dependencies,
    readSelection: async () => first,
    readConnections: async () => [],
  });
  assert.deepEqual(offline.connection, { state: "selected_offline", instanceId: first });
  assert.equal(offline.nextAction, "restore_selected_chrome_connection");

  const legacy = await diagnoseEnvironment(base, {
    ...dependencies,
    readConnections: async () => [{ instanceId: "00000000-0000-4000-8000-000000000000", nativeProtocol: 1 }],
    waitForLegacyBridge: async () => {},
  });
  assert.equal(legacy.connection.state, "protocol_unsupported");
  assert.equal(legacy.nextAction, "update_extension_and_skill");

  const currentUnprofiled = await diagnoseEnvironment(base, {
    ...dependencies,
    readConnections: async () => [{ instanceId: first, nativeProtocol: 2 }],
    bridgeRequest: async () => ({ instanceId: first, nativeProtocol: 2, login: "authenticated", checkedAt: 1, versions: {} }),
  });
  assert.equal(currentUnprofiled.connection.state, "connected");
  assert.deepEqual(currentUnprofiled.actions, []);

  const protocolError = await diagnoseEnvironment(base, {
    ...dependencies,
    readSelection: async () => first,
    readConnections: async () => [{ instanceId: first, nativeProtocol: 2 }],
    bridgeRequest: async () => { throw new BridgeError("BRIDGE_PROTOCOL_ERROR", "private response detail"); },
  });
  assert.equal(protocolError.connection.state, "protocol_error");
  assert.equal(protocolError.connection.error, "BRIDGE_PROTOCOL_ERROR");
  assert.equal(protocolError.nextAction, "inspect_bridge_protocol_compatibility");
  assert.equal(JSON.stringify(protocolError).includes("private response detail"), false);
});

test("macOS diagnosis tolerates unknown Windows-only security without obsolete pairing advice", { skip: process.platform !== "darwin" }, async () => {
  await withChromeProfile(async ({ root, userDataDir }) => {
    const appSupportDir = join(root, "bridge");
    const registryDir = join(root, "NativeMessagingHosts");
    const nativeHostSource = join(root, "native-host.mjs");
    await writeFile(nativeHostSource, "// test native host\n");
    const installed = await installBridge({
      extensionId: EXTENSION_ID,
      appSupportDir,
      chromeUserDataDir: userDataDir,
      registryDir,
      nodeExecutable: process.execPath,
      nativeHostSource,
      platform: "darwin",
    });
    const bridge = await inspectBridgeComponents(installed.config, { registryDir });
    assert.deepEqual(bridge, {
      registration: "valid",
      host: "present",
      launcher: "valid",
      node: "available",
      nodeVersion: process.versions.node,
      session: "available",
      security: "unknown",
    });
    const result = await diagnoseEnvironment({ configuration: "configured", config: installed.config }, {
      platform: "darwin",
      inspectChrome: () => ({ installation: "installed", compatibility: "supported" }),
      inspectBridge: (config) => inspectBridgeComponents(config, { registryDir }),
    });
    assert.equal(result.nextAction, "inspect_chrome_extension_and_bridge_manually");
  });
});

test("diagnosis recommends bridge repair when Windows private-path security is invalid", async () => {
  const result = await diagnoseEnvironment({
    configuration: "configured",
    config: { profileDirectory: "Default", chromeUserDataDir: "C:\\Chrome User Data", extensionId: EXTENSION_ID },
  }, {
    platform: "win32",
    inspectChrome: () => ({ installation: "installed", version: "154.0.8037.98", compatibility: "supported" }),
    inspectRunning: () => "running",
    inspectProfile: async () => ({ state: "exists", extension: "enabled" }),
    inspectBridge: async () => ({
      registration: "valid",
      host: "present",
      launcher: "valid",
      node: "available",
      session: "available",
      security: "invalid",
    }),
  });
  assert.equal(result.bridge.host, "present");
  assert.equal(result.bridge.launcher, "valid");
  assert.deepEqual(result.actions, ["repair_bridge_if_authorized"]);
  assert.equal(result.nextAction, "repair_bridge_if_authorized");
});

test("bridge diagnostics runs the configured absolute Node safely and classifies its version", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "wcv-node-diagnose-"));
  const hostPath = join(root, "native-host.mjs");
  const configPath = join(root, "bridge.json");
  const launcherPath = join(root, "native-host-launcher");
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  await writeFile(hostPath, "// native host fixture\n");
  await writeFile(launcherPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hostPath)} ${quote(configPath)} "$@"\n`, { mode: 0o700 });
  await chmod(launcherPath, 0o700);
  const config = {
    platform: "darwin",
    appSupportDir: root,
    chromeUserDataDir: join(root, "Chrome User Data"),
    nodeExecutable: process.execPath,
    extensionId: EXTENSION_ID,
  };
  const cases = [
    [{ status: 0, stdout: "v22.22.2\n" }, "available", "22.22.2"],
    [{ status: 0, stdout: "v20.0.0\n" }, "version_incompatible", "20.0.0"],
    [{ error: Object.assign(new Error("missing"), { code: "ENOENT" }) }, "missing", null],
    [{ error: Object.assign(new Error("denied"), { code: "EACCES" }) }, "access_failed", null],
  ];
  try {
    for (const [spawnResult, expectedState, expectedVersion] of cases) {
      const inspected = await inspectBridgeComponents(config, {
        platform: "darwin",
        nodeSpawnSyncImpl: (executable, args, options) => {
          assert.equal(executable, process.execPath);
          assert.deepEqual(args, ["--version"]);
          assert.equal(options.shell, false);
          assert.equal(options.env.PATH, "");
          assert.equal(options.env.NODE_OPTIONS, undefined);
          return spawnResult;
        },
      });
      assert.equal(inspected.launcher, "valid");
      assert.equal(inspected.node, expectedState);
      assert.equal(inspected.nodeVersion, expectedVersion);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnose CLI is read only and reports invalid configuration as structured JSON", async () => {
  let received;
  const output = [];
  assert.equal(await runCli(["diagnose"], {
    stdout: (value) => output.push(value),
    readInstallation: async () => { throw new Error("private configuration details"); },
    diagnose: async (request) => {
      received = request;
      return { configuration: request.configuration, actions: ["configure_bridge_and_select_profile"] };
    },
  }), 0);
  assert.deepEqual(received, { configuration: "invalid", config: undefined, sessionInfo: undefined });
  assert.deepEqual(JSON.parse(output[0]), { configuration: "invalid", actions: ["configure_bridge_and_select_profile"] });
  assert.equal(output[0].includes("private configuration details"), false);
});

test("candidate diagnosis checks recorded profile state only and emits one next action", async () => {
  await withChromeProfile(async ({ userDataDir, profileDirectory }) => {
    const profile = join(userDataDir, profileDirectory);
    await writeFile(join(profile, "Secure Preferences"), JSON.stringify({
      extensions: { settings: { [EXTENSION_ID]: { state: 1 } } },
    }));
    const result = await diagnoseEnvironment({
      configuration: "unconfigured",
      candidate: { profile: profileDirectory, extensionId: EXTENSION_ID },
    }, {
      platform: "darwin",
      chromeUserDataDir: userDataDir,
      inspectChrome: () => ({ installation: "installed", version: "154.0.0.0", compatibility: "supported" }),
      inspectRunning: () => "unknown",
      bridgeRequest: async () => assert.fail("metadata candidate diagnosis must not probe a live bridge"),
    });
    assert.deepEqual(result.candidate, {
      checkScope: "chrome_profile_metadata",
      status: "recorded_enabled",
      reason: "extension_enabled",
      profile: { state: "exists" },
      extension: { state: "enabled" },
      liveHandshake: "not_checked",
      nextAction: "install_bridge_with_selected_profile",
    });
    assert.equal(result.nextAction, "install_bridge_with_selected_profile");
    assert.equal(result.actions.includes("configure_bridge_and_select_profile"), false);
    const serialized = JSON.stringify(result.candidate);
    assert.equal(serialized.includes(EXTENSION_ID), false);
    assert.equal(serialized.includes(profileDirectory), false);
  });
});

test("candidate diagnose CLI validates the pair and does not read installed configuration", async () => {
  const output = [];
  let request;
  const code = await runCli(["diagnose", "--profile", "Profile 2", "--extension-id", EXTENSION_ID], {
    stdout: (value) => output.push(value),
    readInstallation: async () => { throw new Error("must not read installed configuration"); },
    diagnose: async (value) => { request = value; return { candidate: { nextAction: "install_bridge_with_selected_profile" } }; },
  });
  assert.equal(code, 0);
  assert.deepEqual(request, {
    configuration: "unconfigured",
    candidate: { profile: "Profile 2", extensionId: EXTENSION_ID },
  });
  assert.deepEqual(JSON.parse(output[0]), { candidate: { nextAction: "install_bridge_with_selected_profile" } });

  assert.equal(await runCli(["diagnose", "--profile", "Profile 2"], { stderr: () => {} }), 2);
});

test("instance diagnose validates and forwards one explicit identity", async () => {
  const instanceId = "423e4567-e89b-42d3-a456-426614174000";
  let configurationReads = 0;
  const invalidArguments = [
    ["diagnose", "--instance", instanceId],
    ["diagnose", "--extension-id", EXTENSION_ID],
    ["diagnose", "--instance", "not-a-uuid", "--extension-id", EXTENSION_ID],
    ["diagnose", "--instance", instanceId, "--extension-id", "invalid"],
    ["diagnose", "--profile", "Default", "--instance", instanceId, "--extension-id", EXTENSION_ID],
  ];
  for (const args of invalidArguments) {
    assert.equal(await runCli(args, {
      stderr: () => {},
      readInstallation: async () => { configurationReads += 1; return null; },
    }), 2);
  }
  assert.equal(configurationReads, 0);

  const output = [];
  let request;
  const config = { extensionId: EXTENSION_ID };
  const sessionInfo = { sessionId: SESSION_ID, ipcProtocol: 2, ipcSecret: IPC_SECRET };
  assert.equal(await runCli(["diagnose", "--instance", instanceId, "--extension-id", EXTENSION_ID], {
    stdout: (value) => output.push(value),
    readInstallation: async () => config,
    readSession: async () => sessionInfo,
    diagnose: async (value) => { request = value; return { target: value.target }; },
  }), 0);
  assert.deepEqual(request, {
    configuration: "configured",
    config,
    sessionInfo,
    target: { instanceId, extensionId: EXTENSION_ID },
  });
  assert.deepEqual(JSON.parse(output[0]), { target: { instanceId, extensionId: EXTENSION_ID } });
});

test("instance diagnosis preserves its identity when setup is unavailable and skips profile metadata", async () => {
  const instanceId = "423e4567-e89b-42d3-a456-426614174000";
  const otherInstanceId = "523e4567-e89b-42d3-a456-426614174000";
  const sessionInfo = { sessionId: SESSION_ID, ipcProtocol: 2, ipcSecret: IPC_SECRET };
  const cases = [
    [{ configuration: "unconfigured" }, "configuration_missing", "install_bridge_with_requested_extension"],
    [{ configuration: "invalid" }, "configuration_invalid", "repair_bridge_registration"],
    [{ configuration: "configured", config: { extensionId: OTHER_EXTENSION_ID }, sessionInfo }, "extension_mismatch", "repair_bridge_registration"],
    [{ configuration: "configured", config: { extensionId: EXTENSION_ID } }, "session_unavailable", "inspect_bridge_session"],
    [{ configuration: "configured", config: { extensionId: EXTENSION_ID }, sessionInfo: { sessionId: SESSION_ID, ipcProtocol: 2 } }, "session_invalid", "repair_bridge_registration"],
  ];
  for (const [request, state, nextAction] of cases) {
    let reads = 0;
    const target = { instanceId, extensionId: EXTENSION_ID };
    const result = await diagnoseEnvironment({ ...request, target }, {
      inspectChrome: () => ({ installation: "installed", compatibility: "supported" }),
      inspectBridge: async () => ({}),
      readSelection: async () => { reads += 1; return otherInstanceId; },
      readConnections: async () => { reads += 1; return []; },
      inspectProfile: async () => { reads += 1; return { state: "exists", extension: "enabled" }; },
    });
    assert.deepEqual(result.target, target);
    assert.equal(result.connection.state, state);
    assert.equal(result.nextAction, nextAction);
    assert.equal(reads, 0);
  }
});

test("unavailable targeted session needs evidence before repair", async () => {
  const request = {
    configuration: "configured", config: { extensionId: EXTENSION_ID },
    target: { instanceId: "423e4567-e89b-42d3-a456-426614174000", extensionId: EXTENSION_ID },
  };
  const result = await diagnoseEnvironment(request, {
    inspectChrome: () => ({ installation: "installed", compatibility: "supported" }),
    inspectBridge: async () => ({ session: "missing" }),
  });
  assert.equal(result.connection.state, "session_unavailable");
  assert.equal(result.nextAction, "repair_bridge_registration");
});

test("offline explicit target never probes another online instance", async () => {
  const instanceId = "423e4567-e89b-42d3-a456-426614174000";
  const result = await diagnoseEnvironment({
    configuration: "configured", config: { extensionId: EXTENSION_ID },
    sessionInfo: { sessionId: SESSION_ID, ipcProtocol: 2, ipcSecret: IPC_SECRET },
    target: { instanceId, extensionId: EXTENSION_ID },
  }, {
    inspectChrome: () => ({ installation: "installed", compatibility: "supported" }),
    inspectBridge: async () => ({}),
    readSelection: async () => { assert.fail("must not read a different selection"); },
    readConnections: async () => [{ instanceId: "523e4567-e89b-42d3-a456-426614174000", nativeProtocol: 2 }],
    bridgeRequest: async () => { assert.fail("must not probe another instance"); },
    inspectProfile: async () => { assert.fail("must not read another profile"); },
  });
  assert.deepEqual(result.connection, { state: "selected_offline", instanceId });
  assert.equal(result.nextAction, "restore_selected_chrome_connection");
});

test("instance diagnosis probes only its target and reports protocol errors without leaking details", async () => {
  const instanceId = "423e4567-e89b-42d3-a456-426614174000";
  const otherInstanceId = "523e4567-e89b-42d3-a456-426614174000";
  const target = { instanceId, extensionId: EXTENSION_ID };
  const requestInstances = [];
  let selectionReads = 0;
  let profileReads = 0;
  const result = await diagnoseEnvironment({
    configuration: "configured",
    config: { extensionId: EXTENSION_ID },
    sessionInfo: { sessionId: SESSION_ID, ipcProtocol: 2, ipcSecret: IPC_SECRET },
    target,
  }, {
    inspectChrome: () => ({ installation: "installed", compatibility: "supported" }),
    inspectBridge: async () => ({}),
    readSelection: async () => { selectionReads += 1; return otherInstanceId; },
    readConnections: async () => [
      { instanceId: otherInstanceId, nativeProtocol: 2 },
      { instanceId, nativeProtocol: 2 },
    ],
    bridgeRequest: async (_config, _sessionInfo, _request, options) => {
      requestInstances.push(options.instanceId);
      throw new BridgeError("BRIDGE_PROTOCOL_ERROR", "private response detail");
    },
    inspectProfile: async () => { profileReads += 1; return { state: "exists", extension: "enabled" }; },
  });
  assert.deepEqual(result.target, target);
  assert.equal(result.connection.state, "protocol_error");
  assert.equal(result.connection.error, "BRIDGE_PROTOCOL_ERROR");
  assert.equal(result.nextAction, "inspect_bridge_protocol_compatibility");
  assert.deepEqual(requestInstances, [instanceId]);
  assert.equal(selectionReads, 0);
  assert.equal(profileReads, 0);
  assert.equal(JSON.stringify(result).includes("private response detail"), false);
});

test("install-bridge accepts manual pairing and pairing-info emits only the session identifier", async () => {
  const output = [];
  let installOptions;
  const config = { extensionId: EXTENSION_ID, profileDirectory: "Profile 2" };
  const sessionInfo = { sessionId: SESSION_ID, ipcSecret: IPC_SECRET };
  assert.equal(await runCli(["install-bridge", "--extension-id", EXTENSION_ID], {
    stdout: (value) => output.push(value),
    install: async (value) => { installOptions = value; return { profile: null, config }; },
  }), 0);
  assert.deepEqual(installOptions, { extensionId: EXTENSION_ID, profile: undefined });
  assert.deepEqual(JSON.parse(output.pop()), { installed: true, profile: null, extensionId: EXTENSION_ID, versions: { cli: "unknown", host: "unknown", extension: "unknown" } });
  assert.equal(await runCli(["pairing-info"], {
    stdout: (value) => output.push(value),
    readInstallation: async () => config,
    readSession: async () => sessionInfo,
  }), 0);
  assert.deepEqual(JSON.parse(output[0]), { sessionId: SESSION_ID });
  assert.equal(output[0].includes(IPC_SECRET), false);
  assert.equal(output[0].includes("chrome-extension://"), false);
});

test("connect launches only the selected profile and returns after its record appears", async () => {
  const output = [];
  let launches = 0;
  let reads = 0;
  const instanceId = "423e4567-e89b-42d3-a456-426614174000";
  const config = { extensionId: EXTENSION_ID, profileDirectory: "Profile 2" };
  assert.equal(await runCli(["connect"], {
    stdout: (value) => output.push(value),
    readInstallation: async () => config,
    readSession: async () => ({ sessionId: SESSION_ID }),
    readSelection: async () => null,
    readConnections: async () => ++reads === 1 ? [] : [{ instanceId, nativeProtocol: 2 }],
    inspectRunning: () => "not_running",
    launch: async () => { launches += 1; },
    sleep: async () => {},
    connectionWaitMs: 100,
    bridgeRequest: async (_config, _session, request, options) => ({
      instanceId: options.instanceId, nativeProtocol: 2, login: "authenticated", checkedAt: 1, versions: {},
    }),
  }), 0);
  assert.equal(launches, 1);
  assert.ok(reads >= 2);
  assert.equal(output[0], "Connected to the Chrome extension.");
});

test("failed Chrome launch reports a safe start error", async () => {
  const errors = [];
  let launches = 0;
  const code = await runCli(["connect"], {
    stderr: (value) => errors.push(value),
    readInstallation: async () => ({ extensionId: EXTENSION_ID, profileDirectory: "Profile 2" }),
    readSession: async () => ({ sessionId: SESSION_ID }),
    readSelection: async () => null,
    readConnections: async () => [],
    inspectRunning: () => "not_running",
    launch: async () => { launches += 1; throw new BridgeError("CHROME_START_FAILED", "private launch detail"); },
  });
  assert.equal(code, 1);
  assert.equal(launches, 1);
  assert.match(errors[0], /CHROME_START_FAILED/);
  assert.equal(errors[0].includes("private launch detail"), false);
});

test("profile-less connect never launches Chrome and asks the user to open the registered Chrome user", async () => {
  const errors = [];
  let launches = 0;
  const code = await runCli(["connect"], {
    stderr: (value) => errors.push(value),
    readInstallation: async () => ({ extensionId: EXTENSION_ID }),
    readSession: async () => ({ sessionId: SESSION_ID }),
    readSelection: async () => null,
    readConnections: async () => [],
    inspectRunning: () => "not_running",
    launch: async () => { launches += 1; },
    waitForLegacyBridge: async () => { throw new BridgeError("BRIDGE_DISCONNECTED", "ignored"); },
    connectionWaitMs: 100,
  });
  assert.equal(code, 1);
  assert.equal(launches, 0);
  assert.match(errors[0], /CHROME_PROFILE_REQUIRED/);
  assert.match(errors[0], /手动打开 Chrome/);
  assert.equal(errors[0].includes("install-bridge --profile"), false);

  launches = 0;
  assert.equal(await runCli(["connect"], {
    stderr: () => {},
    readInstallation: async () => ({ extensionId: EXTENSION_ID }),
    readSession: async () => ({ sessionId: SESSION_ID }),
    readSelection: async () => null,
    readConnections: async () => [],
    inspectRunning: () => "running",
    launch: async () => { launches += 1; },
    waitForLegacyBridge: async () => { throw new BridgeError("BRIDGE_DISCONNECTED", "ignored"); },
    connectionWaitMs: 1,
  }), 1);
  assert.equal(launches, 0);
});

test("CLI passes the same legacy probe to diagnostics and connection discovery", async () => {
  let received;
  let probes = 0;
  const waitForLegacyBridge = async () => { probes += 1; };
  const config = { extensionId: EXTENSION_ID };
  assert.equal(await runCli(["diagnose"], {
    stdout: () => {},
    readInstallation: async () => config,
    readSession: async () => ({ sessionId: SESSION_ID }),
    waitForLegacyBridge,
    diagnose: async (_request, dependencies) => { received = dependencies.waitForLegacyBridge; return {}; },
  }), 0);
  assert.equal(received, waitForLegacyBridge);

  const errors = [];
  assert.equal(await runCli(["connections"], {
    stderr: (value) => errors.push(value),
    readInstallation: async () => config,
    readSession: async () => ({ sessionId: SESSION_ID }),
    readConnections: async () => [{ instanceId: "423e4567-e89b-42d3-a456-426614174000", nativeProtocol: 1 }],
    waitForLegacyBridge,
  }), 1);
  assert.equal(probes, 1);
  assert.match(errors[0], /BRIDGE_PROTOCOL_UNSUPPORTED/);
});

test("missing local session registration gives repair guidance instead of an unavailable pairing code", async () => {
  const errors = [];
  const config = { profileDirectory: "Profile 2", extensionId: EXTENSION_ID };
  assert.equal(await runCli(["pairing-info"], {
    stderr: (value) => errors.push(value),
    readInstallation: async () => config,
    readSession: async () => null,
  }), 1);
  assert.match(errors[0], /重新运行 install-bridge/);
  assert.equal(errors[0].includes("pairing-info 获取"), false);

  errors.length = 0;
  assert.equal(await runCli(["connect"], {
    stderr: (value) => errors.push(value),
    readInstallation: async () => config,
    readSession: async () => null,
  }), 1);
  assert.match(errors[0], /修复桥接注册/);
  assert.equal(errors[0].includes("pairing-info"), false);
});
