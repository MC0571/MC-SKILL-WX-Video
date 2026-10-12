import { checkLogin } from "../src/core.mjs";

export const LOGIN_STORAGE_KEY = "weixin-channels-video:login-state";
export const CONNECTION_STORAGE_KEY = "weixin-channels-video:bridge-connection-state";
export const INSTANCE_STORAGE_KEY = "weixin-channels-video:instance-id";
export const LOGIN_REFRESH_TYPE = "weixin-channels-video:refresh-login";
export const AUTH_FAILURE_TYPE = "weixin-channels-video:auth-failure";
export const LOGIN_REFRESH_ALARM = "weixin-channels-video:login-refresh";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOGIN_TTL_MS = 5 * 60_000;

export async function getInstanceId(chromeApi = globalThis.chrome, randomUUID = () => crypto.randomUUID()) {
  const stored = await chromeApi.storage.local.get(INSTANCE_STORAGE_KEY);
  const current = stored[INSTANCE_STORAGE_KEY];
  if (UUID_PATTERN.test(current ?? "")) return current;
  const instanceId = randomUUID();
  if (!UUID_PATTERN.test(instanceId)) throw new Error("INSTANCE_ID_INVALID");
  await chromeApi.storage.local.set({ [INSTANCE_STORAGE_KEY]: instanceId });
  return instanceId;
}

export function createLoginStateManager({
  chromeApi = globalThis.chrome,
  requestFactory,
  clock = Date.now,
  checker = checkLogin,
} = {}) {
  let refreshInProgress;
  let snapshot;
  let authEpoch = 0;

  const save = async (next) => {
    snapshot = next;
    await chromeApi.storage.local.set({ [LOGIN_STORAGE_KEY]: next });
    return next;
  };

  const read = async () => {
    if (snapshot) return snapshot;
    const stored = await chromeApi.storage.local.get(LOGIN_STORAGE_KEY);
    const value = stored[LOGIN_STORAGE_KEY];
    if (value && typeof value === "object" && !Array.isArray(value) &&
        ["authenticated", "anonymous", "failed", "not_checked"].includes(value.login) &&
        (value.checkedAt === null || (Number.isFinite(value.checkedAt) && value.checkedAt >= 0)) &&
        (!value.error || value.error === "LOGIN_CHECK_FAILED")) {
      snapshot = value;
      return value;
    }
    return save({ login: "not_checked", checkedAt: null });
  };

  const refresh = () => {
    if (refreshInProgress) return refreshInProgress;
    const startedAtEpoch = authEpoch;
    refreshInProgress = (async () => {
      let next;
      try {
        const result = await checker(requestFactory());
        next = { login: result.status, checkedAt: clock() };
      } catch {
        next = { login: "failed", checkedAt: clock(), error: "LOGIN_CHECK_FAILED" };
      }
      if (authEpoch === startedAtEpoch) return save(next);
      return read();
    })().finally(() => { refreshInProgress = undefined; });
    return refreshInProgress;
  };

  const status = async ({ refreshLogin = false } = {}) => {
    const current = await read();
    if (!refreshLogin) return current;
    const age = clock() - current.checkedAt;
    if (current.checkedAt !== null && age >= 0 && age < LOGIN_TTL_MS) return current;
    return refresh();
  };

  const markAuthenticationFailure = (error) => {
    if (error?.code === "AUTH_EXPIRED" || error?.message === "AUTH_EXPIRED") {
      authEpoch += 1;
      return save({ login: "anonymous", checkedAt: clock() });
    }
    return Promise.resolve();
  };

  const start = async () => {
    await chromeApi.alarms.create(LOGIN_REFRESH_ALARM, { periodInMinutes: 5 });
    return status({ refreshLogin: true });
  };

  return { read, refresh, status, start, markAuthenticationFailure };
}
