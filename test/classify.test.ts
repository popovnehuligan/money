import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CATEGORIES, collectionOf, categoryEmoji, joinGap, applyRules, categoriesFrom, categoryLabel, debtFor, keyFor, newCategory, learnLender, owed, owedText, parseDebts, parseRules, passOnRule, repaymentOf } from '../src/classify.ts';

const rules = parseRules('[{"match":["novak","cafe hub"],"multipleOf":150,"max":900,"category":"eat"}]');
const category = (r: ReturnType<typeof applyRules>) => (r && r !== 'ask' ? r.category : r);

test('a rule sorts matching payments that are a multiple of the amount', () => {
  assert.equal(category(applyRules(rules, -150, 'NOVAK Jan', 'Platba 1100/000000-1234567890')), 'eat');
  assert.equal(category(applyRules(rules, -450, null, 'Café Hub o.z.')), 'eat');
});

test('a rule can sort into a kind instead, quietly', () => {
  const quiet = parseRules('[{"match":["pension fund"],"kind":"ignore","quiet":true},{"match":["x"],"kind":"nonsense"}]');
  assert.equal(quiet.length, 1); // a kind that doesn't exist is dropped
  const r = applyRules(quiet, -2000, 'PENSION FUND a.s.');
  assert.ok(r && r !== 'ask' && r.kind === 'ignore' && r.quiet);
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

const therapy = parseRules('[{"match":["dr novak"],"passOnFrom":["kovac maria"],"multipleOf":3500,"max":14000,"category":"health"}]');

test('money from someone else and the bill it pays belong to their pass-on rule', () => {
  assert.equal(passOnRule(therapy, 3500, 'KOVAC Maria')?.category, 'health');
  assert.equal(passOnRule(therapy, -3500, 'DR NOVAK Peter')?.category, 'health');
  assert.equal(passOnRule(therapy, -3500, 'KOVAC Maria'), null); // money you send them is something else
  assert.equal(applyRules(therapy, -3500, 'DR NOVAK Peter'), null); // and plain rules leave it alone
});

test('only their money that fits the amounts is passed on; other money from them is not', () => {
  assert.ok(passOnRule(therapy, 7000, 'KOVAC Maria')); // two sessions
  assert.equal(passOnRule(therapy, 35000, 'KOVAC Maria'), null); // a gift: over the max
  assert.equal(passOnRule(therapy, 2000, 'KOVAC Maria'), null); // not a multiple of 35 €
  assert.ok(passOnRule(therapy, -7000, 'DR NOVAK Peter')); // every session payment, whoever paid for it
});

const debts = parseDebts('[{"name":"Mom","match":["kovac maria"],"amount":10000}]');
const eur = (c: number) => `${c / 100} €`;

test('a loan counts down with repayments and up with more borrowing', () => {
  const repaid = { amount: -4000, merchant: 'KOVAC Maria', note: null };
  assert.deepEqual(owed(debts, [repaid]), [{ name: 'Mom', dir: 'owe', net: -6000, borrowed: 10000, paid: 4000, owed: 6000 }]);
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
  assert.deepEqual(newCategory('💆🏻‍♀️ Spa', DEFAULT_CATEGORIES), ['spa', '💆🏻‍♀️ Spa']); // skin tone and ♀ stay in the emoji
  assert.deepEqual(newCategory('💝 spa', categoriesFrom('{"spa":"💆🏻‍♀️ Spa"}')), ['spa', '💆🏻‍♀️ Spa']); // same name, whatever the emoji
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

test('renaming categories: typed emoji wins, else the old one stays; Other stays last', () => {
  assert.equal(categoryLabel('🍻 pub', '🍺'), '🍻 Pub');
  assert.equal(categoryLabel('pub', '🍺'), '🍺 Pub');
  assert.equal(categoryLabel('  ', '🍺'), null);
  const cats = categoriesFrom('{"eat":"🍻 Pub","other":"📦 Misc","games":"🎮 Games"}');
  assert.equal(cats.eat, '🍻 Pub');
  assert.deepEqual(Object.keys(cats).slice(-2), ['games', 'other']);
  assert.equal(cats.other, '📦 Misc');
  assert.equal(Object.keys(cats).indexOf('eat'), Object.keys(DEFAULT_CATEGORIES).indexOf('eat')); // keeps its place
});

test('a balance difference joins the open one from the last 6 hours', () => {
  const open = { amount: 100, ts: '2026-10-31T15:08', confirmed: 0 };
  assert.deepEqual(joinGap(open, -200, '2026-10-31T15:08'), { join: true, amount: -100 });
  assert.deepEqual(joinGap(open, -100, '2026-10-31T20:00'), { join: true, amount: 0 });
  assert.deepEqual(joinGap(open, -100, '2026-11-01T08:00'), { join: false, amount: -100 }); // too long ago
  assert.deepEqual(joinGap({ ...open, confirmed: 1 }, -100, '2026-10-31T15:09'), { join: false, amount: -100 }); // already answered
  assert.deepEqual(joinGap(null, 50, '2026-10-31T15:09'), { join: false, amount: 50 });
});

test('a category label\'s emoji, however many code points it has', () => {
  assert.equal(categoryEmoji('💆🏻‍♀️ Spa'), '💆🏻‍♀️');
  assert.equal(categoryEmoji('🅿️ Parking'), '🅿️');
  assert.equal(categoryEmoji('Vape'), null);
});

test('a built-in category you deleted is gone; Other stays whatever happens', () => {
  const cats = categoriesFrom('{"health":null,"home":null,"other":null,"coffee-food":"☕ Cafe"}');
  assert.ok(!('health' in cats) && !('home' in cats));
  assert.equal(cats['coffee-food'], '☕ Cafe');
  assert.equal(Object.keys(cats).at(-1), 'other');
});

test('rules for money coming in: who pays you gets your name for them', () => {
  const r = parseRules('[{"match":["kovac"],"in":true,"kind":"income","label":"Studio work"},{"match":["novak"],"in":true,"multipleOf":35000,"max":35000,"kind":"income","label":"Day job"}]');
  const side = applyRules(r, 25000, 'KOVAC Peter');
  assert.ok(side && side !== 'ask' && side.label === 'Studio work');
  assert.equal((applyRules(r, 35000, 'NOVAK Maria') as { label: string }).label, 'Day job');
  assert.equal(applyRules(r, 1500, 'NOVAK Maria'), 'ask'); // other money from her: yours to sort
  assert.equal(applyRules(r, -2000, 'KOVAC Peter'), null); // money you send them isn't covered
});

test('someone who owes you: what you paid for them counts it up, what they send you counts it down', () => {
  const alex = parseDebts('[{"name":"Alex","match":["novakova eva"],"amount":0,"dir":"owed"}]');
  const half = { amount: -1250, merchant: 'LIDL', note: null, debt: 'Alex' }; // half of a 25 € grocery bill was theirs
  assert.deepEqual(owed(alex, [half]), [{ name: 'Alex', dir: 'owed', net: 1250, borrowed: 1250, paid: 0, owed: 1250 }]);
  const back = { amount: 1250, merchant: 'NOVAKOVA Eva', note: null, debt: 'Alex' };
  assert.equal(owed(alex, [half, back])[0].owed, 0);
  assert.equal(owedText(owed(alex, [half])[0], eur), 'Alex owes you <b>12.5 €</b> · 0 € of 12.5 € paid back');
  assert.equal(owedText(owed(alex, [half, back])[0], eur), '🎉 Alex paid you back in full.');
  assert.equal(collectionOf(alex, [half], 1250, 'NOVAKOVA Eva')?.name, 'Alex'); // their money in: paying you back
  assert.equal(collectionOf(alex, [half, back], 500, 'NOVAKOVA Eva'), undefined); // nothing owed any more
  assert.equal(repaymentOf(alex, [half], -1000, 'NOVAKOVA Eva'), undefined); // money to them isn’t you paying them back
});

test('one balance per person: overpay someone you owe and they owe you the difference', () => {
  // Borrowed 100 € from a friend, paid back 102,32 € in halves of bills: they owe you 2,32 €.
  const friend = parseDebts('[{"name":"Sam","match":["NOVAK Sam"],"amount":0,"dir":"owe"}]');
  const lent = { ts: '2026-10-12T12:00', amount: 10000, merchant: 'NOVAK Sam', note: null };
  const back = [5390, 722, 810, 840, 600, 700, 600, 570].map((c, i) => ({ ts: `2026-10-${15 + i}T12:00`, amount: -c, merchant: 'Bar', note: null, debt: 'Sam' }));
  const now = owed(friend, [lent, ...back])[0];
  assert.deepEqual([now.dir, now.net, now.owed, now.borrowed, now.paid], ['owed', 232, 232, 232, 0]); // the overshoot is a new debt their way
  assert.equal(owedText(now, (c) => `${c / 100} €`), 'Sam owes you <b>2.32 €</b> · 0 € of 2.32 € paid back');
  // You lend them 6 € more, they send 5 € back: they still owe you 3,32 €.
  const more = [{ ts: '2026-11-17T13:08', amount: -600, merchant: 'NOVAK Sam', note: null, debt: 'Sam' }, { ts: '2026-11-18T10:04', amount: 500, merchant: 'NOVAK Sam', note: null, debt: 'Sam' }];
  const after = owed(friend, [lent, ...back, ...more])[0];
  assert.deepEqual([after.dir, after.owed, after.borrowed, after.paid], ['owed', 332, 832, 500]);
  // Without the loan, their 5 € means you borrowed: you owe them 2,68 €.
  assert.deepEqual((({ dir, owed: o }) => [dir, o])(owed(friend, [lent, ...back, more[1]])[0]), ['owe', 268]);
  // Order doesn't matter to the balance, only to "paid back" (the balance is what counts).
  assert.equal(owed(friend, [...more, ...back, lent].map(({ ts, ...t }) => t))[0].net, 332);
});

test('payments only settle a debt by themselves when they fit in it', () => {
  const mom = parseDebts('[{"name":"Mom","match":["KOVAC Maria"],"amount":0,"dir":"owe"}]');
  const over = [{ amount: 10000, merchant: 'KOVAC Maria', note: null }, { amount: -10500, merchant: 'Shop', note: null, debt: 'Mom' }]; // overpaid her by 5 €
  assert.equal(owed(mom, over)[0].net, 500); // on paper she owes you 5 €
  assert.equal(collectionOf(mom, over, 500, 'KOVAC Maria')?.name, 'Mom'); // her 5 € back: settles it
  assert.equal(collectionOf(mom, over, 4500, 'KOVAC Maria'), undefined); // her 45 € is something else: yours to sort
  const owing = [{ amount: 10000, merchant: 'KOVAC Maria', note: null }];
  assert.equal(repaymentOf(mom, owing, -4000, 'KOVAC Maria')?.name, 'Mom'); // paying back part of it
  assert.equal(repaymentOf(mom, owing, -12000, 'KOVAC Maria'), undefined); // more than you owe: not guessed
  assert.equal(collectionOf(mom, owing, 2000, 'KOVAC Maria'), undefined); // more money from her while you owe her: not guessed either
});

test('a closed debt keeps its history but is never matched automatically', () => {
  const mom = parseDebts('[{"name":"Mom","match":["KOVAC Maria"],"amount":0,"dir":"owe","closed":true}]');
  const borrowed = [{ amount: 10000, merchant: 'KOVAC Maria', note: null }];
  assert.equal(repaymentOf(mom, borrowed, -4000, 'KOVAC Maria'), undefined);
  assert.equal(collectionOf(mom, [{ amount: -10000, merchant: 'KOVAC Maria', note: null }], 4000, 'KOVAC Maria'), undefined);
  // what was forgiven counts like a payment: closing at "you owe 100 €" leaves it even
  const forgiven = parseDebts('[{"name":"Mom","match":["KOVAC Maria"],"amount":0,"dir":"owe","closed":true,"adjust":10000,"adjustedAt":"2026-11-19T10:00"}]');
  assert.deepEqual((({ net, closed }) => [net, closed])(owed(forgiven, [{ ...borrowed[0], ts: '2026-10-01T10:00' }])[0]), [0, true]);
});
