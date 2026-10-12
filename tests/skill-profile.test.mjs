import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultChromeUserDataDir, inspectChromeProfile, listChromeProfiles, selectChromeProfile } from '../skills/weixin-channels-video/scripts/chrome-profile.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'weixin-profile-test-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function addProfile(root, directory, name) {
  await mkdir(join(root, directory), { recursive: true });
  let state;
  try { state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8')); }
  catch { state = { profile: { info_cache: {} } }; }
  state.profile.info_cache[directory] = { name };
  await writeFile(join(root, 'Local State'), JSON.stringify(state));
}

test('profile listing and selection use metadata without reading cookie databases', async () => {
  await fixture(async (root) => {
    await addProfile(root, 'Default', 'Work');
    await addProfile(root, 'Profile 2', 'Personal');
    assert.deepEqual(await listChromeProfiles(root), [
      { directory: 'Default', name: 'Work' },
      { directory: 'Profile 2', name: 'Personal' },
    ]);
    await assert.rejects(selectChromeProfile(undefined, root), /Choose a Chrome profile/);
    assert.deepEqual(await selectChromeProfile('Personal', root), {
      directory: 'Profile 2',
      name: 'Personal',
      profileDirectory: join(root, 'Profile 2'),
    });
    assert.equal((await selectChromeProfile('Default', root)).directory, 'Default');
  });
});

test('default Chrome profile paths follow each supported platform', () => {
  assert.equal(defaultChromeUserDataDir({ platform: 'darwin', home: '/Users/example' }),
    '/Users/example/Library/Application Support/Google/Chrome');
  assert.equal(defaultChromeUserDataDir({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' },
  }), 'C:\\Users\\example\\AppData\\Local\\Google\\Chrome\\User Data');
});

test('an explicit profile directory works without Local State or Preferences metadata', async () => {
  await fixture(async (root) => {
    await mkdir(join(root, 'Profile 7'));
    assert.deepEqual(await selectChromeProfile('Profile 7', root), {
      directory: 'Profile 7',
      name: 'Profile 7',
      profileDirectory: join(root, 'Profile 7'),
    });
    assert.deepEqual(await inspectChromeProfile({
      profileDirectory: 'Profile 7',
      userDataDir: root,
      extensionId: 'a'.repeat(32),
    }), { state: 'exists', extension: 'unknown' });
  });
});
