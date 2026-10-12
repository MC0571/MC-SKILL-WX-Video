import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/skill-release.yml', import.meta.url), 'utf8');
const body = workflow.match(/- name: Create or verify Skill Release[\s\S]*?        run: \|\n([\s\S]*)$/)[1]
  .split('\n').map((line) => line.slice(10)).join('\n');
const version = '0.2.4';
const names = [
  `weixin-channels-video-skill-v${version}.tar.gz`,
  `weixin-channels-video-skill-v${version}.zip`,
  'SHA256SUMS',
];

async function runStep(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cws-skill-release-step-'));
  try {
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'dist/release'), { recursive: true });
    await mkdir(join(root, 'published'));
    const statePath = join(root, 'state.json');
    const initialAssets = names.filter((name) => !options.missingAssets?.includes(name));
    const state = {
      tagSha: options.tagSha ?? (options.tagMissing ? null : 'new-commit'),
      release: options.releaseMissing ? null : {
        isDraft: options.draft === true,
        isPrerelease: options.prerelease === true,
        assets: initialAssets,
      },
    };
    await writeFile(statePath, JSON.stringify(state));
    for (const name of names) {
      const bytes = `package:${name}`;
      await writeFile(join(root, 'dist/release', name), bytes);
      if (initialAssets.includes(name)) {
        await writeFile(join(root, 'published', name), options.mismatch === name ? 'different' : bytes);
      }
    }
    await writeFile(join(root, 'step.sh'), body);
    await writeFile(join(root, 'bin/git'), `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'ls-remote') process.exit(9);
const state = JSON.parse(readFileSync(process.env.MOCK_STATE, 'utf8'));
if (state.tagSha) process.stdout.write(state.tagSha + '\\trefs/tags/skill-v${version}\\n');
`);
    await writeFile(join(root, 'bin/gh'), `#!/usr/bin/env node
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + '\\n');
if (args[0] !== 'release') process.exit(9);
const statePath = process.env.MOCK_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
if (args[1] === 'view') {
  if (!state.release) process.exit(1);
  const fields = args[args.indexOf('--json') + 1];
  if (fields === 'isDraft,isPrerelease,assets') console.log(JSON.stringify({
    ...state.release,
    assets: state.release.assets.map((name) => ({ name })),
  }));
  else if (fields === 'assets') console.log(JSON.stringify({ assets: state.release.assets.map((name) => ({ name })) }));
} else if (args[1] === 'create') {
  const target = args[args.indexOf('--target') + 1];
  state.tagSha = target;
  state.release = { isDraft: false, isPrerelease: false, assets: [] };
  writeFileSync(statePath, JSON.stringify(state));
} else if (args[1] === 'download') {
  const name = args[args.indexOf('--pattern') + 1];
  if (!state.release.assets.includes(name)) process.exit(1);
  copyFileSync(join(process.env.MOCK_PUBLISHED, name), join(args[args.indexOf('--dir') + 1], name));
} else if (args[1] === 'upload') {
  const assetPath = args.at(-1);
  const name = basename(assetPath);
  if (state.release.assets.includes(name)) process.exit(1);
  copyFileSync(assetPath, join(process.env.MOCK_PUBLISHED, name));
  state.release.assets.push(name);
  writeFileSync(statePath, JSON.stringify(state));
} else process.exit(9);
`);
    await chmod(join(root, 'bin/git'), 0o755);
    await chmod(join(root, 'bin/gh'), 0o755);
    const result = spawnSync('bash', [join(root, 'step.sh')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'MC0571/weixin-channels-video',
        GITHUB_SHA: 'new-commit',
        VERSION: version,
        RUNNER_TEMP: root,
        MOCK_STATE: statePath,
        MOCK_LOG: join(root, 'gh.log'),
        MOCK_PUBLISHED: join(root, 'published'),
      },
    });
    const calls = await readFile(join(root, 'gh.log'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const finalState = JSON.parse(await readFile(statePath, 'utf8'));
    return { ...result, calls, finalState };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('Skill release workflow anchors a new tag to this commit and publishes all Skill assets', { skip: process.platform === 'win32' }, async () => {
  const result = await runStep({ tagMissing: true, releaseMissing: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.finalState.tagSha, 'new-commit');
  assert.deepEqual(result.finalState.release.assets.sort(), [...names].sort());
  assert.match(result.calls, /"create"/);
});

test('same-commit retry verifies existing assets and uploads only missing assets', { skip: process.platform === 'win32' }, async () => {
  const missing = names[1];
  const result = await runStep({ missingAssets: [missing] });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(result.finalState.release.assets.sort(), [...names].sort());
  assert.equal(result.calls.split('\n').filter((line) => line.includes('"upload"')).length, 1);
  assert.ok(result.calls.includes(missing));
});

for (const [reason, options] of Object.entries({
  'tag points at another commit': { tagSha: 'other-commit' },
  'existing asset differs': { mismatch: names[0] },
  'draft release': { draft: true },
  'prerelease': { prerelease: true },
})) {
  test(`Skill release refuses ${reason}`, { skip: process.platform === 'win32' }, async () => {
    const result = await runStep(options);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(result.calls.includes('"upload"'), false);
  });
}

test('automatic publishing distinguishes a first version file from a version bump', () => {
  assert.match(workflow, /EVENT_NAME" == "workflow_dispatch"/);
  assert.match(workflow, /git cat-file -e "\$EVENT_BEFORE:skills\/weixin-channels-video\/version\.json"/);
  assert.match(workflow, /release_allowed=false/);
  assert.match(workflow, /previous_version" != "\$version"/);
});
