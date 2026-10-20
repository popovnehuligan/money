import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules, isRepayment, owed, owedText, parseDebts, parseRules, passOnRule, waitingToPassOn } from '../src/classify.ts';

const rules = parseRules('[{"match":["novak","cafe hub"],"multipleOf":150,"max":900,"category":"eat"}]');

test('a rule sorts matching payments that are a multiple of the amount', () => {
  assert.equal(applyRules(rules, -150, 'NOVAK Jan', 'Platba 1100/000000-1234567890'), 'eat');
  assert.equal(applyRules(rules, -450, null, 'Café Hub o.z.'), 'eat');
});

test('other payments to the same name are left for you to sort', () => {
  assert.equal(applyRules(rules, -2000, 'NOVAK Jan'), 'ask');
  assert.equal(applyRules(rules, -1500, 'NOVAK Jan'), 'ask'); // a multiple of 1.50, but over the cap
});

test('rules ignore other names, money coming in and broken settings', () => {
  assert.equal(applyRules(rules, -150, 'LIDL SK'), null);
  assert.equal(applyRules(rules, 150, 'NOVAK Jan'), null);
  assert.deepEqual(parseRules('not json'), []);
  assert.deepEqual(parseRules('[{"match":["x"],"category":"nope"}]'), []);
});

const therapy = parseRules('[{"match":["dr novak"],"passOnFrom":["kovac maria"],"category":"health"}]');

test('money from someone else and the bill it pays belong to their pass-on rule', () => {
  assert.equal(passOnRule(therapy, 3500, 'KOVAC Maria')?.category, 'health');
  assert.equal(passOnRule(therapy, -3500, 'DR NOVAK Peter')?.category, 'health');
  assert.equal(passOnRule(therapy, -3500, 'KOVAC Maria'), null); // money you send them is something else
  assert.equal(applyRules(therapy, -3500, 'DR NOVAK Peter'), null); // and plain rules leave it alone
});

test('a bill is passed on only while their money is waiting', () => {
  const rule = therapy[0];
  const mom = { amount: 3500, merchant: 'KOVAC Maria', note: null };
  const session = { amount: -3500, merchant: 'DR NOVAK Peter', note: null };
  const job = { amount: 50000, merchant: 'Event Agency', note: null };
  assert.equal(waitingToPassOn(rule, [mom]), 3500);
  assert.equal(waitingToPassOn(rule, [mom, session]), 0); // already passed on: a second session is yours
  assert.equal(waitingToPassOn(rule, [job]), 0); // podmoga money doesn't pay for therapy
});

const debts = parseDebts('[{"name":"Mom","match":["kovac maria"],"amount":10000}]');
const eur = (c: number) => `${c / 100} €`;

test('a loan counts down with repayments and up with more borrowing', () => {
  const repaid = { amount: -4000, merchant: 'KOVAC Maria', note: null };
  assert.deepEqual(owed(debts, [repaid]), [{ name: 'Mom', borrowed: 10000, paid: 4000, owed: 6000 }]);
  assert.equal(owed(debts, [repaid, { amount: 2000, merchant: 'KOVAC Maria', note: null }])[0].owed, 8000);
  assert.equal(owedText(owed(debts, [repaid])[0], eur), 'Mom: <b>60 €</b> to go · 40 € of 100 € paid back');
  assert.equal(owedText(owed(debts, [{ ...repaid, amount: -10000 }])[0], eur), '🎉 Mom is paid back in full.');
});

test('payments to someone you owe are repayments until it is paid off', () => {
  assert.equal(isRepayment(debts, [], -4000, 'KOVAC Maria'), true);
  assert.equal(isRepayment(debts, [], 4000, 'KOVAC Maria'), false); // money from them is something else
  assert.equal(isRepayment(debts, [], -4000, 'LIDL SK'), false);
  assert.equal(isRepayment(debts, [{ amount: -10000, merchant: 'KOVAC Maria', note: null }], -500, 'KOVAC Maria'), false);
  assert.equal(isRepayment(parseDebts('[{"name":"Mom","match":[],"amount":10000}]'), [], -4000, 'KOVAC Maria'), false); // name not known yet
});
