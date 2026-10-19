import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { telegramUserId } from '../src/auth.ts';

const TOKEN = '123456:TEST-token';

function sign(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const now = 1_800_000_000_000;
const fields = { auth_date: String(now / 1000 - 60), query_id: 'AAE', user: JSON.stringify({ id: 4242, first_name: 'M' }) };

test('accepts initData signed with the bot token', async () => {
  assert.equal(await telegramUserId(sign(fields), TOKEN, 3600, now), '4242');
});

test('rejects tampered, foreign or stale initData', async () => {
  const tampered = sign(fields).replace('4242', '4243');
  assert.equal(await telegramUserId(tampered, TOKEN, 3600, now), null);
  assert.equal(await telegramUserId(sign(fields, '999:other'), TOKEN, 3600, now), null);
  assert.equal(await telegramUserId(sign(fields), TOKEN, 30, now), null);
  assert.equal(await telegramUserId('', TOKEN, 3600, now), null);
});
