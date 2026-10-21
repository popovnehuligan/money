// The first two samples follow a REAL Tatra banka b-mail, with the account, name and
// numbers replaced. The rest are invented to cover other wordings banks use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBalanceNotice, parseBmail } from '../src/parse.ts';

const TATRA = (change: string, amount: string, balance: string) =>
  `Dear client,\r\n\r\nat 20/10/2026, 14:28 the balance on your account SK0000000000000000000000 was ${change} by ${amount} EUR.\r\n` +
  `Ledger balance:                           ${balance} EUR\r\nActual balance:                           ${balance} EUR\r\nDispo balance:                            ${balance} EUR\r\n\r\n` +
  `Transaction description: Platba 1100/000000-1234567890\r\nCounterparty account: NOVAK Jan\r\n\r\nBest regards\r\n\r\nTATRA BANKA, a.s.\r\n\r\nhttp://www.tatrabanka.sk\r\n\r\n` +
  `Please delete all read bmail messages.The history of the account is in the movements via internet banking, therefore you do not need to reconstruct it from old bmail messages.\r\n`;

test('Tatra b-mail: debit', () => {
  const tx = parseBmail('Debit on your account (ID=201026/000000-2)', TATRA('decreased', '1.50', '29.79'));
  assert.deepEqual(tx, {
    amount: -150,
    currency: 'EUR',
    balance: 2979,
    merchant: 'NOVAK Jan',
    ibans: [], // the IBAN in the text is your own account, not the other party
    note: 'Platba 1100/000000-1234567890',
    method: 'transfer',
    ts: '2026-10-20T14:28',
  });
});

test('Tatra b-mail: credit', () => {
  const tx = parseBmail('Credit on your account (ID=201026/000000-3)', TATRA('increased', '1 250.00', '1 279.79'));
  assert.equal(tx?.amount, 125000);
  assert.equal(tx?.balance, 127979);
});

const balances = (eur: string) =>
  `Ledger balance:                          ${eur} EUR\r\nActual balance:                          ${eur} EUR\r\nDispo balance:                           ${eur} EUR\r\n\r\n`;

test('Tatra b-mail: card payment takes the shop from the description', () => {
  const tx = parseBmail(
    'Debit on your account (ID=211026/000000-2)',
    `Dear client,\r\n\r\nat 21/10/2026, 07:20 the balance on your account SK0000000000000000000000 was decreased by 9.15 EUR.\r\n${balances('280.64')}Transaction description: Platba kartou 4405**0000, EasyPark Slovakia s..\r\n\r\nBest regards`,
  );
  assert.equal(tx?.amount, -915);
  assert.equal(tx?.balance, 28064);
  assert.equal(tx?.merchant, 'EasyPark Slovakia s'); // not "21/10/2026"
  assert.equal(tx?.note, 'Platba kartou 4405**0000, EasyPark Slovakia s..');
  assert.equal(tx?.method, 'card');
  assert.equal(tx?.ts, '2026-10-21T07:20');
  assert.equal(tx?.savings, undefined);
});

test('Tatra b-mail: a round-up into savings is money leaving your account, without its balance', () => {
  const tx = parseBmail(
    'Account savings credit (ID=211026/000000-2)',
    `Dear client,\r\n\r\nat 21/10/2026, 10:44 the balance on your savings Novak Jan Savings was increased by 1.06 EUR.\r\n${balances('8.18')}Transaction description: Sporenie kartou\r\n\r\nBest regards`,
  );
  assert.equal(tx?.amount, -106);
  assert.equal(tx?.balance, undefined); // 8.18 € is the savings account, not your main one
  assert.equal(tx?.savings, true);
  assert.equal(tx?.note, 'Sporenie kartou');
});

test('Tatra b-mail: the daily balance notice is not a payment', () => {
  const body = `Dear client,\r\n\r\nat 21/10/2026, 07:00 the balances on your account SK0000000000000000000000 were:\r\n${balances('1 289.79')}Best regards`;
  assert.equal(parseBmail('Account balance (ID=211026/00000-2)', body), null);
  assert.equal(parseBalanceNotice('Account balance (ID=211026/00000-2)', body), 128979);
  assert.equal(parseBalanceNotice('Výpis z účtu', 'Váš výpis je pripravený.'), null);
});

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

test('bank newsletters are not payments', () => {
  const body =
    'Máme pre Vás zľavy a benefity\nNezobrazuje sa Vám tento e-mail správne? Kliknite sem <http://links.content.tatranews.sk/servlet/MailView>\nZľava 100 € pri platbe kartou u partnera.';
  assert.equal(parseBmail('Máme pre Vás zľavy a benefity', body), null);
});

test('messages without an amount or a direction are left for a human', () => {
  assert.equal(parseBmail('Nový výpis', 'Váš výpis za september je pripravený.'), null);
  assert.equal(parseBmail('Info', 'Suma 20,00 EUR'), null);
});
