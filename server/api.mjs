import { createHash } from 'node:crypto';
import { configuration, gateway } from './gateway.mjs';
import { authenticated, equal, fail, imageType, json, MAX_IMAGE, readJSON, requireOrigin, sessionCookie, validateContent } from './security.mjs';

export async function handle(req, kind, options = {}) {
  try {
    const cfg = options.configuration || configuration();
    const loggedIn = authenticated(req, cfg.sessionSecret);
    if (kind === 'session') {
      if (req.method === 'GET') return json({ configured: cfg.configured, authenticated: loggedIn, storage: options.gateway ? 'local' : 'drive' });
      requireOrigin(req);
      if (!cfg.configured) throw fail(503, 'Googleドライブの接続設定が完了していません。');
      if (req.method === 'DELETE') return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, cfg.sessionSecret, true) });
      if (req.method !== 'POST') throw fail(405, 'この操作は使えません。');
      const { password } = await readJSON(req, 4096);
      if (typeof password !== 'string' || !equal(password, cfg.password)) throw fail(401, 'パスワードが違います。');
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, cfg.sessionSecret) });
    }
    if (!cfg.configured) throw fail(503, 'Googleドライブの接続設定が完了していません。');
    if (kind === 'content' && req.method === 'GET') {
      const data = await gateway('read', {}, options);
      return json(data, 200, loggedIn ? {} : {
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=30'
      });
    }
    if (kind === 'media' && req.method === 'GET') {
      const key = new URL(req.url).searchParams.get('key');
      if (!/^[a-f0-9]{64}$/.test(key || '')) throw fail(400, '画像IDが不正です。');
      const data = await gateway('image', { key }, options);
      const bytes = Buffer.from(data.base64, 'base64');
      const mime = imageType(bytes);
      if (bytes.length > MAX_IMAGE || createHash('sha256').update(bytes).digest('hex') !== key) throw fail(502, '画像データが一致しません。');
      return new Response(bytes, { headers: {
        'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable',
        'Netlify-CDN-Cache-Control': 'public, s-maxage=31536000', 'X-Content-Type-Options': 'nosniff'
      } });
    }
    if (!loggedIn) throw fail(401, 'ログインし直してください。下書きは残っています。');
    requireOrigin(req);
    if (req.method !== 'POST') throw fail(405, 'この操作は使えません。');
    if (options.readOnly) throw fail(403, 'プレビュー環境から本番データは変更できません。');
    if (kind === 'media') {
      const input = await readJSON(req);
      if (typeof input.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw fail(400, '画像データが不正です。');
      const bytes = Buffer.from(input.base64, 'base64');
      if (bytes.length > MAX_IMAGE) throw fail(413, '写真を小さくしてから追加してください。');
      const mime = imageType(bytes);
      const key = createHash('sha256').update(bytes).digest('hex');
      await gateway('upload', { key, mime, base64: input.base64 }, options);
      return json({ src: '/.netlify/functions/site-media?key=' + key });
    }
    if (kind === 'content') {
      const input = await readJSON(req);
      if (input.expectedRevision !== null && typeof input.expectedRevision !== 'string') throw fail(400, '保存バージョンが不正です。');
      const data = validateContent(input.data);
      return json(await gateway('save', { data, expectedRevision: input.expectedRevision }, options));
    }
    throw fail(404, '見つかりません。');
  } catch (error) {
    if (!error.status) console.error('Drive request failed:', error.name);
    return json({ error: error.status ? error.message : '接続に失敗しました。下書きは残っています。再保存してください。' }, error.status || 502);
  }
}
