// These samples are INVENTED to look like typical Slovak bank notifications.
// No real b-mail was available when this was written: replace them with real,
// redacted b-mails (and adjust src/parse.ts) as soon as you have some.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBmail } from '../src/parse.ts';

test('card payment with balance on the same line', () => {
  const tx = parseBmail(
    'b-mail: Platba kartou',
    'Dňa 18.10.2026 o 14:32 bola zrealizovaná platba kartou **** 1234.\nObchodník: LIDL SK 0123 BRATISLAVA\nSuma: 12,50 EUR, Disponibilný zostatok: 1 234,56 EUR',
  );
  assert.deepEqual(tx, {
    amount: -1250,
    currency: 'EUR',
    balance: 123456,
    merchant: 'LIDL SK 0123 BRATISLAVA',
    ibans: [],
    note: undefined,
    method: 'card',
    ts: '2026-10-18T14:32',
  });
});

test('incoming transfer is positive and keeps counterparty IBAN and message', () => {
  const tx = parseBmail(
    'b-mail: Prijatá platba',
    'Na Váš účet SK** **** 9999 bola pripísaná suma 500,00 EUR.\nPlatiteľ: Jana Nováková\nProtiúčet: SK31 1200 0000 1987 4263 7541\nSpráva pre prijímateľa: job 14.10.\nZostatok: 1 734,56 EUR',
  );
  assert.equal(tx?.amount, 50000);
  assert.equal(tx?.balance, 173456);
  assert.equal(tx?.merchant, 'Jana Nováková');
  assert.deepEqual(tx?.ibans, ['SK3112000000198742637541']);
  assert.equal(tx?.note, 'job 14.10.');
  assert.equal(tx?.method, 'transfer');
});

test('outgoing transfer with explicit minus sign', () => {
  const tx = parseBmail('Pohyb na účte', 'Debet: -400,00 EUR\nPríjemca: Peter Malý\nIBAN príjemcu: SK89 0900 0000 0051 2345 6789');
  assert.equal(tx?.amount, -40000);
  assert.equal(tx?.merchant, 'Peter Malý');
  assert.equal(tx?.method, 'transfer');
});

test('English wording, decimal point and inline merchant', () => {
  const tx = parseBmail('Card payment', 'Card payment of 7.80 EUR at BOLT.EU/O/2410 on 19.10.2026 08:05. Available balance 980.00 EUR');
  assert.equal(tx?.amount, -780);
  assert.equal(tx?.balance, 98000);
  assert.equal(tx?.merchant, 'BOLT.EU/O/2410');
  assert.equal(tx?.ts, '2026-10-19T08:05');
});

test('foreign-currency card payment prefers the EUR amount', () => {
  const tx = parseBmail('Platba kartou', 'Platba kartou 10,00 USD (9,21 EUR) u obchodníka STEAM GAMES');
  assert.equal(tx?.amount, -921);
  assert.equal(tx?.currency, 'EUR');
  assert.equal(tx?.merchant, 'STEAM GAMES');
});

test('ATM withdrawal', () => {
  const tx = parseBmail('Výber z bankomatu', 'Výber hotovosti 50,00 EUR, bankomat TB Hodžovo nám.');
  assert.equal(tx?.amount, -5000);
  assert.equal(tx?.method, 'atm');
});

test('messages without an amount or a direction are left for a human', () => {
  assert.equal(parseBmail('Nový výpis', 'Váš výpis za september je pripravený.'), null);
  assert.equal(parseBmail('Info', 'Suma 20,00 EUR'), null);
});
