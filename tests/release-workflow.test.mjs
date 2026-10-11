import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const body = workflow.match(/- name: Create or verify GitHub Release[\s\S]*?        run: \|\n([\s\S]*?)\n      - uses: google-github-actions\/auth/)[1]
  .split('\n').map((line) => line.slice(10)).join('\n');
const names = [
  'weixin-channels-video-extension-v0.2.1.zip',
  'weixin-channels-video-skill-v0.2.1.tar.gz',
  'weixin-channels-video-skill-v0.2.1.zip',
  'SHA256SUMS',
];

async function runStep(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cws-release-step-'));
  try {
    await mkdir(join(root, 'bin'));
    await mkdir(join(root, 'dist/release'), { recursive: true });
    await mkdir(join(root, 'published'));
    for (const name of names) {
      await writeFile(join(root, 'dist/release', name), name);
      await writeFile(join(root, 'published', name), options.mismatch && name === names[0] ? 'different' : name);
    }
    await writeFile(join(root, 'step.sh'), body);
    await writeFile(join(root, 'bin/git'), '#!/bin/sh\n[ "$1" = "ls-remote" ] || exit 9\n[ "$MOCK_MISSING_TAG" = "true" ] || printf "old-commit\\trefs/tags/v0.2.1\\n"\n');
    await writeFile(join(root, 'bin/gh'), `#!/usr/bin/env node
import { appendFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + '\\n');
if (args[0] !== 'release') process.exit(9);
if (args[1] === 'view') {
  if (process.env.MOCK_MISSING_RELEASE === 'true') process.exit(1);
  const json = args[args.indexOf('--json') + 1];
  if (json === 'isDraft,isPrerelease') console.log(JSON.stringify({ isDraft: process.env.MOCK_DRAFT === 'true', isPrerelease: process.env.MOCK_PRERELEASE === 'true' }));
  if (json === 'assets') console.log(JSON.stringify({ assets: ${JSON.stringify(names)}.filter((name) => !(process.env.MOCK_MISSING_ASSET === 'true' && name === ${JSON.stringify(names[0])})).map((name) => ({ name })) }));
} else if (args[1] === 'download') {
  const name = args[args.indexOf('--pattern') + 1];
  copyFileSync(join(process.env.MOCK_PUBLISHED, name), join(args[args.indexOf('--dir') + 1], name));
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
        GITHUB_SHA: 'new-maintenance-commit',
        VERSION: '0.2.1',
        SUBMIT_EXISTING_RELEASE: String(options.existing !== false),
        RUNNER_TEMP: root,
        MOCK_LOG: join(root, 'gh.log'),
        MOCK_PUBLISHED: join(root, 'published'),
        MOCK_MISSING_TAG: String(options.missingTag === true),
        MOCK_MISSING_RELEASE: String(options.missingRelease === true),
        MOCK_MISSING_ASSET: String(options.missingAsset === true),
        MOCK_DRAFT: String(options.draft === true),
        MOCK_PRERELEASE: String(options.prerelease === true),
      },
    });
    const calls = await readFile(join(root, 'gh.log'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    assert.ok(!calls.includes('"create"') && !calls.includes('"upload"'), calls);
    return { ...result, calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('existing-release mode compares all immutable assets from an earlier commit', { skip: process.platform === 'win32' }, async () => {
  const result = await runStep();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.calls.split('\n').filter((line) => line.includes('"download"')).length, names.length);
});

for (const [name, options] of Object.entries({
  'missing tag': { missingTag: true },
  'missing release': { missingRelease: true },
  'missing asset': { missingAsset: true },
  'changed asset': { mismatch: true },
  'draft release': { draft: true },
  'prerelease': { prerelease: true },
  'different tag commit in normal mode': { existing: false },
})) {
  test(`release verification refuses ${name}`, { skip: process.platform === 'win32' }, async () => {
    const result = await runStep(options);
    assert.equal(result.status, 1, result.stderr + result.stdout);
  });
}
