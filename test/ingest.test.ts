// Runs b-mails through ingest() against a real SQLite database built from migrations/, with
// Telegram stubbed out, to check the balance-gap logic end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../src/db.ts';
import { applyChoice } from '../src/actions.ts';
import { owed, parseDebts } from '../src/classify.ts';
import { fundIds, fundMonths, getTx, loanPayments, txInMonth } from '../src/db.ts';
import { ingest, record } from '../src/ingest.ts';
import { api } from '../src/miniapp.ts';
import { handleUpdate, type Update } from '../src/bot.ts';
import { summarize } from '../src/stats.ts';

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

test('cash out of an ATM is suggested as 💵 Cash: not spending, waiting for your ✅', async () => {
  const { env } = setup();
  await bmail(env, '2026-10-19 11:15', -10, 90, 'Vyber z bankomatu 4405**0000, SOME ATM');
  const t = await env.DB.prepare('SELECT kind, method, confirmed FROM tx').first();
  assert.deepEqual({ ...t }, { kind: 'cash', method: 'atm', confirmed: 0 });
});

test('while you owe mom, a session her money does not cover is paying her back; once paid, it is passed on again', async () => {
  const { env } = setup();
  const set = (k: string, v: string) => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(k, v).run();
  await set('rules', '[{"match":["dr novak"],"passOnFrom":["kovac maria"],"multipleOf":3500,"max":14000,"category":"health"}]');
  await set('debts', '[{"name":"Mom","match":["KOVAC Maria"],"amount":5000}]');
  let balance = 100;
  const transfer = (when: string, euros: number, name: string) =>
    ingest(env, {
      id: `t${++n}`, date: when.replace(' ', 'T'), subject: `${euros < 0 ? 'Debit' : 'Credit'} on your account (ID=1)`,
      body: `at ${when.slice(8, 10)}/${when.slice(5, 7)}/${when.slice(0, 4)}, ${when.slice(11)} the balance on your account SK0000000000000000000000 was ${euros < 0 ? 'decreased' : 'increased'} by ${Math.abs(euros).toFixed(2)} EUR.\r\nActual balance: ${(balance += euros).toFixed(2)} EUR\r\n\r\nTransaction description: Platba 1100/000000-1234567890\r\nCounterparty account: ${name}\r\n`,
    });
  await transfer('2026-11-03 10:00', 35, 'KOVAC Maria'); // mom's money for a session
  await transfer('2026-11-03 18:00', -35, 'DR NOVAK Peter'); // paid with it
  await transfer('2026-11-10 18:00', -35, 'DR NOVAK Peter'); // yours: pays back 35 of the 50 €
  await transfer('2026-11-17 18:00', -35, 'DR NOVAK Peter'); // yours: 15 € left, so it pays that off
  await transfer('2026-11-24 18:00', -35, 'DR NOVAK Peter'); // nothing owed any more: from your own pocket
  const rows = (await env.DB.prepare("SELECT kind, debt FROM tx WHERE source = 'bmail' ORDER BY n").all<{ kind: string; debt: string | null }>()).results;
  assert.deepEqual(rows.map((r) => `${r.kind}${r.debt ? ` ${r.debt}` : ''}`), ['podmoga', 'podmoga', 'loan Mom', 'loan Mom', 'podmoga']);
});

test('marking half of a payment as paying back a loan counts the loan down and halves the spending', async () => {
  const { env } = setup();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('debts', ?)").bind('[{"name":"Friend","match":[],"amount":10000}]').run();
  await bmail(env, '2026-10-10 23:00', -12, 88, 'Platba kartou 4405**0000, SOME BAR');
  const t = (await getTx(env.DB, 1))!;
  await applyChoice(env, t, { category: 'eat' });
  await applyChoice(env, (await getTx(env.DB, 1))!, { half: 'Friend' });
  const after = (await getTx(env.DB, 1))!;
  assert.deepEqual([after.kind, after.category, after.loan_part, after.debt], ['spend', 'eat', -600, 'Friend']);
  const debts = parseDebts('[{"name":"Friend","match":[],"amount":10000}]');
  assert.equal(owed(debts, await loanPayments(env.DB))[0].owed, 9400);
  assert.equal(summarize([after]).spent, 600);
  await applyChoice(env, after, { half: null }); // undo
  assert.equal((await getTx(env.DB, 1))!.loan_part, null);
  await assert.rejects(applyChoice(env, (await getTx(env.DB, 1))!, { half: 'Nobody' }));
});

test('a wage paid early can count for next month; an income rule names who paid', async () => {
  const { env } = setup();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('rules', ?)").bind('[{"match":["employer"],"in":true,"multipleOf":35000,"max":35000,"kind":"income","label":"Day job"}]').run();
  await ingest(env, {
    id: `w${++n}`, date: '2026-10-30T11:52', subject: 'Credit on your account (ID=1)',
    body: 'at 30/10/2026, 11:52 the balance on your account SK0000000000000000000000 was increased by 350.00 EUR.\r\nActual balance: 400.00 EUR\r\n\r\nTransaction description: Platba 1100/000000-1234567890\r\nCounterparty account: EMPLOYER s.r.o.\r\n',
  });
  const t = (await getTx(env.DB, 1))!;
  assert.deepEqual([t.kind, t.label], ['income', 'Day job']);
  await applyChoice(env, t, { countsFor: '2026-11' });
  assert.equal((await txInMonth(env.DB, '2026-10')).length, 0);
  assert.deepEqual((await txInMonth(env.DB, '2026-11')).map((x) => [x.amount, x.month]), [[35000, '2026-11']]);
  await assert.rejects(applyChoice(env, (await getTx(env.DB, 1))!, { countsFor: '2027-01' })); // only next door
  await applyChoice(env, (await getTx(env.DB, 1))!, { countsFor: '2026-10' }); // back to its own month
  assert.equal((await getTx(env.DB, 1))!.month, null);
});

test('any part of money going out can pay a loan back, a cash withdrawal included', async () => {
  const { env } = setup();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('debts', ?)").bind('[{"name":"Friend","match":[],"amount":17520}]').run();
  await bmail(env, '2026-11-02 17:17', -180, 20, 'Vyber kartou 4405**0000, SOME STREET BRATISLAVA');
  const atm = (await getTx(env.DB, 1))!;
  assert.equal(atm.kind, 'cash');
  await applyChoice(env, atm, { repay: { debt: 'Friend', amount: 17500 } }); // 175 € of the 180 € taken out
  const debts = parseDebts('[{"name":"Friend","match":[],"amount":17520}]');
  assert.equal(owed(debts, await loanPayments(env.DB))[0].owed, 20); // 0,20 € to go
  await assert.rejects(applyChoice(env, (await getTx(env.DB, 1))!, { repay: { debt: 'Friend', amount: 18001 } })); // more than the payment
  await applyChoice(env, (await getTx(env.DB, 1))!, { repay: { debt: 'Friend', amount: 18000 } }); // all of it
  // 4,80 € more than you owed: now they owe you that
  assert.deepEqual((({ dir, owed: o, net }) => [dir, o, net])(owed(debts, await loanPayments(env.DB))[0]), ['owed', 480, 480]);
  await applyChoice(env, (await getTx(env.DB, 1))!, { kind: 'ignore' }); // not money out to anyone: the repayment goes
  assert.equal((await getTx(env.DB, 1))!.loan_part, null);
});

test('picking the category of a pass-on pair never makes it spending', async () => {
  const { env } = setup();
  const set = (k: string, v: string) => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(k, v).run();
  await set('rules', '[{"match":["dr novak"],"passOnFrom":["kovac maria"],"multipleOf":3500,"max":14000,"category":"health"}]');
  await set('debts', '[{"name":"Mom","match":["KOVAC Maria"],"amount":3000}]');
  const cash = (euros: number, name: string) => record(env, { ext_id: `c${++n}`, ts: '2026-11-03T21:55', amount: Math.round(euros * 100), currency: 'EUR', balance: null, merchant: name, iban: null, note: null, method: 'cash', source: 'manual', raw: null });
  const session = (await cash(-35, 'Therapist in cash'))!; // typed in, so no name rule matched: plain spending
  assert.equal(session.kind, 'spend');
  await applyChoice(env, session, { category: 'health' }); // you pick the therapy category
  const t = (await getTx(env.DB, session.n))!;
  assert.deepEqual([t.kind, t.debt, t.category], ['loan', 'Mom', 'health']); // you owed mom 30 €: this pays her back
  const next = (await cash(-35, 'Therapist in cash'))!;
  await applyChoice(env, next, { category: 'health' });
  assert.equal((await getTx(env.DB, next.n))!.kind, 'podmoga'); // nothing owed any more: passed on, not spending
});

test('split a bill with someone, then their transfer pays it back without counting as earnings', async () => {
  const { env } = setup();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('debts', ?)").bind('[{"name":"Alex","match":[],"amount":0,"dir":"owed"}]').run();
  await bmail(env, '2026-11-06 18:00', -25, 75, 'Platba kartou 4405**0000, SOME GROCER');
  const bill = (await getTx(env.DB, 1))!;
  await applyChoice(env, bill, { category: 'food' });
  await applyChoice(env, (await getTx(env.DB, 1))!, { repay: { debt: 'Alex', amount: 1250 } }); // half was theirs
  const alex = async () => owed(parseDebts((await env.DB.prepare("SELECT value FROM settings WHERE key = 'debts'").first<{ value: string }>())!.value), await loanPayments(env.DB))[0];
  assert.equal((await alex()).owed, 1250);
  assert.equal(summarize([(await getTx(env.DB, 1))!]).spent, 1250); // only your half is spending
  // Their transfer: 20 €, of which 12,50 € pays you back.
  await ingest(env, { id: `k${++n}`, date: '2026-11-07T10:00', subject: 'Credit on your account (ID=1)', body: 'at 07/11/2026, 10:00 the balance on your account SK0000000000000000000000 was increased by 20.00 EUR.\r\nActual balance: 95.00 EUR\r\n\r\nTransaction description: Platba 1100/000000-1234567890\r\nCounterparty account: NOVAKOVA Eva\r\n' });
  const transfer = (await getTx(env.DB, 2))!;
  await applyChoice(env, transfer, { repay: { debt: 'Alex', amount: 1250 } });
  assert.equal((await alex()).owed, 0);
  const s = summarize([(await getTx(env.DB, 2))!]);
  assert.deepEqual([s.income, s.earned], [750, 750]); // the 12,50 € back isn't earnings
  // Known by their bank name now: next time their money pays the debt by itself.
  await applyChoice(env, (await getTx(env.DB, 1))!, { repay: { debt: 'Alex', amount: 2500 } }); // say they owe the whole bill
  await ingest(env, { id: `k${++n}`, date: '2026-11-08T10:00', subject: 'Credit on your account (ID=1)', body: 'at 08/11/2026, 10:00 the balance on your account SK0000000000000000000000 was increased by 12.50 EUR.\r\nActual balance: 107.50 EUR\r\n\r\nTransaction description: Platba 1100/000000-1234567890\r\nCounterparty account: NOVAKOVA Eva\r\n' });
  assert.deepEqual([(await getTx(env.DB, 3))!.kind, (await getTx(env.DB, 3))!.debt], ['loan', 'Alex']);
});

test('a cash entry saved twice (a second tap, a retry) is stored once', async () => {
  const { env, sent } = setup();
  // The dashboard's requests carry Telegram's initData, signed with the bot token, from the owner.
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 1, first_name: 'M' }) };
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const hash = createHmac('sha256', createHmac('sha256', 'WebAppData').update('t').digest()).update(check).digest('hex');
  const initData = new URLSearchParams({ ...fields, hash }).toString();
  const cash = async (body: Record<string, unknown>) => {
    const res = await api(env, new Request('https://x/api/cash', { method: 'POST', headers: { 'x-init-data': initData }, body: JSON.stringify(body) }), new URL('https://x/api/cash'));
    assert.equal(res.status, 200);
  };
  const rows = async () => (await env.DB.prepare("SELECT amount, merchant FROM tx WHERE source = 'manual' ORDER BY n").all<{ amount: number; merchant: string }>()).results.map((r) => `${r.merchant} ${r.amount}`);

  // the same form sent three times: one entry, one chat message
  for (let i = 0; i < 3; i++) await cash({ id: 'form-aaaa-1111', amount: -320, note: 'Coffee', category: 'food' });
  assert.deepEqual(await rows(), ['Coffee -320']);
  assert.equal(sent.filter((m) => m === 'sendMessage').length, 1);
  // the next form is a new entry, even with the same amount
  await cash({ id: 'form-bbbb-2222', amount: -320, note: 'Coffee', category: 'food' });
  assert.equal((await rows()).length, 2);
  // an older copy of the app sends no id: the same details in the same minute are one entry
  await cash({ amount: -1500, note: 'Market', ts: '2026-11-12T18:05' });
  await cash({ amount: -1500, note: 'Market', ts: '2026-11-12T18:05' });
  await cash({ amount: -1500, note: 'Market', ts: '2026-11-12T18:09' });
  assert.deepEqual((await rows()).slice(2), ['Market -1500', 'Market -1500']);
});

test('money in from someone you owe can be marked: it counts as borrowing more; after lending, as being paid back', async () => {
  const { env } = setup();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('debts', ?)").bind('[{"name":"Sam","match":["NOVAK Sam"],"amount":0,"dir":"owe"}]').run();
  const add = (euros: number, ts: string, kind: 'spend' | 'income') => record(env, { ext_id: `s${++n}`, ts, amount: Math.round(euros * 100), currency: 'EUR', balance: null, merchant: 'NOVAK Sam', iban: null, note: null, method: 'transfer', source: 'manual', raw: null }, undefined, kind);
  const lent = (await add(-6, '2026-11-17T13:08', 'spend'))!;
  await applyChoice(env, lent, { repay: { debt: 'Sam', amount: 600 } }); // you lent them 6 €
  const back = (await add(5, '2026-11-18T10:04', 'income'))!;
  await applyChoice(env, back, { repay: { debt: 'Sam', amount: 500 } }); // their 5 € back: allowed, even though the debt started your way
  const sam = owed(parseDebts((await env.DB.prepare("SELECT value FROM settings WHERE key = 'debts'").first<{ value: string }>())!.value), await loanPayments(env.DB))[0];
  assert.deepEqual([sam.dir, sam.owed], ['owed', 100]); // they still owe you 1 €
  assert.equal(summarize(await txInMonth(env.DB, '2026-11')).earned, 0); // being paid back isn't earnings
});

/** Telegram's initData for the owner (chat 1), as the dashboard sends it. */
function ownerInitData(): string {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 1, first_name: 'M' }) };
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const hash = createHmac('sha256', createHmac('sha256', 'WebAppData').update('t').digest()).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

test('closing a debt forgives what was left and takes it out of the lists; reopening brings it back', async () => {
  const { env } = setup();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('debts', ?)").bind('[{"name":"Sam","match":["NOVAK Sam"],"amount":1000,"dir":"owe"},{"name":"Alex","match":[],"amount":0,"dir":"owe"}]').run();
  const call = async (body: Record<string, unknown>) => {
    const res = await api(env, new Request('https://x/api/debt', { method: 'POST', headers: { 'x-init-data': ownerInitData() }, body: JSON.stringify(body) }), new URL('https://x/api/debt'));
    assert.equal(res.status, 200);
    return res.json() as Promise<{ debts: { name: string; dir: string; owed: number }[]; loans: { name: string; closed?: boolean }[] }>;
  };
  // You owed Sam 10 €: closing forgives it, and Sam leaves the lists (kept under Closed).
  let d = await call({ name: 'Sam', close: true });
  assert.deepEqual(d.debts.map((o) => o.name), ['Alex']);
  assert.equal(d.loans.find((l) => l.name === 'Sam')?.closed, true);
  // Back, even.
  d = await call({ name: 'Sam', reopen: true });
  assert.deepEqual(d.debts.map((o) => [o.name, o.owed]), [['Sam', 0], ['Alex', 0]]);
  // Closed again, and back as "they owe me 5 €".
  await call({ name: 'Sam', close: true });
  d = await call({ name: 'Sam', reopen: true, now: 500 });
  assert.deepEqual((({ dir, owed: o }) => [dir, o])(d.debts.find((o) => o.name === 'Sam')!), ['owed', 500]);
  // Saving the debts from the app (Alex's start edited) keeps what was forgiven.
  const res = await api(env, new Request('https://x/api/settings', { method: 'POST', headers: { 'x-init-data': ownerInitData() }, body: JSON.stringify({ loans: [{ name: 'Sam', amount: 1000, dir: 'owe' }, { name: 'Alex', amount: 300, dir: 'owe' }] }) }), new URL('https://x/api/settings'));
  const after = (await res.json()) as { debts: { name: string; dir: string; owed: number }[] };
  assert.deepEqual(after.debts.map((o) => [o.name, o.dir, o.owed]), [['Sam', 'owed', 500], ['Alex', 'owe', 300]]);
});

test('📦 Other asks what it was: the reply names the payment, or moves it to a category you name', async () => {
  const { env, sent } = setup();
  const pay = (id: string, cents: number) => record(env, { ext_id: id, ts: '2026-11-19T12:00', amount: cents, currency: 'EUR', balance: null, merchant: 'SOME SHOP', iban: null, note: null, method: 'card', source: 'bmail', raw: null });
  const tap = (n: number) => handleUpdate(env, { callback_query: { id: 'q', data: `c:other:${n}`, message: { message_id: 50, chat: { id: 1 } } } } as Update);
  const asked = async () => JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'pending_category'").first<{ value: string }>())!.value) as { msg: number; other?: boolean };
  const reply = async (text: string) => handleUpdate(env, { message: { message_id: 60, chat: { id: 1 }, text, reply_to_message: { message_id: (await asked()).msg } } } as Update);

  const a = (await pay('o1', -1200))!;
  await tap(a.n);
  assert.equal((await asked()).other, true); // "📦 What was it?" went out
  assert.ok(sent.includes('sendMessage'));
  await reply('haircut');
  assert.deepEqual((({ category, label }) => [category, label])((await getTx(env.DB, a.n))!), ['other', 'haircut']);

  const b = (await pay('o2', -800))!;
  await tap(b.n);
  await reply('food'); // the name of a category you have: it goes there
  assert.equal((await getTx(env.DB, b.n))!.category, 'food');
});

test('🏐 club money: suggested for dues and by its words, never income or spending, tracked by month', async () => {
  const { env } = setup();
  const set = (k: string, v: string) => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(k, v).run();
  await set('categories', '{"volleyball":"🏐 Volleyball"}');
  await set('funds', '[{"id":"volleyball","dues":1000,"match":["volejbal"]}]');
  const pay = async (id: string, cents: number, merchant: string, note: string | null = null, source = 'bmail') =>
    (await record(env, { ext_id: id, ts: '2026-11-19T12:00', amount: cents, currency: 'EUR', balance: null, merchant, iban: null, note, method: 'transfer', source, raw: null }))!;
  const a = await pay('v1', 1000, 'NOVAK Peter');
  assert.deepEqual([a.kind, a.category, a.confirmed], ['fund', 'volleyball', 0]); // 10 € from someone new: suggested as dues
  assert.equal((await pay('v2', 4000, 'HORVATH Jana')).kind, 'income'); // 40 €: not dues
  assert.equal((await pay('v3', 2500, 'BALAZ Eva', 'volejbal november')).kind, 'fund'); // says what it's for
  assert.equal((await pay('v4', 1000, 'gift', null, 'manual')).kind, 'income'); // typed in yourself: you said what it was
  // A pot's category makes it club money, out too; another kind takes the pot away.
  const hall = await pay('v5', -3500, 'SPORT HALL');
  await applyChoice(env, hall, { category: 'volleyball' });
  assert.deepEqual((({ kind, category }) => [kind, category])((await getTx(env.DB, hall.n))!), ['fund', 'volleyball']);
  await applyChoice(env, a, { kind: 'income' });
  assert.deepEqual((({ kind, category }) => [kind, category])((await getTx(env.DB, a.n))!), ['income', null]);
  // Never yours: the 25 € in and 35 € out aren't in earnings or spending.
  const s = summarize(await txInMonth(env.DB, '2026-11'));
  assert.deepEqual([s.income, s.spent], [6000, 0]); // 40 € + 10 € gift + the 10 € moved back to income
  assert.deepEqual((await fundMonths(env.DB)).map((r) => ({ ...r })), [{ fund: 'volleyball', month: '2026-11', in: 2500, out: 3500, count: 2 }]); // November: −10 €
});

test('money back: a card refund goes back to what it reverses, chip-ins lower that spending, and none of it is income', async () => {
  const { env } = setup();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('categories', ?)").bind('{"party":"🎂 Party"}').run();
  const pay = async (id: string, ts: string, cents: number, merchant: string, note: string | null = null) =>
    (await record(env, { ext_id: id, ts, amount: cents, currency: 'EUR', balance: null, merchant, iban: null, note, method: cents < 0 ? 'card' : 'transfer', source: 'bmail', raw: null }))!;
  // A friend's earlier transfer was passed on: that's what's learned for them.
  await applyChoice(env, await pay('p0', '2026-11-01T10:00', 4500, 'NOVAKOVA Eva'), { kind: 'podmoga' });
  const booking = await pay('p1', '2026-11-17T15:17', -28405, 'LODGING * ABC');
  await applyChoice(env, booking, { category: 'party' });
  // Cancelled: the card refund is sorted like the payment it reverses, as money back (not income).
  const storno = await pay('p2', '2026-11-18T12:43', 28405, '', 'Storno platby 4405**0000, LODGING.COM.');
  assert.deepEqual([storno.kind, storno.category, storno.confirmed], ['spend', 'party', 0]);
  await applyChoice(env, await pay('p3', '2026-11-22T00:21', -27000, 'LODGING * DEF'), { category: 'party' }); // rebooked
  // Two people chip in for it: money back for the party, not earnings.
  const eva = await pay('p4', '2026-11-17T13:04', 20000, 'NOVAKOVA Eva');
  await applyChoice(env, eva, { kind: 'spend' });
  await applyChoice(env, eva, { category: 'party' });
  await applyChoice(env, await pay('p5', '2026-11-17T15:18', 5000, 'SMITH Ann'), { kind: 'spend', category: 'party' });
  const s = summarize(await txInMonth(env.DB, '2026-11'));
  assert.deepEqual(s.byCategory, [['party', 2000]]); // what it cost you: 270 € − 200 € − 50 €
  assert.equal(s.spent, 2000);
  assert.equal(s.income, 0);
  // One-off: the friend's next transfer is suggested as before (passed on), not as money back for the party.
  assert.equal((await pay('p6', '2026-11-25T09:00', 4500, 'NOVAKOVA Eva')).kind, 'podmoga');
});

test('a gift pot: start it with a goal, collect chip-ins, close it into a category so only your share is spending', async () => {
  const { env } = setup();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('categories', ?)").bind('{"friend":"💐 Friend"}').run();
  const call = async (path: string, body: Record<string, unknown>) => {
    const res = await api(env, new Request(`https://x${path}`, { method: 'POST', headers: { 'x-init-data': ownerInitData() }, body: JSON.stringify(body) }), new URL(`https://x${path}`));
    const d = (await res.json()) as { error?: string; funds: { id: string; held: number; goal?: number; closed?: boolean }[]; categories: Record<string, string> };
    assert.equal(res.status, 200, d.error);
    return d;
  };
  let d = await call('/api/fund', { add: '🎁 Gift', goal: 6000 });
  const id = Object.keys(d.categories).find((c) => d.categories[c] === '🎁 Gift')!;
  assert.deepEqual(d.funds.map((f) => [f.id, f.goal]), [[id, 6000]]);
  const pay = async (n: string, cents: number, who: string) => (await record(env, { ext_id: n, ts: '2026-11-22T10:00', amount: cents, currency: 'EUR', balance: null, merchant: who, iban: null, note: null, method: 'transfer', source: 'bmail', raw: null }))!;
  for (const [n, who] of [['g1', 'NOVAK Peter'], ['g2', 'BALAZ Eva']]) await applyChoice(env, await pay(n, 2000, who), { category: id }); // two chip-ins
  await applyChoice(env, await pay('g3', -6000, 'GIFT SHOP'), { category: id }); // the gift, bought for 60 €
  // Done: counted as your spending on your friend, chip-ins as money back there. Your share: 20 €.
  d = await call('/api/fund', { id, close: true, into: 'friend' });
  assert.equal(d.funds.find((f) => f.id === id)?.closed, true);
  const s = summarize(await txInMonth(env.DB, '2026-11'));
  assert.deepEqual([s.byCategory, s.income], [[['friend', 2000]], 0]);
  assert.deepEqual(await fundIds(env.DB), []); // closed: not offered on payments any more
  d = await call('/api/fund', { id, reopen: true });
  assert.deepEqual(await fundIds(env.DB), [id]);
});

test('a closed pot is never suggested again, even for someone who paid into it', async () => {
  const { env } = setup();
  const set = (k: string, v: string) => env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(k, v).run();
  await set('categories', '{"gift":"🎁 Gift"}');
  await set('funds', '[{"id":"gift"}]');
  const pay = async (n: string, ts: string) => (await record(env, { ext_id: n, ts, amount: 1500, currency: 'EUR', balance: null, merchant: 'NOVAK Peter', iban: null, note: null, method: 'transfer', source: 'bmail', raw: null }))!;
  await applyChoice(env, await pay('c1', '2026-11-20T10:00'), { category: 'gift' }); // chipped in
  assert.deepEqual((({ kind, category }) => [kind, category])(await pay('c2', '2026-11-21T10:00')), ['fund', 'gift']); // while it's open: suggested
  await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'funds'").bind('[{"id":"gift","closed":true}]').run();
  assert.equal((await pay('c3', '2026-11-25T10:00')).kind, 'income'); // closed: just money in, to sort
});
