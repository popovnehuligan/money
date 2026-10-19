// Checks Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
// so the dashboard only ever shows your data to you.

const enc = new TextEncoder();

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The Telegram user id that opened the Mini App, or null if initData is forged or too old. */
export async function telegramUserId(initData: string, botToken: string, maxAgeSeconds = 7 * 86400, now = Date.now()): Promise<string | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !botToken) return null;
  params.delete('hash');
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  if (hex(await hmac(secret, check)) !== hash) return null;
  if (now / 1000 - Number(params.get('auth_date')) > maxAgeSeconds) return null;
  const id = JSON.parse(params.get('user') ?? '{}').id;
  return id ? String(id) : null;
}
