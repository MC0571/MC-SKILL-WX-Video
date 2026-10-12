import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { assertWindowsPrivatePath } from "../skills/weixin-channels-video/scripts/windows-security.mjs";

const packageRoot = join(process.cwd(), "dist", "weixin-channels-video");
const runner = join(packageRoot, "scripts", "run.mjs");
const sourceRunner = join(process.cwd(), "skills", "weixin-channels-video", "scripts", "run.mjs");
const tempRoot = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "wcv-smoke-"));
const env = { ...process.env };

if (process.platform === "win32") env.LOCALAPPDATA = join(tempRoot, "LocalAppData");
else env.HOME = join(tempRoot, "home");

function invoke(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
}

function prepare(script = runner) {
  const result = invoke(script, ["prepare"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function assertPrivateTree(path) {
  if (process.platform !== "win32") return;
  await assertWindowsPrivatePath(path, { directory: true });
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const info = await lstat(child);
    if (info.isDirectory()) await assertPrivateTree(child);
    else await assertWindowsPrivatePath(child);
  }
}

try {
  if (process.platform === "win32") await mkdir(env.LOCALAPPDATA);
  const first = prepare();
  assert.equal(first.minimumNodeVersion, "22.22.2");
  assert.equal(first.runtimeProtocol, 3);
  assert.deepEqual(Object.keys(first).sort(), ["minimumNodeVersion", "runtimeCLI", "runtimeProtocol", "version"]);
  const cacheRoot = dirname(dirname(dirname(first.runtimeCLI)));
  if (process.platform === "win32") {
    await assertWindowsPrivatePath(join(cacheRoot, "current.json"));
  }
  const marker = JSON.parse(await readFile(join(cacheRoot, "current.json"), "utf8"));
  assert.deepEqual(Object.keys(marker).sort(), ["packageHash", "runtimeProtocol", "version"]);
  assert.match(marker.packageHash, /^[a-f0-9]{64}$/);
  const cachedRuntime = join(cacheRoot, marker.version + "-package-" + marker.packageHash);
  if (process.platform === "win32") await assertPrivateTree(cachedRuntime);
  assert.ok(existsSync(join(cachedRuntime, "runtime.json")));
  assert.ok(existsSync(join(cachedRuntime, "scripts", "cli.mjs")));
  assert.ok(existsSync(join(cachedRuntime, "scripts", "native-host.mjs")));
  assert.equal(existsSync(join(cachedRuntime, "assets")), false);
  const preservedFile = join(cachedRuntime, "existing-cache-data");
  await writeFile(preservedFile, "keep");

  const sourceCommand = spawnSync(process.execPath, [sourceRunner, "help"], { encoding: "utf8", env });
  assert.equal(sourceCommand.status, 0, sourceCommand.stderr || sourceCommand.stdout);
  assert.match(sourceCommand.stdout, /^Usage: cli\.mjs/m);

  const second = prepare();
  assert.equal(second.runtimeCLI, first.runtimeCLI);
  assert.equal(await readFile(preservedFile, "utf8"), "keep");

  const candidateRoot = join(tempRoot, "candidate-package");
  await cp(packageRoot, candidateRoot, { recursive: true });
  const candidateRunner = join(candidateRoot, "scripts", "run.mjs");
  const candidateCLI = join(candidateRoot, "scripts", "cli.mjs");
  const candidateHost = join(candidateRoot, "scripts", "native-host.mjs");
  const originalCLI = await readFile(candidateCLI, "utf8");
  const candidateCLIContents = originalCLI
    .replace(/^var USAGE = .*;$/m, 'var USAGE = "Candidate runtime CLI";')
    .replace(/^var CLI_VERSION = .*;$/m, 'var CLI_VERSION = "candidate-runtime";');
  assert.notEqual(candidateCLIContents, originalCLI);
  await writeFile(candidateCLI, candidateCLIContents);
  const hostMarker = "\n// candidate runtime host\n";
  await writeFile(candidateHost, (await readFile(candidateHost, "utf8")) + hostMarker);

  const candidate = prepare(candidateRunner);
  assert.deepEqual(Object.keys(candidate).sort(), ["minimumNodeVersion", "runtimeCLI", "runtimeProtocol", "version"]);
  assert.notEqual(candidate.runtimeCLI, first.runtimeCLI);
  const candidateMarkerText = await readFile(join(cacheRoot, "current.json"), "utf8");
  const candidateMarker = JSON.parse(candidateMarkerText);
  assert.deepEqual(Object.keys(candidateMarker).sort(), ["packageHash", "runtimeProtocol", "version"]);
  const candidateCache = join(cacheRoot, candidateMarker.version + "-package-" + candidateMarker.packageHash);
  assert.equal(candidate.runtimeCLI, join(candidateCache, "scripts", "cli.mjs"));
  assert.ok(existsSync(join(cachedRuntime, "runtime.json")));
  const candidatePreservedFile = join(candidateCache, "existing-cache-data");
  await writeFile(candidatePreservedFile, "keep candidate");

  const sourceCandidateCommand = invoke(sourceRunner, ["help"]);
  assert.equal(sourceCandidateCommand.status, 0, sourceCandidateCommand.stderr || sourceCandidateCommand.stdout);
  assert.equal(sourceCandidateCommand.stdout.trim(), "Candidate runtime CLI");

  const candidateAgain = prepare(candidateRunner);
  assert.equal(candidateAgain.runtimeCLI, candidate.runtimeCLI);
  assert.equal(await readFile(candidatePreservedFile, "utf8"), "keep candidate");

  if (process.platform === "darwin") {
    const bridgeInstall = invoke(sourceRunner, ["install-bridge", "--extension-id", "a".repeat(32)]);
    assert.equal(bridgeInstall.status, 0, bridgeInstall.stderr || bridgeInstall.stdout);
    assert.equal(JSON.parse(bridgeInstall.stdout).versions.cli, "candidate-runtime");
    const appSupport = join(env.HOME, "Library", "Application Support", "weixin-channels-video");
    assert.equal(await readFile(join(appSupport, "native-host.mjs"), "utf8"), await readFile(candidateHost, "utf8"));
  }

  const cachedCandidateCLI = join(candidateCache, "scripts", "cli.mjs");
  const validCachedCLI = await readFile(cachedCandidateCLI);
  await writeFile(cachedCandidateCLI, Buffer.concat([validCachedCLI, Buffer.from("\n// tampered\n")]));
  const tamperedSourceCommand = invoke(sourceRunner, ["help"]);
  assert.notEqual(tamperedSourceCommand.status, 0);
  assert.match(tamperedSourceCommand.stderr, /缓存内容校验失败/);
  assert.equal(await readFile(join(cacheRoot, "current.json"), "utf8"), candidateMarkerText);
  assert.ok(existsSync(join(cachedRuntime, "runtime.json")));
  await writeFile(cachedCandidateCLI, validCachedCLI);

  const brokenRoot = join(tempRoot, "broken-package");
  await cp(candidateRoot, brokenRoot, { recursive: true });
  await rm(join(brokenRoot, "scripts", "native-host.mjs"));
  const failedPrepare = invoke(join(brokenRoot, "scripts", "run.mjs"), ["prepare"]);
  assert.notEqual(failedPrepare.status, 0);
  assert.equal(await readFile(join(cacheRoot, "current.json"), "utf8"), candidateMarkerText);
  assert.ok(existsSync(join(candidateCache, "runtime.json")));
  assert.equal(await readFile(candidatePreservedFile, "utf8"), "keep candidate");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
