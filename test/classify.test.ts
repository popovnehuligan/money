import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CATEGORIES, applyRules, categoriesFrom, debtFor, keyFor, newCategory, learnLender, owed, owedText, parseDebts, parseRules, passOnRule, repaymentOf, waitingToPassOn } from '../src/classify.ts';

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
  assert.deepEqual(parseRules('[{"match":["x"]}]'), []); // no category
  assert.equal(parseRules('[{"match":["x"],"category":"games"}]').length, 1); // your own categories are fine
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
  assert.equal(repaymentOf(debts, [], -4000, 'KOVAC Maria')?.name, 'Mom');
  assert.equal(repaymentOf(debts, [], 4000, 'KOVAC Maria'), undefined); // money from them is something else
  assert.equal(repaymentOf(debts, [], -4000, 'LIDL SK'), undefined);
  assert.equal(repaymentOf(debts, [{ amount: -10000, merchant: 'KOVAC Maria', note: null }], -500, 'KOVAC Maria'), undefined);
  assert.equal(repaymentOf(parseDebts('[{"name":"Mom","match":[],"amount":10000}]'), [], -4000, 'KOVAC Maria'), undefined); // name not known yet
});

const two = parseDebts('[{"name":"Mom","match":["kovac maria"],"amount":10000},{"name":"Ben","match":[],"amount":17520}]');

test('with two loans, a payment goes to the one you picked, else the name it mentions', () => {
  assert.equal(debtFor(two, { amount: -2000, merchant: 'SMITH Ben', note: null, debt: 'Ben' })?.name, 'Ben');
  assert.equal(debtFor(two, { amount: -2000, merchant: 'KOVAC Maria', note: null })?.name, 'Mom');
  assert.equal(debtFor(two, { amount: -2000, merchant: 'SMITH Ben', note: null }), undefined); // unknown: wait for a pick
  assert.deepEqual(owed(two, [{ amount: -2000, merchant: 'SMITH Ben', note: null }]).map((o) => o.owed), [10000, 17520]);
});

test("picking a loan for a bank payment teaches the lender's bank name", () => {
  const learned = learnLender(two, 'Ben', 'SMITH Ben');
  assert.deepEqual(learned.map((d) => d.match), [['kovac maria'], ['SMITH Ben']]);
  assert.equal(repaymentOf(learned, [], -3000, 'SMITH Ben')?.name, 'Ben');
  assert.deepEqual(learnLender(learned, 'Mom', 'SMITH Ben').map((d) => d.match), [['kovac maria', 'SMITH Ben'], []]); // moved, not copied
});

test('your categories come after the built-in ones, before Other', () => {
  const cats = categoriesFrom('{"games":"🎮 Games"}');
  assert.deepEqual(Object.keys(cats).slice(-2), ['games', 'other']);
  assert.equal(cats.taxi, '🚕 Taxi');
  assert.deepEqual(categoriesFrom('not json'), categoriesFrom(null));
});

test('typing a category: emoji kept, a tag when there is none, same name reuses it', () => {
  assert.deepEqual(newCategory('🎮 games', DEFAULT_CATEGORIES), ['games', '🎮 Games']);
  assert.deepEqual(newCategory('🎮Games', DEFAULT_CATEGORIES), ['games', '🎮 Games']);
  assert.deepEqual(newCategory('  vape shop ', DEFAULT_CATEGORIES), ['vape-shop', '🏷 Vape shop']);
  assert.deepEqual(newCategory('parking', DEFAULT_CATEGORIES), ['parking', '🅿️ Parking']); // already there
  assert.deepEqual(newCategory('Žltý taxík', DEFAULT_CATEGORIES), ['zlty-taxik', '🏷 Žltý taxík']);
  assert.deepEqual(newCategory('💆🏻‍♀️ Kate', DEFAULT_CATEGORIES), ['kate', '💆🏻‍♀️ Kate']); // skin tone and ♀ stay in the emoji
  assert.deepEqual(newCategory('💝 kate', categoriesFrom('{"kate":"💆🏻‍♀️ Kate"}')), ['kate', '💆🏻‍♀️ Kate']); // same name, whatever the emoji
  assert.deepEqual(newCategory('🇸🇰 Slovak stuff', DEFAULT_CATEGORIES), ['slovak-stuff', '🇸🇰 Slovak stuff']);
  assert.equal(newCategory('🎮', DEFAULT_CATEGORIES), null);
  assert.equal(newCategory('123', DEFAULT_CATEGORIES), null);
});

test('Bolt cabs and scooters learn separately; card shops still ignore terminal and town', () => {
  assert.equal(keyFor('BOLT.EU/O/2410'), 'bolt eu o');
  assert.equal(keyFor('BOLT.EU/P/2610211312'), 'bolt eu p');
  assert.notEqual(keyFor('BOLT.EU/O/2410'), keyFor('BOLT.EU/P/2610211312'));
  assert.equal(keyFor('LIDL SK 0123 BRATISLAVA'), 'lidl sk');
});
