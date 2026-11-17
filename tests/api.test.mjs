import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle } from '../server/api.mjs';
import { localStore } from '../server/local-store.mjs';
import { validateContent } from '../server/security.mjs';

const origin = 'http://127.0.0.1:8001';
const configuration = { configured: true, password: 'a-long-test-password', sessionSecret: 'test-session-secret-that-is-long-enough' };
const data = () => ({
  memberData: { nami: { name: 'NAMi', image: 'assets/members/nami.jpg', activities: [], equipment: [] } },
  liveData: { gig: { title: 'Existing Live', dateValue: '2026-12-19' } },
  albums: { gig: { title: 'Existing Live', photos: [{ src: 'assets/members/nami.jpg', comment: 'Keep this photo' }] } }
});
function request(kind, method = 'GET', body, cookie, headers = {}) {
  return new Request(origin + '/.netlify/functions/site-' + kind, { method, headers: {
    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', Origin: origin }),
    ...(cookie ? { Cookie: cookie } : {}), ...headers
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ppd-api-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { configuration, gateway: localStore(directory) };
  const login = await handle(request('session', 'POST', { password: configuration.password }), 'session', options);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { options, cookie, directory };
}

test('login uses a signed HttpOnly session and rejects the former demo password', async t => {
  const { options } = await fixture(t);
  const bad = await handle(request('session', 'POST', { password: 'ppd2026' }), 'session', options);
  assert.equal(bad.status, 401);
  const good = await handle(request('session', 'POST', { password: configuration.password }), 'session', options);
  assert.match(good.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const forged = await handle(request('session', 'GET', undefined, 'ppd_member=true'), 'session', options);
  assert.equal((await forged.json()).authenticated, false);
});

test('initialization preserves content; another browser can read the published data', async t => {
  const { options, cookie, directory } = await fixture(t);
  assert.equal((await (await handle(request('content'), 'content', options)).json()).content, null);
  const original = data();
  const saved = await handle(request('content', 'POST', { data: original, expectedRevision: null }, cookie), 'content', options);
  assert.equal(saved.status, 200);
  const result = await (await handle(request('content'), 'content', options)).json();
  assert.deepEqual(result.content.data, original);
  assert.equal((await readdir(join(directory, 'history'))).length, 1);
});

test('stale concurrent updates fail without overwriting existing data; history remains', async t => {
  const { options, cookie, directory } = await fixture(t);
  const first = await (await handle(request('content', 'POST', { data: data(), expectedRevision: null }, cookie), 'content', options)).json();
  const next = data(); next.liveData.gig.title = 'Updated Live';
  assert.equal((await handle(request('content', 'POST', { data: next, expectedRevision: first.revision }, cookie), 'content', options)).status, 200);
  const stale = await handle(request('content', 'POST', { data: data(), expectedRevision: first.revision }, cookie), 'content', options);
  assert.equal(stale.status, 409);
  assert.equal((await readdir(join(directory, 'history'))).length, 2);
  assert.equal(JSON.parse(await readFile(join(directory, 'content.json'), 'utf8')).data.liveData.gig.title, 'Updated Live');
});

test('anonymous, cross-origin, unconfigured, and preview writes cannot change storage', async t => {
  const { options, cookie } = await fixture(t);
  const payload = { data: data(), expectedRevision: null };
  assert.equal((await handle(request('content', 'POST', payload), 'content', options)).status, 401);
  assert.equal((await handle(request('content', 'POST', payload, cookie, { Origin: 'https://other.example' }), 'content', options)).status, 403);
  assert.equal((await handle(request('content', 'POST', payload, cookie), 'content', { ...options, readOnly: true })).status, 403);
  assert.equal((await handle(request('content'), 'content', { ...options, configuration: { configured: false } })).status, 503);
  assert.equal((await (await handle(request('content'), 'content', options)).json()).content, null);
});

test('images are authenticated on upload, deduplicated, and limited to content-addressed image files', async t => {
  const { options, cookie, directory } = await fixture(t);
  const file = await readFile('assets/logos/band-logo.jpg');
  const payload = { base64: file.toString('base64') };
  assert.equal((await handle(request('media', 'POST', payload), 'media', options)).status, 401);
  const uploaded = await (await handle(request('media', 'POST', payload, cookie), 'media', options)).json();
  assert.match(uploaded.src, /key=[a-f0-9]{64}$/);
  await handle(request('media', 'POST', payload, cookie), 'media', options);
  assert.equal((await readdir(join(directory, 'images'))).length, 1);
  const result = await handle(new Request(origin + uploaded.src), 'media', options);
  assert.equal(result.status, 200);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), file);
  assert.equal((await handle(new Request(origin + '/.netlify/functions/site-media?key=../../private'), 'media', options)).status, 400);
  assert.equal((await handle(request('media', 'POST', { base64: Buffer.from('<svg onload="evil()"/>').toString('base64') }, cookie), 'media', options)).status, 415);
});

test('invalid nested data, script image URLs, and oversized content are rejected', () => {
  const bad = data(); bad.albums.gig.photos[0].src = "javascript:alert('x')";
  assert.throws(() => validateContent(bad));
  const polluted = JSON.parse(JSON.stringify(data()).replace('"nami":', '"__proto__":'));
  assert.throws(() => validateContent(polluted));
  const empty = data(); empty.memberData = {};
  assert.throws(() => validateContent(empty));
  assert.deepEqual(validateContent(data()), data());
});

test('logging out clears the browser session cookie', async t => {
  const { options, cookie } = await fixture(t);
  const response = await handle(request('session', 'DELETE', undefined, cookie), 'session', options);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
});
