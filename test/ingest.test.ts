// Runs b-mails through ingest() against a real SQLite database built from migrations/, with
// Telegram stubbed out, to check the balance-gap logic end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../src/db.ts';
import { ingest } from '../src/ingest.ts';

/** The handful of D1 calls the Worker makes, on top of node:sqlite. */
function d1(): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'));
  return {
    prepare(sql: string) {
      let params: (string | number | null)[] = [];
      const st = {
        bind: (...p: (string | number | null)[]) => ((params = p), st),
        first: async () => db.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        run: async () => db.prepare(sql).run(...params),
      };
      return st;
    },
  } as unknown as D1Database;
}

function setup() {
  const sent: string[] = [];
  let id = 0;
  globalThis.fetch = (async (url: string) => {
    sent.push(String(url).split('/').pop()!); // sendMessage, editMessageText, deleteMessage…
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++id } }));
  }) as typeof fetch;
  const env = { DB: d1(), TELEGRAM_TOKEN: 't', CHAT_ID: '1', TELEGRAM_SECRET: 's', INGEST_SECRET: 'k' } as Env;
  const gaps = async () => (await env.DB.prepare("SELECT amount FROM tx WHERE source = 'gap' ORDER BY n").all<{ amount: number }>()).results.map((g) => g.amount);
  return { env, sent, gaps };
}

let n = 0;
// A Tatra b-mail: euros < 0 is a debit; `balance` is what the bank says the account holds afterwards.
const bmail = (env: Env, when: string, euros: number, balance: number, what = 'Platba kartou 4405**0000, SHOP') => {
  const [day, time] = when.split(' ');
  const [y, m, d] = day.split('-');
  const amount = Math.abs(euros).toFixed(2), bal = balance.toFixed(2);
  return ingest(env, {
    id: `m${++n}`,
    date: `${day}T${time}`,
    subject: `${euros < 0 ? 'Debit' : 'Credit'} on your account (ID=000000/${n}-2)`,
    body: `Dear client,\r\n\r\nat ${d}/${m}/${y}, ${time} the balance on your account SK0000000000000000000000 was ${euros < 0 ? 'decreased' : 'increased'} by ${amount} EUR.\r\nLedger balance: ${bal} EUR\r\nActual balance: ${bal} EUR\r\nDispo balance: ${bal} EUR\r\n\r\nTransaction description: ${what}\r\n`,
  });
};

test('one unexplained difference is asked about once, not echoed by every later b-mail', async () => {
  const { env, gaps } = setup();
  await bmail(env, '2026-10-27 22:01', -11.2, 27.17);
  await bmail(env, '2026-10-28 15:09', -5.44, 1.3); // 20.43 € more left than this b-mail says
  await bmail(env, '2026-10-29 21:05', 50, 51.3);
  await bmail(env, '2026-10-30 20:38', -4.36, 46.94);
  await bmail(env, '2026-10-30 22:51', -6.4, 40.54);
  assert.deepEqual(await gaps(), [-2043]);
});

test('a burst that evens out (charges and refunds arriving out of order) leaves nothing to ask', async () => {
  const { env, gaps, sent } = setup();
  await bmail(env, '2026-10-31 12:49', -4.39, 135.69);
  await bmail(env, '2026-10-31 15:08', -1, 134.69, 'Platba kartou 4405**0000, ANTHROPIC IRELAND');
  await bmail(env, '2026-10-31 15:08', -1, 133.69, 'Platba kartou 4405**0000, ANTHROPIC IRELAND');
  await bmail(env, '2026-10-31 15:08', 1, 135.69, 'Storno platby 4405**0000, ANTHROPIC IRELAND.'); // +1 €, balance says +2
  await bmail(env, '2026-10-31 15:08', 1, 134.69, 'Storno platby 4405**0000, ANTHROPIC IRELAND.'); // balance says −1
  await bmail(env, '2026-10-31 17:21', -7.17, 128.52, 'Platba kartou 4405**0000, BOLT.EU/O/2610311621'); // …and +1 more: even
  assert.deepEqual(await gaps(), []);
  assert.ok(sent.includes('deleteMessage')); // the question that briefly appeared is taken back
});

test('an answered difference stays answered; a new one later gets its own entry', async () => {
  const { env, gaps } = setup();
  await bmail(env, '2026-10-01 08:00', -1, 100);
  await bmail(env, '2026-10-01 09:00', -1, 89); // −10 unexplained
  await env.DB.prepare("UPDATE tx SET confirmed = 1 WHERE source = 'gap'").run();
  await bmail(env, '2026-10-01 10:00', -1, 78); // another −10
  assert.deepEqual(await gaps(), [-1000, -1000]);
});

test('what you chose for money from someone is not suggested for money to them', async () => {
  const { env } = setup();
  const kinds = async () => (await env.DB.prepare('SELECT amount, kind FROM tx ORDER BY n').all<{ amount: number; kind: string }>()).results;
  // Same person both ways (the b-mail names them on the Counterparty line).
  const withName = (when: string, euros: number, balance: number) =>
    ingest(env, {
      id: `p${++n}`, date: when.replace(' ', 'T'), subject: `${euros < 0 ? 'Debit' : 'Credit'} on your account (ID=1)`,
      body: `at ${when.slice(8, 10)}/${when.slice(5, 7)}/${when.slice(0, 4)}, ${when.slice(11)} the balance on your account SK0000000000000000000000 was ${euros < 0 ? 'decreased' : 'increased'} by ${Math.abs(euros).toFixed(2)} EUR.\r\nActual balance: ${balance.toFixed(2)} EUR\r\n\r\nTransaction description: Platba 1100/000000-1234567890\r\nCounterparty account: NOVAK Jana\r\n`,
    });
  await withName('2026-10-30 11:52', 350, 400);
  await env.DB.prepare("UPDATE tx SET kind = 'income', confirmed = 1").run(); // you said: income
  await withName('2026-10-31 09:00', -60, 340);
  await withName('2026-10-31 10:00', 20, 360);
  assert.deepEqual((await kinds()).map((t) => t.kind), ['income', 'spend', 'income']); // −60 isn't "income"
});

test('savings and payments a quiet rule sorts are stored as approved, without asking in the chat', async () => {
  const { env, sent } = setup();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('rules', ?)").bind('[{"match":["pension fund"],"kind":"ignore","quiet":true}]').run();
  // A round-up into savings…
  await ingest(env, {
    id: `s${++n}`, date: '2026-10-22T09:20', subject: 'Account savings credit (ID=221026/000000-2)',
    body: 'at 22/10/2026, 09:20 the balance on your savings Novak Jan Savings was increased by 0.59 EUR.\r\nLedger balance: 8.77 EUR\r\nActual balance: 8.77 EUR\r\nDispo balance: 8.77 EUR\r\n\r\nTransaction description: Sporenie kartou\r\n',
  });
  // …and the monthly pension payment.
  await ingest(env, {
    id: `s${++n}`, date: '2026-11-02T12:00', subject: 'Debit on your account (ID=1)',
    body: 'at 02/11/2026, 12:00 the balance on your account SK0000000000000000000000 was decreased by 20.00 EUR.\r\nActual balance: 80.00 EUR\r\n\r\nTransaction description: Trvaly prikaz\r\nCounterparty account: PENSION FUND a.s.\r\n',
  });
  const rows = (await env.DB.prepare('SELECT amount, kind, confirmed FROM tx ORDER BY n').all()).results;
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { amount: -59, kind: 'savings', confirmed: 1 },
    { amount: -2000, kind: 'ignore', confirmed: 1 },
  ]);
  assert.equal(sent.filter((m) => m === 'sendMessage').length, 0);
});
