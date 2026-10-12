import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';

function metadataError(error) {
  const wrapped = new Error('Chrome profile metadata is unavailable or invalid.');
  if (error?.code === 'EPERM' || error?.code === 'EACCES') wrapped.code = error.code;
  return wrapped;
}

export function defaultChromeUserDataDir({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) throw new Error('Chrome profile metadata is unavailable or invalid.');
    return win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
  }
  if (platform !== 'darwin') throw new Error('Chrome profile access currently supports macOS and Windows.');
  return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
}

export async function listChromeProfiles(userDataDir = defaultChromeUserDataDir()) {
  let state;
  try {
    state = JSON.parse(await readFile(join(userDataDir, 'Local State'), 'utf8'));
  } catch (error) {
    throw metadataError(error);
  }

  const info = state.profile?.info_cache;
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Chrome profile metadata is unavailable or invalid.');
  const profiles = [];
  for (const [directory, details] of Object.entries(info)) {
    if (
      directory === '.' || directory === '..' || isAbsolute(directory) ||
      directory.includes('/') || directory.includes('\\')
    ) continue;
    try {
      const profileInfo = await lstat(join(userDataDir, directory));
      if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    profiles.push({ directory, name: typeof details?.name === 'string' ? details.name : directory });
  }
  return profiles;
}

function extensionState(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'recorded_unknown';
  const states = [];
  if (Object.hasOwn(entry, 'state')) {
    if (entry.state === 0) states.push('disabled');
    else if (entry.state === 1) states.push('enabled');
    else if (entry.state === 2) states.push('missing_or_id_mismatch_possible');
    else states.push('recorded_unknown');
  }
  if (Object.hasOwn(entry, 'disable_reasons')) {
    const reasons = entry.disable_reasons;
    if (Array.isArray(reasons) && reasons.every(Number.isInteger)) {
      states.push(reasons.length ? 'disabled' : 'enabled');
    } else if (Number.isInteger(reasons) && reasons >= 0) {
      states.push(reasons ? 'disabled' : 'enabled');
    } else states.push('recorded_unknown');
  }
  return states.length && states.every((state) => state === states[0])
    ? states[0]
    : 'recorded_unknown';
}

export async function inspectChromeProfile({
  profileDirectory,
  userDataDir = defaultChromeUserDataDir(),
  extensionId,
  lstatImpl = lstat,
  readFileImpl = readFile,
} = {}) {
  if (typeof profileDirectory !== 'string' || !profileDirectory) {
    return { state: 'not_configured', extension: 'unknown' };
  }
  if (
    profileDirectory === '.' || profileDirectory === '..' ||
    isAbsolute(profileDirectory) || profileDirectory.includes('/') || profileDirectory.includes('\\')
  ) return { state: 'unknown', extension: 'unknown' };

  let profileInfo;
  try { profileInfo = await lstatImpl(join(userDataDir, profileDirectory)); }
  catch (error) {
    return error.code === 'ENOENT'
      ? { state: 'not_found', extension: 'unknown' }
      : ['EPERM', 'EACCES'].includes(error.code)
        ? { state: 'access_denied', extension: 'unknown' }
        : { state: 'unknown', extension: 'unknown' };
  }
  if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) {
    return { state: 'metadata_unreadable', extension: 'unknown' };
  }

  if (typeof extensionId !== 'string' || !extensionId) {
    return { state: 'exists', extension: 'unknown' };
  }
  const settings = [];
  let unreadable = false;
  for (const name of ['Secure Preferences', 'Preferences']) {
    try {
      const preferencesPath = join(userDataDir, profileDirectory, name);
      const preferencesInfo = await lstatImpl(preferencesPath);
      if (!preferencesInfo.isFile() || preferencesInfo.isSymbolicLink()) throw new Error();
      const preferences = JSON.parse(await readFileImpl(preferencesPath, 'utf8'));
      const installed = preferences.extensions?.settings;
      if (installed && typeof installed === 'object' && !Array.isArray(installed)) {
        settings.push(Object.hasOwn(installed, extensionId) ? extensionState(installed[extensionId]) : null);
      }
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        return { state: 'access_denied', extension: 'unknown' };
      }
      if (error.code !== 'ENOENT') unreadable = true;
    }
  }
  if (settings.some((state) => state !== null)) {
    const recordedStates = settings.filter((state) => state !== null);
    const state = recordedStates[0];
    return {
      state: 'exists',
      extension: state !== 'recorded_unknown' && recordedStates.every((item) => item === state)
        ? state
        : 'recorded_unknown',
    };
  }
  if (unreadable || !settings.length) return { state: 'exists', extension: 'unknown' };
  return { state: 'exists', extension: 'missing_or_id_mismatch_possible' };
}

export async function selectChromeProfile(reference, userDataDir = defaultChromeUserDataDir()) {
  if (typeof reference !== 'string' || !reference.trim()) {
    throw new Error('Choose a Chrome profile with --profile.');
  }
  if (
    reference !== '.' && reference !== '..' && !isAbsolute(reference) &&
    !reference.includes('/') && !reference.includes('\\')
  ) {
    try {
      const profileInfo = await lstat(join(userDataDir, reference));
      if (profileInfo.isDirectory() && !profileInfo.isSymbolicLink()) {
        return { directory: reference, name: reference, profileDirectory: join(userDataDir, reference) };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const wrapped = new Error('The requested Chrome profile could not be inspected.');
        if (error.code === 'EPERM' || error.code === 'EACCES') wrapped.code = error.code;
        throw wrapped;
      }
    }
  }
  const profiles = await listChromeProfiles(userDataDir);
  const byDirectory = profiles.find((profile) => profile.directory === reference);
  const byName = profiles.filter((profile) => profile.name === reference);
  const selected = byDirectory ?? (byName.length === 1 ? byName[0] : undefined);
  if (!selected) {
    throw new Error(byName.length > 1
      ? 'That profile name is ambiguous; use its directory name.'
      : 'The requested Chrome profile was not found.');
  }
  if (
    selected.directory === '.' ||
    selected.directory === '..' ||
    selected.directory.includes('/') ||
    selected.directory.includes('\\')
  ) {
    throw new Error('The selected Chrome profile directory is invalid.');
  }
  return {
    ...selected,
    profileDirectory: join(userDataDir, selected.directory),
  };
}
