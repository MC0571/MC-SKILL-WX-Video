import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const itemId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const publisherId = '00000000-0000-0000-0000-000000000000';
const itemName = `publishers/${publisherId}/items/${itemId}`;
const token = 'fixture/TOKEN+VALUE?=not-real#secret';
const revision = (state, version) => ({ state, distributionChannels: [{ crxVersion: version }] });
const itemStatus = (extra = {}) => ({
  name: itemName,
  itemId,
  publishedItemRevisionStatus: revision('PUBLISHED', '0.1.1'),
  ...extra,
});
const statusResponse = (extra) => ({ method: 'GET', action: 'fetchStatus', result: itemStatus(extra) });
const uploadedResponse = () => ({
  method: 'POST', action: 'upload',
  result: { name: itemName, itemId, crxVersion: '0.2.1', uploadState: 'SUCCEEDED' },
});

async function runCli(responses) {
  const root = await mkdtemp(join(tmpdir(), 'cws-cli-'));
  try {
    await Promise.all([
      mkdir(join(root, 'scripts')),
      mkdir(join(root, 'extension')),
      mkdir(join(root, 'dist', 'release'), { recursive: true }),
    ]);
    const script = join(root, 'scripts', 'chrome-web-store.mjs');
    const mock = join(root, 'fetch-mock.mjs');
    await Promise.all([
      writeFile(script, await readFile(new URL('../scripts/chrome-web-store.mjs', import.meta.url))),
      writeFile(join(root, 'extension', 'manifest.json'), JSON.stringify({ version: '0.2.1' })),
      writeFile(join(root, 'dist', 'release', 'weixin-channels-video-extension-v0.2.1.zip'), 'mock upload bytes'),
      writeFile(join(root, 'responses.json'), JSON.stringify(responses)),
      writeFile(mock, `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const responses = JSON.parse(readFileSync(new URL('./responses.json', import.meta.url), 'utf8'));
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const expected = responses.shift();
  assert.ok(expected, 'Unexpected API request');
  const method = options.method ?? 'GET';
  const action = new URL(url).pathname.split(':').at(-1);
  assert.equal(new URL(url).origin, 'https://chromewebstore.googleapis.com');
  assert.equal(method, expected.method);
  assert.equal(action, expected.action);
  assert.equal(options.headers.Authorization, 'Bearer ' + process.env.CWS_ACCESS_TOKEN);
  calls.push({ method, action, ...(action === 'publish' ? { body: JSON.parse(options.body) } : {}) });
  if (expected.networkError) throw new Error('Synthetic network failure');
  return new Response(JSON.stringify(expected.result), { status: expected.status ?? 200 });
};
process.on('exit', () => writeFileSync(new URL('./calls.json', import.meta.url), JSON.stringify({ calls, remaining: responses.length })));
`),
    ]);
    const result = await new Promise((resolve) => {
      execFile(process.execPath, ['--import', pathToFileURL(mock).href, script], {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          CWS_ACCESS_TOKEN: token,
          CWS_PUBLISHER_ID: publisherId,
          CWS_ITEM_ID: itemId,
        },
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    });
    const recorded = JSON.parse(await readFile(join(root, 'calls.json'), 'utf8'));
    assert.equal(recorded.remaining, 0, result.stderr);
    return { ...result, calls: recorded.calls };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('publish validation errors expose actionable fields without credentials or arbitrary details', async () => {
  const encodedToken = encodeURIComponent(token);
  const error = {
    status: 'INVALID_ARGUMENT',
    message: `Publish validation failed: ${token} ${encodeURI(token)} ${encodedToken} ${encodedToken.replace(/%[a-f\d]{2}/gi, (value) => value.toLowerCase())}; see https://example.invalid/private?secret=URL_PRIVATE or https%3A%2F%2Fexample.invalid%2FENCODED_URL_PRIVATE; publisher@example.invalid\nCookie: COOKIE_PRIVATE; cookie with spaces\nAuthorization: Bearer AUTH_PRIVATE\naccess_token=ASSIGNMENT_PRIVATE\nsecret = SPACED_PRIVATE\n{"Cookie": "QUOTED_COOKIE_PRIVATE; c=d"}\n{"Set-Cookie": "QUOTED_SET_COOKIE_PRIVATE; Secure"}\n{"Authorization": "Basic QUOTED_AUTH_PRIVATE"}\n\u001b[31mAdditional validation information`,
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'MISSING_PRIVACY_DECLARATION', domain: 'chromewebstore.googleapis.com',
        metadata: { credential: 'METADATA_PRIVATE' },
      },
      {
        '@type': 'type.googleapis.com/google.rpc.BadRequest',
        fieldViolations: [{ field: 'privacy.permissions', reason: 'MISSING_REQUIREMENT', description: 'Add permission justification.', value: 'FIELD_PRIVATE' }],
      },
      {
        '@type': 'type.googleapis.com/google.chromewebstore.v2.WarningsInfo',
        warnings: [
          { reason: 'REMOTE_CODE_WARNING', description: 'Review the remote-code declaration.' },
          { reason: 'CREDENTIAL_WARNING', description: 'Cookie: WARNING_PRIVATE' },
        ],
      },
      {
        '@type': 'type.googleapis.com/google.rpc.PreconditionFailure',
        violations: [{ type: 'TOS', subject: 'SUBJECT_PRIVATE', description: 'Accept publisher terms.' }],
      },
      { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', message: 'Complete your privacy declarations.' },
      { '@type': 'type.googleapis.com/google.rpc.RequestInfo', servingData: 'SERVING_PRIVATE' },
      { '@type': 'type.googleapis.com/UNKNOWN_PRIVATE', message: 'UNKNOWN_MESSAGE_PRIVATE', metadata: 'UNKNOWN_METADATA_PRIVATE' },
    ],
    unrecognized: 'RESPONSE_PRIVATE',
  };
  const result = await runCli([
    statusResponse(), uploadedResponse(),
    { method: 'POST', action: 'publish', status: 400, result: { error } },
    statusResponse(),
  ]);
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls.map(({ method, action }) => [method, action]), [
    ['GET', 'fetchStatus'], ['POST', 'upload'], ['POST', 'publish'], ['GET', 'fetchStatus'],
  ]);
  assert.deepEqual(result.calls[2].body, { publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true });
  for (const expected of [
    'HTTP 400, INVALID_ARGUMENT', 'Publish validation failed',
    'MISSING_PRIVACY_DECLARATION', 'chromewebstore.googleapis.com',
    'privacy.permissions', 'MISSING_REQUIREMENT', 'Add permission justification.',
    'REMOTE_CODE_WARNING', 'Review the remote-code declaration.',
    'Accept publisher terms.', 'Complete your privacy declarations.',
    'Unsupported error detail omitted',
  ]) assert.ok(result.stderr.includes(expected), expected);
  const output = result.stdout + result.stderr;
  for (const privateText of [token, encodeURI(token), encodedToken, encodedToken.replace(/%[a-f\d]{2}/gi, (value) => value.toLowerCase()), 'https://', 'https%3A', 'publisher@example.invalid', '_PRIVATE', 'Bearer ', '\u001b']) {
    assert.equal(output.includes(privateText), false, privateText);
  }
  assert.equal(result.stderr.trim().split('\n').length, 1);
});

test('successful submission retains the default publish and warning guard', async () => {
  const result = await runCli([
    statusResponse(), uploadedResponse(),
    { method: 'POST', action: 'publish', result: { name: itemName, itemId, state: 'PENDING_REVIEW' } },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /version 0\.2\.1 submitted \(state=PENDING_REVIEW\)/);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.calls.at(-1).body, { publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true });
});

test('published or pending versions are handled without another upload or submission', async () => {
  for (const extra of [
    { publishedItemRevisionStatus: revision('PUBLISHED', '0.2.1') },
    { submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.2.1') },
  ]) {
    const result = await runCli([statusResponse(extra)]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /version 0\.2\.1 is already (published|submitted)/);
    assert.deepEqual(result.calls, [{ method: 'GET', action: 'fetchStatus' }]);
  }
});

test('ambiguous publish transport failure checks accepted status before reporting failure', async () => {
  const result = await runCli([
    statusResponse(), uploadedResponse(),
    { method: 'POST', action: 'publish', networkError: true },
    statusResponse({ submittedItemRevisionStatus: revision('PENDING_REVIEW', '0.2.1') }),
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /version 0\.2\.1 is already submitted/);
  assert.equal(result.calls.length, 4);
});

test('diagnostic text and detail counts remain bounded', async () => {
  const result = await runCli([
    statusResponse(), uploadedResponse(),
    {
      method: 'POST', action: 'publish', status: 400,
      result: { error: {
        status: 'INVALID_ARGUMENT', message: 'x'.repeat(2000),
        details: Array.from({ length: 12 }, (_, index) => ({
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: `REASON_${index}`, domain: 'chromewebstore.googleapis.com',
        })),
      } },
    },
    statusResponse(),
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr.includes('x'.repeat(1001)), false);
  assert.ok(result.stderr.includes('REASON_9'));
  assert.equal(result.stderr.includes('REASON_10'), false);
  assert.ok(result.stderr.length < 6500);
});
