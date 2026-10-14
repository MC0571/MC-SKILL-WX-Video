import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MIN_NODE_VERSION, RUNTIME_PROTOCOL } from '../skills/weixin-channels-video/scripts/runtime-support.mjs';

const execFileAsync = promisify(execFile);

const root = fileURLToPath(new URL('../', import.meta.url));
const skill = join(root, 'skills/weixin-channels-video');
const dist = join(root, 'dist');
const extensionSource = join(root, 'extension');
const extensionOutput = join(dist, 'extension');
const skillOutput = join(dist, 'weixin-channels-video');
const releaseOutput = join(dist, 'release');
const releasePackage = process.argv.includes('--release');
const componentIndex = process.argv.indexOf('--component');
const releaseComponent = componentIndex < 0 ? 'both' : process.argv[componentIndex + 1];
if (!['both', 'extension', 'skill'].includes(releaseComponent)) throw new Error('Invalid release component.');
const buildExtension = releaseComponent === 'both' || releaseComponent === 'extension';
const buildSkill = releaseComponent === 'both' || releaseComponent === 'skill';

const EXTENSION_ASSETS = [
  'manifest.json',
  'index.html',
  'styles.css',
  'background.js',
  'agent.js',
  'agent.css',
  'offscreen.html',
  'offscreen.js',
  'yuanbao-frame.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'icons/optional/icon24.png',
  'icons/copy.svg',
  'icons/terminal.svg',
  'icons/github.svg',
  'icons/new.gif',
  'icons/new-static.png',
  'icons/Noto-Emoji-LICENSE.txt',
  'icons/agents/codex.png',
  'icons/agents/chatgpt.svg',
  'icons/agents/claude.svg',
  'icons/agents/workbuddy.svg',
  'icons/agents/doubao-work.png',
  'icons/agents/qwen-work.png',
  'icons/agents/trae.png',
];

const manifest = buildExtension
  ? JSON.parse(await readFile(join(extensionSource, 'manifest.json'), 'utf8'))
  : null;
const skillVersion = buildSkill
  ? JSON.parse(await readFile(join(skill, 'version.json'), 'utf8')).version
  : null;
if (manifest) validateChromeVersion(manifest.version);
if (skillVersion) validateChromeVersion(skillVersion);

if (buildSkill) {
  await rm(skillOutput, { recursive: true, force: true });
  await mkdir(join(skillOutput, 'scripts'), { recursive: true });
  await cp(join(skill, 'SKILL.md'), join(skillOutput, 'SKILL.md'));
  await cp(join(skill, 'version.json'), join(skillOutput, 'version.json'));
  await cp(join(root, 'LICENSE'), join(skillOutput, 'LICENSE'));
  await cp(join(root, 'NOTICE.md'), join(skillOutput, 'NOTICE.md'));
  await cp(join(skill, 'scripts/run.mjs'), join(skillOutput, 'scripts/run.mjs'));
  await cp(join(skill, 'scripts/runtime-support.mjs'), join(skillOutput, 'scripts/runtime-support.mjs'));
  await cp(join(skill, 'scripts/windows-security.mjs'), join(skillOutput, 'scripts/windows-security.mjs'));
  try {
    await access(join(skill, 'references'));
    await cp(join(skill, 'references'), join(skillOutput, 'references'), { recursive: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(join(skillOutput, 'runtime.json'), `${JSON.stringify({
    version: skillVersion,
    runtimeProtocol: RUNTIME_PROTOCOL,
    minimumNodeVersion: MIN_NODE_VERSION,
  }, null, 2)}\n`);
  await build({
    entryPoints: [join(skill, 'scripts/cli.mjs')],
    outfile: join(skillOutput, 'scripts/cli.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    define: { __WCV_VERSION__: JSON.stringify(skillVersion) },
  });
  await build({
    entryPoints: [join(root, 'src/native-host.mjs')],
    outfile: join(skillOutput, 'scripts/native-host.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    define: { __WCV_VERSION__: JSON.stringify(skillVersion) },
  });
}

if (buildExtension) {
  await rm(extensionOutput, { recursive: true, force: true });
  await build({
    entryPoints: [join(extensionSource, 'background.mjs')],
    outfile: join(extensionSource, 'background.js'),
    bundle: true, platform: 'browser', format: 'esm', target: 'chrome116',
  });
  await build({
    entryPoints: [join(extensionSource, 'agent.mjs')],
    outfile: join(extensionSource, 'agent.js'),
    bundle: true, platform: 'browser', format: 'esm', target: 'chrome116',
  });
  await build({
    entryPoints: [join(extensionSource, 'offscreen.mjs')],
    outfile: join(extensionSource, 'offscreen.js'),
    bundle: true, platform: 'browser', format: 'esm', target: 'chrome116',
  });
  await rm(join(extensionSource, 'app.js'), { force: true });
  await copyExtensionAssets(extensionOutput);
  await cp(join(root, 'LICENSE'), join(extensionOutput, 'LICENSE'));
  await cp(join(root, 'NOTICE.md'), join(extensionOutput, 'NOTICE.md'));
  const uiLicenses = [
    '@shoelace-style/shoelace/LICENSE.md',
    '@shoelace-style/localize/LICENSE.md',
    'lit/LICENSE',
    'lit-element/LICENSE',
    'lit-html/LICENSE',
    '@lit/reactive-element/LICENSE',
    '@floating-ui/dom/LICENSE',
    '@floating-ui/core/LICENSE',
    '@floating-ui/utils/LICENSE',
    'composed-offset-position/LICENSE.md',
  ];
  const licenses = await Promise.all(uiLicenses.map(async (path) =>
    `${path}\n\n${await readFile(join(root, 'node_modules', path), 'utf8')}`));
  await writeFile(join(extensionOutput, 'THIRD_PARTY_LICENSES.txt'), `${licenses.join('\n\n')}\n`);
}

if (releasePackage) {
  await rm(releaseOutput, { recursive: true, force: true });
  const { stdout, stderr } = await execFileAsync('python3', [
    join(root, 'scripts/package-release.py'),
    '--output-dir', releaseOutput, '--component', releaseComponent,
  ], { cwd: root });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} else {
  console.log('Built standalone Skill and Chrome extension in dist/.');
}

async function copyExtensionAssets(destination) {
  await mkdir(destination, { recursive: true });
  for (const file of EXTENSION_ASSETS) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(extensionSource, file), target);
  }
}

function validateChromeVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(version)) {
    throw new Error(`Invalid Chrome extension version: ${String(version)}`);
  }
  if (version.split('.').some(part => Number(part) > 65535)) {
    throw new Error(`Chrome extension version components must be at most 65535: ${version}`);
  }
}
