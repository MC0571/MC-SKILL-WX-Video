import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { MIN_NODE_VERSION, RUNTIME_PROTOCOL } from "../skills/weixin-channels-video/scripts/runtime-support.mjs";
import { windowsPowerShellBuiltinModuleImport, windowsPowerShellPath } from "../skills/weixin-channels-video/scripts/windows-security.mjs";

const version = JSON.parse(await readFile(new URL("../skills/weixin-channels-video/version.json", import.meta.url), "utf8")).version;
const archive = resolve(process.argv[2] ?? join("dist", "release", `weixin-channels-video-skill-v${version}.zip`));
const root = await mkdtemp(join(tmpdir(), "wcv-release-zip-"));
const destination = join(root, "unpacked");
const env = { ...process.env };

try {
  let unpack;
  if (process.platform === "win32") {
    env.LOCALAPPDATA = join(root, "LocalAppData");
    await mkdir(env.LOCALAPPDATA);
    const command = String.raw`
$ErrorActionPreference = 'Stop'
try {
  ${windowsPowerShellBuiltinModuleImport("Microsoft.PowerShell.Utility")}
  [void](Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop -WarningAction Stop)
  [System.IO.Compression.ZipFile]::ExtractToDirectory($env:WCV_RELEASE_ARCHIVE, $env:WCV_RELEASE_DESTINATION)
} catch { exit 1 }
`;
    unpack = spawnSync(windowsPowerShellPath(env), ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...env, WCV_RELEASE_ARCHIVE: archive, WCV_RELEASE_DESTINATION: destination }, timeout: 15_000,
    });
  } else {
    env.HOME = join(root, "home");
    await mkdir(destination);
    unpack = spawnSync("unzip", ["-q", archive, "-d", destination], { timeout: 15_000 });
  }
  assert.equal(unpack.status, 0, "Skill ZIP must extract with the platform archive tool");
  const skill = join(destination, "weixin-channels-video");
  assert.match(await readFile(join(skill, "SKILL.md"), "utf8"), /^---/);
  assert.equal(JSON.parse(await readFile(join(skill, "version.json"), "utf8")).version, version);
  await readFile(join(skill, "references", "agent-installation.md"));
  assert.equal(existsSync(join(skill, "assets", "extension")), false);
  process.stdout.write("Release Skill ZIP extraction passed.\n");
  if (process.platform === "darwin" || process.platform === "win32") {
    const prepared = spawnSync(process.execPath, [join(skill, "scripts", "run.mjs"), "prepare"], {
      encoding: "utf8", env, timeout: 120_000,
    });
    assert.equal(prepared.status, 0, "Extracted Skill ZIP must prepare without the source repository");
    const result = JSON.parse(prepared.stdout);
    assert.equal(result.minimumNodeVersion, MIN_NODE_VERSION);
    assert.equal(result.runtimeProtocol, RUNTIME_PROTOCOL);
    assert.deepEqual(Object.keys(result).sort(), ["minimumNodeVersion", "runtimeCLI", "runtimeProtocol", "version"]);
    await readFile(result.runtimeCLI);
    process.stdout.write("Extracted Skill standalone preparation passed.\n");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
