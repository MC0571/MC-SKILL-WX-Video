#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PARSE_ERROR_MESSAGES } from "../../../src/core.mjs";
import { BRIDGE_ERROR_MESSAGES, isSafeRelativeMp4Filename, validateBridgeCommand } from "../../../src/native-messaging.mjs";
import { BridgeSetupError, installBridge, listBridgeProfiles, readBridgeConnections, readBridgeInstallation, readBridgeSelection, readBridgeSessionInfo, writeBridgeSelection } from "./bridge-install.mjs";
import { BridgeError, discoverBridgeConnections, requestBridge, selectBridgeConnection, waitForBridge } from "./bridge-client.mjs";
import { diagnoseEnvironment, inspectChromeRunning, launchChrome } from "./diagnostics.mjs";

const USAGE = "Usage: cli.mjs list-profiles | install-bridge --extension-id ID [--profile NAME] | pairing-info | diagnose [--profile NAME --extension-id ID] | connections | status | connect [--instance UUID] | parse --url URL | download --url URL [--filename RELATIVE.mp4]";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const ERROR_MESSAGES = Object.freeze({ ...PARSE_ERROR_MESSAGES, ...BRIDGE_ERROR_MESSAGES });
const CLI_VERSION = typeof __WCV_VERSION__ === "string" ? __WCV_VERSION__ : "unknown";
const BRIDGE_WAIT_MS = 90_000;

function cliBridgeError(code, stage, message) {
  const error = new BridgeError(code, message);
  error.cliStage = stage;
  return error;
}

function parseArguments(command, args) {
  const allowed = {
    "list-profiles": [],
    "install-bridge": ["extension-id", "profile"],
    "pairing-info": [],
    diagnose: ["profile", "extension-id"],
    connections: [],
    status: [],
    connect: ["instance"],
    parse: ["url"],
    download: ["url", "filename"],
  }[command];
  if (!allowed) throw new Error("USAGE");
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error("USAGE");
    const key = argument.slice(2);
    const value = args[index + 1];
    if (!allowed.includes(key) || options[key] !== undefined || !value || value.startsWith("--")) {
      throw new Error("USAGE");
    }
    options[key] = value;
    index += 1;
  }
  if (command === "install-bridge" && !options["extension-id"]) throw new Error("USAGE");
  if (command === "diagnose" && Boolean(options.profile) !== Boolean(options["extension-id"])) throw new Error("USAGE");
  if (command === "diagnose" && options["extension-id"] && !EXTENSION_ID_PATTERN.test(options["extension-id"])) throw new Error("USAGE");
  if (command === "connect" && options.instance && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(options.instance)) throw new Error("USAGE");
  if (["parse", "download"].includes(command) && !options.url) throw new Error("USAGE");
  if (options.filename && !isSafeRelativeMp4Filename(options.filename)) throw new Error("INVALID_FILENAME");
  return options;
}

async function activeConnections(config, sessionInfo, options) {
  return discoverBridgeConnections(config, sessionInfo, {
    readConnections: options.readConnections,
    request: options.bridgeRequest,
    waitForLegacyBridge: options.waitForLegacyBridge,
    refreshLogin: options.refreshLogin === true,
  });
}

async function selectConnection(config, sessionInfo, options) {
  const { connection } = await selectBridgeConnection(config, sessionInfo, {
    instanceId: options.instance,
    readConnections: options.readConnections,
    readSelection: options.readSelection,
    request: options.bridgeRequest,
    waitForLegacyBridge: options.waitForLegacyBridge,
    refreshLogin: options.refreshLogin === true,
  });
  return connection;
}

async function ensureBridgeConnection(config, sessionInfo, options) {
  const first = await selectConnection(config, sessionInfo, options);
  if (first) return first;
  const running = options.inspectRunning();
  if (running === "unknown") throw new BridgeError("CHROME_STATUS_UNAVAILABLE", "无法确认 Chrome 是否正在运行；请检查本机进程检测权限后重试。");
  if (running === "not_running") await options.launch(config);
  const deadline = Date.now() + (options.connectionWaitMs ?? BRIDGE_WAIT_MS);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (Date.now() < deadline) {
    await sleep(Math.min(1_000, deadline - Date.now()));
    const active = await selectConnection(config, sessionInfo, options);
    if (active) return active;
  }
  if (!config.profileDirectory) {
    throw cliBridgeError("BRIDGE_TIMEOUT", "bridge", "请在日常使用的 Chrome 中启用扩展后重试；如果已绑定实例，请在对应 Chrome 用户中启动扩展。");
  }
  throw new BridgeError("BRIDGE_TIMEOUT", BRIDGE_ERROR_MESSAGES.BRIDGE_TIMEOUT);
}

export async function runCli(argv, {
  stdout = (value) => process.stdout.write(`${value}\n`),
  stderr = (value) => process.stderr.write(`${value}\n`),
  launch = launchChrome,
  install = installBridge,
  listProfiles = listBridgeProfiles,
  readInstallation = readBridgeInstallation,
  readSession = readBridgeSessionInfo,
  readConnections = readBridgeConnections,
  readSelection = readBridgeSelection,
  writeSelection = writeBridgeSelection,
  inspectRunning = inspectChromeRunning,
  bridgeRequest = requestBridge,
  waitForLegacyBridge = waitForBridge,
  connectionWaitMs,
  sleep,
  diagnose = diagnoseEnvironment,
} = {}) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    stdout(USAGE);
    return 0;
  }

  let options;
  try { options = parseArguments(command, args); }
  catch (error) {
    if (error.message === "INVALID_FILENAME") {
      stderr("Filename must be a safe relative .mp4 path.");
      return 2;
    }
    stderr(USAGE);
    return 2;
  }

  try {
    if (command === "list-profiles") {
      const profiles = await listProfiles();
      for (const profile of profiles) stdout(JSON.stringify(profile));
      return 0;
    }
    if (command === "install-bridge") {
      const result = await install({ extensionId: options["extension-id"], profile: options.profile });
      stdout(JSON.stringify({ installed: true, profile: result.profile?.name ?? null, extensionId: result.config.extensionId, versions: { cli: CLI_VERSION, host: "unknown", extension: "unknown" } }));
      return 0;
    }

    if (command === "pairing-info") {
      const config = await readInstallation();
      if (!config) throw new BridgeError("BRIDGE_NOT_CONFIGURED", BRIDGE_ERROR_MESSAGES.BRIDGE_NOT_CONFIGURED);
      const sessionInfo = await readSession(config);
      if (!sessionInfo) throw cliBridgeError("BRIDGE_CONFIG_INVALID", "resource", "本地桥接注册信息缺失或损坏。请重新运行 install-bridge 修复桥接注册。");
      stdout(JSON.stringify({ sessionId: sessionInfo.sessionId }));
      return 0;
    }

    if (command === "diagnose") {
      if (options.profile && options["extension-id"]) {
        const result = await diagnose({
          configuration: "unconfigured",
          candidate: { profile: options.profile, extensionId: options["extension-id"] },
        }, { waitForLegacyBridge, includeRuntime: true });
        stdout(JSON.stringify(result));
        return 0;
      }
      let config;
      let configuration = "unconfigured";
      try {
        config = await readInstallation();
        if (config) configuration = "configured";
      } catch {
        configuration = "invalid";
      }
      let sessionInfo;
      if (config) {
        try { sessionInfo = await readSession(config); }
        catch { sessionInfo = null; }
      }
      const result = await diagnose({ configuration, config, sessionInfo }, {
        waitForLegacyBridge,
        readConnections,
        readSelection,
        bridgeRequest,
        includeRuntime: true,
      });
      stdout(JSON.stringify(result));
      return 0;
    }

    const config = await readInstallation();
    if (!config) {
      if (command === "connections") { stdout("[]"); return 0; }
      if (command === "status") {
        stdout(JSON.stringify({ configuration: "unconfigured", connection: "disconnected", login: "not_checked", versions: { cli: CLI_VERSION, host: "unknown", extension: "unknown" } }));
        return 0;
      }
      throw new BridgeError("BRIDGE_NOT_CONFIGURED", BRIDGE_ERROR_MESSAGES.BRIDGE_NOT_CONFIGURED);
    }
    const sessionInfo = await readSession(config);

    const connectionOptions = {
      readConnections, readSelection, bridgeRequest, waitForLegacyBridge, launch, inspectRunning,
      ...(connectionWaitMs === undefined ? {} : { connectionWaitMs }),
      ...(sleep ? { sleep } : {}),
      ...(command === "connect" && options.instance ? { instance: options.instance } : {}),
      refreshLogin: ["status", "parse", "download"].includes(command),
    };

    if (command === "connections") {
      stdout(JSON.stringify(sessionInfo ? await activeConnections(config, sessionInfo, connectionOptions) : []));
      return 0;
    }

    if (command === "status") {
      const writeStatus = (values, versions = {}) => stdout(JSON.stringify({
        ...values,
        versions: { cli: CLI_VERSION, host: versions.host ?? "unknown", extension: versions.extension ?? "unknown" },
      }));
      if (!sessionInfo) {
        writeStatus({ configuration: "configured", connection: "disconnected", login: "not_checked" });
        return 0;
      }
      try {
        const connection = await selectConnection(config, sessionInfo, connectionOptions);
        if (!connection) {
          writeStatus({ configuration: "configured", connection: "disconnected", login: "not_checked" });
          return 0;
        }
        writeStatus({ configuration: "configured", connection: "connected", login: connection.login, instanceId: connection.instanceId, checkedAt: connection.checkedAt, ...(connection.error ? { error: connection.error } : {}) }, connection.versions);
      } catch (error) {
        const code = error instanceof BridgeError ? error.code : "BRIDGE_PROTOCOL_ERROR";
        if (code === "BRIDGE_PROFILE_AMBIGUOUS") {
          writeStatus({
            configuration: "configured",
            connection: `failed:${code}`,
            login: "not_checked",
            error: code,
            message: ERROR_MESSAGES[code],
            nextAction: "connect --instance <UUID>",
          });
          return 1;
        }
        if (code === "BRIDGE_DISCONNECTED") {
          writeStatus({ configuration: "configured", connection: "disconnected", login: "not_checked" });
          return 0;
        }
        writeStatus({ configuration: "configured", connection: `failed:${code}`, login: "not_checked" });
        return 1;
      }
      return 0;
    }

    if (command === "connect") {
      if (!sessionInfo) throw cliBridgeError("BRIDGE_CONFIG_INVALID", "resource", "本地桥接注册信息缺失或损坏。请重新运行 install-bridge 修复桥接注册。");
      const connection = await ensureBridgeConnection(config, sessionInfo, connectionOptions);
      if (options.instance) await writeSelection(config, sessionInfo, options.instance);
      stdout("Connected to the Chrome extension.");
      return 0;
    }

    if (command === "parse" || command === "download") {
      if (!sessionInfo) throw new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED);
      const connection = await ensureBridgeConnection(config, sessionInfo, connectionOptions);
      if (connection.login !== "authenticated") {
        const code = connection.login === "anonymous" ? "AUTH_EXPIRED" : "LOGIN_CHECK_FAILED";
        throw new BridgeError(code, ERROR_MESSAGES[code]);
      }
      const request = command === "parse"
        ? { id: randomUUID(), command, url: options.url }
        : {
            id: randomUUID(),
            command,
            url: options.url,
            ...(options.filename ? { filename: options.filename } : {}),
          };
      if (!validateBridgeCommand(request)) throw new BridgeError("INVALID_COMMAND", BRIDGE_ERROR_MESSAGES.INVALID_COMMAND);
      const timeoutMs = command === "download" ? 31 * 60_000 : 90_000;
      let result;
      try { result = await bridgeRequest(config, sessionInfo, request, { timeoutMs, instanceId: connection.instanceId }); }
      catch (error) {
        if (command === "download" && error instanceof BridgeError && error.details) {
          stdout(JSON.stringify(error.details));
          return 1;
        }
        throw error;
      }
      stdout(JSON.stringify(result));
      if (command === "download" && result.state === "interrupted") return 1;
      return 0;
    }
  } catch (error) {
    const code = error instanceof BridgeError || error instanceof BridgeSetupError
      ? error.code
      : command === "install-bridge" || command === "list-profiles" ? "BRIDGE_INSTALL_FAILED" : "BRIDGE_CONFIG_INVALID";
    const message = error instanceof BridgeSetupError
      ? error.message
      : error instanceof BridgeError && error.cliStage ? error.message
      : ERROR_MESSAGES[code] ?? "请求失败。";
    const stage = error instanceof BridgeError && error.cliStage ? error.cliStage :
      command === "install-bridge" || command === "list-profiles" || command === "pairing-info" ? "resource" :
      code.startsWith("CHROME_") ? "launch" :
        code === "LOGIN_CHECK_FAILED" ? "login-check" :
          ["BRIDGE_TIMEOUT", "BRIDGE_DISCONNECTED", "BRIDGE_CONNECTION_FAILED", "BRIDGE_SESSION_MISMATCH"].includes(code) ? "bridge-authentication" : "bridge";
    stderr(`${stage} ${code}: ${message}`);
    return 1;
  }

  stderr(USAGE);
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stderr.write("Command failed.\n");
    process.exitCode = 1;
  });
}
