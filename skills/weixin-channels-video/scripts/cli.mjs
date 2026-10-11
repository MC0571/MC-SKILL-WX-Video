#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PARSE_ERROR_MESSAGES } from "../../../src/core.mjs";
import { BRIDGE_ERROR_MESSAGES, isSafeRelativeMp4Filename, validateBridgeCommand } from "../../../src/native-messaging.mjs";
import { BridgeSetupError, installBridge, listBridgeProfiles, readBridgeInstallation, readBridgeSessionInfo } from "./bridge-install.mjs";
import { BridgeError, requestBridge, waitForBridge } from "./bridge-client.mjs";
import { diagnoseEnvironment, launchChrome } from "./diagnostics.mjs";

const USAGE = "Usage: cli.mjs list-profiles | install-bridge --extension-id ID [--profile NAME] | pairing-info | diagnose [--profile NAME --extension-id ID] | status | connect | parse --url URL | download --url URL [--filename RELATIVE.mp4]";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const ERROR_MESSAGES = Object.freeze({ ...PARSE_ERROR_MESSAGES, ...BRIDGE_ERROR_MESSAGES });
const CLI_VERSION = typeof __WCV_VERSION__ === "string" ? __WCV_VERSION__ : "unknown";
const BRIDGE_WAIT_MS = 30_000;

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
    status: [],
    connect: [],
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
  if (["parse", "download"].includes(command) && !options.url) throw new Error("USAGE");
  if (options.filename && !isSafeRelativeMp4Filename(options.filename)) throw new Error("INVALID_FILENAME");
  return options;
}

async function ensureBridgeConnection(config, sessionInfo, { launch, bridgeWait }) {
  try {
    await bridgeWait(config, sessionInfo, { timeoutMs: 500 });
    return;
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== "BRIDGE_TIMEOUT") throw error;
  }

  if (!config.profileDirectory) {
    try {
      await bridgeWait(config, sessionInfo, { timeoutMs: BRIDGE_WAIT_MS });
      return;
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "BRIDGE_TIMEOUT") throw error;
      throw cliBridgeError("BRIDGE_TIMEOUT", "pairing", "等待扩展手动配对超时。请运行 pairing-info，将 sessionId 填入扩展 Agent 设置，然后重新运行 connect。");
    }
  }

  await launch(config, sessionInfo?.sessionId);
  try { await bridgeWait(config, sessionInfo, { timeoutMs: BRIDGE_WAIT_MS }); }
  catch (error) {
    if (error instanceof BridgeError && error.code === "BRIDGE_TIMEOUT") {
      throw cliBridgeError("BRIDGE_TIMEOUT", "pairing", "Chrome 启动请求已提交，但尚未收到扩展连接握手。请手动打开日常使用的 Chrome，并确认所选用户已启用扩展；若自动配对页未打开，运行 pairing-info，将 sessionId 填入扩展 Agent 设置，再重新运行 connect 或 status。");
    }
    throw error;
  }
}

export async function runCli(argv, {
  stdout = (value) => process.stdout.write(`${value}\n`),
  stderr = (value) => process.stderr.write(`${value}\n`),
  launch = launchChrome,
  install = installBridge,
  listProfiles = listBridgeProfiles,
  readInstallation = readBridgeInstallation,
  readSession = readBridgeSessionInfo,
  bridgeRequest = requestBridge,
  bridgeWait = waitForBridge,
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
      if (!sessionInfo) throw cliBridgeError("BRIDGE_CONFIG_INVALID", "resource", "本地配对信息缺失。请重新运行 install-bridge 注册桥接，再运行 pairing-info。");
      stdout(JSON.stringify({ sessionId: sessionInfo.sessionId }));
      return 0;
    }

    if (command === "diagnose") {
      if (options.profile && options["extension-id"]) {
        const result = await diagnose({
          configuration: "unconfigured",
          candidate: { profile: options.profile, extensionId: options["extension-id"] },
        }, { bridgeWait, includeRuntime: true });
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
      const result = await diagnose({ configuration, config, sessionInfo }, { bridgeWait, includeRuntime: true });
      stdout(JSON.stringify(result));
      return 0;
    }

    const config = await readInstallation();
    if (!config) {
      if (command === "status") {
        stdout(JSON.stringify({ configuration: "unconfigured", connection: "disconnected", login: "not_checked", versions: { cli: CLI_VERSION, host: "unknown", extension: "unknown" } }));
        return 0;
      }
      throw new BridgeError("BRIDGE_NOT_CONFIGURED", BRIDGE_ERROR_MESSAGES.BRIDGE_NOT_CONFIGURED);
    }
    const sessionInfo = await readSession(config);

    if (command === "status") {
      const writeStatus = (values, versions = {}) => stdout(JSON.stringify({
        ...values,
        versions: { cli: CLI_VERSION, host: versions.host ?? "unknown", extension: versions.extension ?? "unknown" },
      }));
      if (!sessionInfo) {
        writeStatus({ configuration: "configured", connection: "disconnected", login: "not_checked" });
        return 0;
      }
      const id = randomUUID();
      try {
        const result = await bridgeRequest(config, sessionInfo, { id, command: "status" }, { timeoutMs: 30_000 });
        if (!["authenticated", "anonymous"].includes(result?.login)) throw new BridgeError("BRIDGE_PROTOCOL_ERROR", "ignored");
        writeStatus({ configuration: "configured", connection: "connected", login: result.login }, result.versions);
      } catch (error) {
        if (error instanceof BridgeError && error.code === "LOGIN_CHECK_FAILED") {
          writeStatus({ configuration: "configured", connection: "connected", login: "failed:LOGIN_CHECK_FAILED" });
          return 1;
        }
        const code = error instanceof BridgeError ? error.code : "BRIDGE_PROTOCOL_ERROR";
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
      if (!sessionInfo) throw cliBridgeError("BRIDGE_CONFIG_INVALID", "resource", "本地配对信息缺失。请重新运行 install-bridge 注册桥接，再运行 pairing-info 获取 sessionId。");
      await ensureBridgeConnection(config, sessionInfo, { launch, bridgeWait });
      stdout("Connected to the Chrome extension.");
      return 0;
    }

    if (command === "parse" || command === "download") {
      if (!sessionInfo) throw new BridgeError("BRIDGE_DISCONNECTED", BRIDGE_ERROR_MESSAGES.BRIDGE_DISCONNECTED);
      await ensureBridgeConnection(config, sessionInfo, { launch, bridgeWait });
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
      try { result = await bridgeRequest(config, sessionInfo, request, { timeoutMs }); }
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
