import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const COOKIE = 'ppd_member';
export const MAX_IMAGE = 2500 * 1024;
export const MAX_JSON = 4 * 1024 * 1024;
export const env = name => globalThis.Netlify?.env?.get(name) ?? process.env[name];
export const json = (body, status = 200, headers = {}) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }
});
export function fail(status, message) {
  return Object.assign(new Error(message), { status });
}
export function equal(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
export function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('hex');
}
export function requireOrigin(req) {
  const origin = req.headers.get('origin');
  const fetchSite = req.headers.get('sec-fetch-site');
  if (origin !== new URL(req.url).origin || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    throw fail(403, '他のサイトからの更新は受け付けられません。');
  }
}
export function authenticated(req, secret) {
  if (!secret) return false;
  const cookie = req.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  const [expiry, nonce, signature] = (cookie?.slice(COOKIE.length + 1) || '').split('.');
  return /^\d+$/.test(expiry || '') && Number(expiry) > Date.now() && /^[a-f0-9]{32}$/.test(nonce || '') &&
    equal(signature || '', sign(expiry + '.' + nonce, secret));
}
export function sessionCookie(req, secret, logout = false) {
  const expiry = String(Date.now() + 8 * 60 * 60 * 1000);
  const value = expiry + '.' + randomBytes(16).toString('hex');
  return COOKIE + '=' + (logout ? '' : value + '.' + sign(value, secret)) +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + (logout ? '0' : '28800') +
    (new URL(req.url).protocol === 'https:' ? '; Secure' : '');
}
export async function readJSON(req, max = MAX_JSON) {
  if (!req.headers.get('content-type')?.startsWith('application/json')) throw fail(415, 'JSON形式が必要です。');
  if (Number(req.headers.get('content-length')) > max) throw fail(413, 'データが大きすぎます。');
  const reader = req.body?.getReader();
  if (!reader) throw fail(400, 'データがありません。');
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw fail(413, 'データが大きすぎます。'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'JSONを読み込めません。'); }
}
export function imageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw fail(415, 'JPEG・PNG・WebPの写真を選んでください。');
}

const id = /^[a-zA-Z0-9_-]{1,120}$/;
const image = /^(?:|assets\/[a-zA-Z0-9_./-]+|\/\.netlify\/functions\/site-media\?key=[a-f0-9]{64})$/;
export function validateContent(data) {
  const record = value => value && !Array.isArray(value) && typeof value === 'object';
  if (!record(data) || !['memberData', 'liveData', 'albums'].every(key => record(data[key]))) {
    throw fail(400, 'メンバー・ライブ・アルバムのデータが必要です。');
  }
  if (!Object.keys(data.memberData).length) throw fail(400, 'メンバーを空にできません。');
  for (const collection of [data.memberData, data.liveData, data.albums]) {
    if (Object.keys(collection).some(key => !id.test(key))) throw fail(400, 'データIDが不正です。');
  }
  for (const member of Object.values(data.memberData)) {
    if (!record(member) || typeof member.name !== 'string' || !Array.isArray(member.activities) ||
      (member.equipment !== undefined && !Array.isArray(member.equipment))) throw fail(400, 'メンバーデータが不正です。');
    if (member.imageScale !== undefined && (!Number.isFinite(member.imageScale) || member.imageScale < 0.1 || member.imageScale > 5)) throw fail(400, '画像倍率が不正です。');
    if (member.imagePosition && !/^[\w% .-]{1,50}$/.test(member.imagePosition)) throw fail(400, '画像位置が不正です。');
    if (member.color && !/^#[a-fA-F0-9]{3,8}$/.test(member.color)) throw fail(400, 'メンバーカラーが不正です。');
    if (member.colorSoft && !/^(?:#[a-fA-F0-9]{3,8}|rgba?\([\d.,\s]+\))$/.test(member.colorSoft)) throw fail(400, 'メンバーカラーが不正です。');
  }
  for (const live of Object.values(data.liveData)) {
    if (!record(live) || typeof live.title !== 'string' || typeof live.dateValue !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(live.dateValue)) throw fail(400, 'ライブ情報が不正です。');
  }
  for (const album of Object.values(data.albums)) {
    if (!record(album) || typeof album.title !== 'string' || !Array.isArray(album.photos) ||
      album.photos.some(photo => !record(photo) || typeof photo.src !== 'string')) throw fail(400, 'アルバムが不正です。');
  }
  function walk(value, key = '', depth = 0) {
    if (depth > 12) throw fail(400, 'データ構造が深すぎます。');
    if (typeof value === 'string') {
      if (value.length > 30000) throw fail(413, '文章が長すぎます。');
      if (['src', 'image', 'flyer'].includes(key) && (!image.test(value) || value.includes('..'))) throw fail(400, '写真を先に保存してください。');
    } else if (Array.isArray(value)) value.forEach(item => walk(item, '', depth + 1));
    else if (record(value)) for (const [name, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(name)) throw fail(400, 'データのキーが不正です。');
      walk(item, name, depth + 1);
    }
  }
  walk(data);
  return { memberData: data.memberData, liveData: data.liveData, albums: data.albums };
}
