import { env, fail, sign } from './security.mjs';

export function configuration() {
  const url = env('PPD_DRIVE_SCRIPT_URL');
  const driveSecret = env('PPD_DRIVE_SECRET');
  const sessionSecret = env('PPD_SESSION_SECRET');
  const password = env('PPD_MEMBER_PASSWORD');
  const configured = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url || '') &&
    driveSecret?.length >= 32 && sessionSecret?.length >= 32 && password?.length >= 16;
  return { url, driveSecret, sessionSecret, password, configured: !!configured };
}

export async function gateway(action, payload = {}, options = {}) {
  if (options.gateway) return options.gateway(action, payload);
  const cfg = configuration();
  if (!cfg.configured) throw fail(503, 'Googleドライブの接続設定が完了していません。');
  const message = JSON.stringify({ action, payload, timestamp: Date.now() });
  const response = await fetch(cfg.url, {
    method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(45000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature: sign(message, cfg.driveSecret) })
  });
  if (!response.ok) throw fail(502, 'Googleドライブに接続できません。');
  let result;
  try { result = await response.json(); }
  catch { throw fail(502, 'Google連携の公開設定を確認してください。'); }
  if (!result.ok) throw fail(result.status || 502, result.message || 'Googleドライブへの保存に失敗しました。');
  return result.data;
}
