import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { skillArchive } from './fixtures/skill-archive.mjs';
import { installBridge } from '../skills/weixin-channels-video/scripts/bridge-install.mjs';
import { assertWindowsPrivatePath, secureWindowsPath } from '../skills/weixin-channels-video/scripts/windows-security.mjs';

const supportedPlatform = process.platform === 'darwin' || process.platform === 'win32';

async function assertPrivateTree(path) {
  if (process.platform !== 'win32') return;
  await assertWindowsPrivatePath(path, { directory: true });
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const info = await lstat(child);
    if (info.isDirectory()) await assertPrivateTree(child);
    else await assertWindowsPrivatePath(child);
  }
}

function makeRelease(version, runtimeProtocol = 3, corruptChecksum = false, minimumNodeVersion = '22.22.2', tagName = 'skill-v' + version) {
  const archiveName = 'weixin-channels-video-skill-v' + version + '.tar.gz';
  const skillZipName = 'weixin-channels-video-skill-v' + version + '.zip';
  const baseUrl = 'https://github.com/MC0571/weixin-channels-video/releases/download/' + tagName;
  const archive = skillArchive([
    ['weixin-channels-video', '', '5'],
    ['weixin-channels-video/assets', '', '5'],
    ['weixin-channels-video/assets/extension', '', '5'],
    ['weixin-channels-video/references', '', '5'],
    ['weixin-channels-video/scripts', '', '5'],
    ['weixin-channels-video/SKILL.md', 'Skill installation instructions'],
    ['weixin-channels-video/assets/extension/manifest.json', JSON.stringify({ version })],
    ['weixin-channels-video/references/agent-installation.md', 'Agent installation guide'],
    ['weixin-channels-video/runtime.json', JSON.stringify({
      version,
      runtimeProtocol,
      minimumNodeVersion,
    })],
    ['weixin-channels-video/scripts/run.mjs', 'export {};'],
    ['weixin-channels-video/scripts/cli.mjs', 'export {};'],
    ['weixin-channels-video/scripts/native-host.mjs', 'export {};'],
  ]);
  const hash = corruptChecksum
    ? '0'.repeat(64)
    : createHash('sha256').update(archive).digest('hex');
  const checksums = Buffer.from(hash + '  ' + archiveName + '\n');
  const makeAsset = (name, bytes, contentType) => ({
    name,
    size: bytes.length,
    content_type: contentType,
    browser_download_url: baseUrl + '/' + name,
  });
  const release = {
    tag_name: tagName,
    draft: false,
    prerelease: false,
    assets: [
      makeAsset(archiveName, archive, 'application/gzip'),
      makeAsset(skillZipName, Buffer.from('zip'), 'application/zip'),
      makeAsset('SHA256SUMS', checksums, 'text/plain'),
    ],
  };
  return { archive, archiveName, baseUrl, checksums, release };
}

function response(body, contentType, extraHeaders = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return new Response(bytes, {
    headers: {
      'content-type': contentType,
      'content-length': String(bytes.length),
      ...extraHeaders,
    },
  });
}

test('Release preparation accepts x-gtar MIME, leaves legacy extension files untouched and commits only protocol-3 runtime state', {
  skip: !supportedPlatform,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'skill-runtime-transaction-'));
  const localAppData = join(tempRoot, 'LocalAppData');
  const originalHome = process.env.HOME;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  if (process.platform === 'win32') process.env.LOCALAPPDATA = localAppData;
  else process.env.HOME = tempRoot;

  try {
    const runtime = await import('../skills/weixin-channels-video/scripts/run.mjs');
    const legacyRoot = runtime.platformCacheRoot();
    const cacheRoot = join(legacyRoot, 'protocol-' + runtime.RUNTIME_PROTOCOL);
    const versionRoot = join(legacyRoot, '0.1.1');
    const assetsRoot = join(versionRoot, 'assets');
    const oldExtension = join(assetsRoot, 'extension');
    const oldManifest = join(oldExtension, 'manifest.json');
    const legacyMarker = join(legacyRoot, 'current.json');
    if (process.platform === 'win32') {
      await mkdir(localAppData);
      const appCacheRoot = join(localAppData, 'weixin-channels-video');
      for (const directory of [appCacheRoot, legacyRoot, versionRoot, assetsRoot, oldExtension]) {
        await mkdir(directory, { recursive: false });
        await secureWindowsPath(directory, { directory: true, newlyCreated: true });
      }
    } else {
      await mkdir(oldExtension, { recursive: true });
    }
    const oldManifestBytes = Buffer.from(JSON.stringify({ version: '0.1.1', marker: 'preserve' }));
    await writeFile(oldManifest, oldManifestBytes, { flag: 'wx' });
    await writeFile(legacyMarker, JSON.stringify({
      version: '0.1.1',
      runtimeProtocol: 1,
    }), { flag: 'wx' });
    if (process.platform === 'win32') {
      await secureWindowsPath(oldManifest, { newlyCreated: true });
      await secureWindowsPath(legacyMarker, { newlyCreated: true });
    }

    const newerExtensionRelease = {
      tag_name: 'extension-v99.0.0', draft: false, prerelease: false, assets: [],
    };
    const incompatibleSkill = makeRelease('0.3.0', 4);
    const incompatibleSameVersionSkill = makeRelease('0.2.4', 4);
    const legacySkill = makeRelease('0.2.4', 3, false, '22.22.2', 'v0.2.4');
    legacySkill.release.assets[0].content_type = 'application/x-gtar';
    let releasePages = [
      [newerExtensionRelease, incompatibleSkill.release],
      [incompatibleSameVersionSkill.release, legacySkill.release],
    ];
    let releaseFixtures = [incompatibleSkill, incompatibleSameVersionSkill, legacySkill];
    let failedDownloadUrl = null;
    const releasesApi = 'https://api.github.com/repos/MC0571/weixin-channels-video/releases?per_page=100&page=';
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === releasesApi + '1') {
        return response(JSON.stringify(releasePages[0] ?? []), 'application/vnd.github+json',
          releasePages.length > 1 ? { link: '<' + releasesApi + '2>; rel="next"' } : {});
      }
      if (url === releasesApi + '2') {
        return response(JSON.stringify(releasePages[1] ?? []), 'application/vnd.github+json');
      }
      if (url === failedDownloadUrl) throw new Error('synthetic network failure');
      for (const fixture of releaseFixtures) {
        if (url === fixture.baseUrl + '/SHA256SUMS') return response(fixture.checksums, 'text/plain');
        if (url === fixture.baseUrl + '/' + fixture.archiveName) return response(fixture.archive, fixture.release.assets[0].content_type);
      }
      throw new Error('Unexpected runtime test URL: ' + url);
    };

    async function prepare() {
      const output = [];
      process.stdout.write = (chunk) => {
        output.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        return true;
      };
      try {
        assert.equal(await runtime.run(['prepare']), 0);
        return JSON.parse(output.join(''));
      } finally {
        process.stdout.write = originalWrite;
      }
    }

    async function assertCommitted(version, markerText) {
      assert.equal(await readFile(join(cacheRoot, version, 'runtime.json'), 'utf8').then((text) => JSON.parse(text).version), version);
      assert.equal(await readFile(join(cacheRoot, 'current.json'), 'utf8'), markerText);
      assert.deepEqual(await readFile(oldManifest), oldManifestBytes);
    }

    const prepared = await prepare();
    assert.equal(prepared.version, '0.2.4');
    assert.equal(prepared.runtimeProtocol, 3);
    assert.equal('compatible' in prepared, false);
    assert.equal('extensionAssets' in prepared, false);
    const cachedRuntime = join(cacheRoot, '0.2.4');
    assert.equal((await readdir(cachedRuntime)).sort().join(','), 'runtime.json,scripts');
    assert.equal((await readdir(join(cachedRuntime, 'scripts'))).sort().join(','), 'cli.mjs,native-host.mjs');
    await assert.rejects(lstat(join(cachedRuntime, 'SKILL.md')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(cachedRuntime, 'scripts', 'run.mjs')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(cachedRuntime, 'assets', 'extension')), { code: 'ENOENT' });
    assert.equal((await prepare()).version, '0.2.4');
    assert.equal(await runtime.run(['status']), 0);
    const committedMarker = await readFile(join(cacheRoot, 'current.json'), 'utf8');
    assert.deepEqual(JSON.parse(committedMarker), {
      version: '0.2.4',
      runtimeProtocol: 3,
    });
    await assertCommitted('0.2.4', committedMarker);
    if (process.platform === 'win32') {
      await assertPrivateTree(cacheRoot);
      await assertPrivateTree(oldExtension);
    }

    const badHashRelease = makeRelease('0.4.0', 3, true);
    badHashRelease.release.assets[0].content_type = 'application/x-gtar';
    releaseFixtures = [badHashRelease, legacySkill];
    releasePages = [[newerExtensionRelease, badHashRelease.release], [legacySkill.release]];
    await assert.rejects(prepare(), /SHA256/);
    await assertCommitted('0.2.4', committedMarker);
    await assert.rejects(lstat(join(cacheRoot, '0.4.0')), { code: 'ENOENT' });

    const networkRelease = makeRelease('0.5.0');
    releaseFixtures = [networkRelease, legacySkill];
    releasePages = [[networkRelease.release], [legacySkill.release]];
    failedDownloadUrl = networkRelease.baseUrl + '/' + networkRelease.archiveName;
    await assert.rejects(prepare(), /无法连接 GitHub Releases/);
    failedDownloadUrl = null;
    await assertCommitted('0.2.4', committedMarker);
    await assert.rejects(lstat(join(cacheRoot, '0.5.0')), { code: 'ENOENT' });

    const tooNewNodeRelease = makeRelease('0.5.8', 3, false, '99.0.0');
    releaseFixtures = [tooNewNodeRelease, legacySkill];
    releasePages = [[tooNewNodeRelease.release], [legacySkill.release]];
    assert.equal((await prepare()).version, '0.2.4');
    await assertCommitted('0.2.4', committedMarker);

    const incompatibleProtocol = makeRelease('0.6.0', 4);
    const incompatibleNode = makeRelease('0.5.9', 3, false, '99.0.0');
    releaseFixtures = [incompatibleProtocol, incompatibleNode];
    releasePages = [[incompatibleProtocol.release, incompatibleNode.release]];
    await assert.rejects(prepare(), /没有与当前运行环境兼容/);
    await assertCommitted('0.2.4', committedMarker);
    await assert.rejects(lstat(join(cacheRoot, '0.6.0')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(cacheRoot, '0.5.9')), { code: 'ENOENT' });
    assert.equal((await readdir(cacheRoot)).some((name) => name.startsWith('.prepare-')), false);

    await assert.rejects(runtime.materializeRuntime({
      version: '0.5.0',
      runtimeProtocol: 3,
      minimumNodeVersion: '22.22.2',
      runtimeCLI: join(tempRoot, 'incoming', 'cli.mjs'),
    }, {
      writeMarker: async () => { throw new Error('synthetic marker write failure'); },
    }), /synthetic marker write failure/);
    await assertCommitted('0.2.4', committedMarker);
    assert.deepEqual(await readFile(oldManifest), oldManifestBytes);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Windows release preparation protects the shared bridge storage root', {
  skip: process.platform !== 'win32',
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'skill-runtime-shared-root-'));
  const localAppData = join(tempRoot, 'LocalAppData');
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  await mkdir(localAppData);
  process.env.LOCALAPPDATA = localAppData;

  try {
    const runtimeUrl = new URL('../skills/weixin-channels-video/scripts/run.mjs', import.meta.url);
    runtimeUrl.searchParams.set('fixture', 'shared-bridge-storage-root');
    const runtime = await import(runtimeUrl);
    const appSupportRoot = join(localAppData, 'weixin-channels-video');
    await assert.rejects(lstat(appSupportRoot), { code: 'ENOENT' });

    const activeRelease = makeRelease('0.6.0');
    const releasesApi = 'https://api.github.com/repos/MC0571/weixin-channels-video/releases?per_page=100&page=1';
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === releasesApi) {
        return response(JSON.stringify([activeRelease.release]), 'application/vnd.github+json');
      }
      if (url === activeRelease.baseUrl + '/SHA256SUMS') {
        return response(activeRelease.checksums, 'text/plain');
      }
      if (url === activeRelease.baseUrl + '/' + activeRelease.archiveName) {
        return response(activeRelease.archive, 'application/gzip');
      }
      throw new Error('Unexpected shared-root runtime test URL: ' + url);
    };

    const output = [];
    process.stdout.write = (chunk) => {
      output.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    };
    try {
      assert.equal(await runtime.run(['prepare']), 0);
    } finally {
      process.stdout.write = originalWrite;
    }
    const prepared = JSON.parse(output.join(''));
    assert.equal(prepared.version, '0.6.0');
    await assertWindowsPrivatePath(appSupportRoot, { directory: true });

    const chromeUserDataDir = join(tempRoot, 'Chrome User Data');
    await mkdir(join(chromeUserDataDir, 'Default'), { recursive: true });
    await writeFile(join(chromeUserDataDir, 'Local State'), JSON.stringify({
      profile: { info_cache: { Default: { name: 'Default' } } },
    }), { flag: 'wx' });
    let registeredPath = null;
    const installed = await installBridge({
      extensionId: 'a'.repeat(32),
      profile: 'Default',
      appSupportDir: appSupportRoot,
      chromeUserDataDir,
      nodeExecutable: process.execPath,
      nativeHostSource: join(dirname(prepared.runtimeCLI), 'native-host.mjs'),
      platform: 'win32',
      registry: {
        async read() { return registeredPath; },
        async write(_key, path) { registeredPath = path; },
        async remove(_key, expectedPath) {
          if (registeredPath === expectedPath) registeredPath = null;
        },
      },
    });
    assert.equal(installed.config.appSupportDir, appSupportRoot);
    assert.equal(registeredPath, installed.hostManifestPath);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
