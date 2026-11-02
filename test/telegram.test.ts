import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tx } from '../src/db.ts';
import { categoriesFrom } from '../src/classify.ts';
import { txKeyboard, txText } from '../src/telegram.ts';

const tx = (over: Partial<Tx> = {}): Tx => ({
  n: 7, ext_id: 'g', ts: '2026-10-19T09:00', amount: -760, currency: 'EUR', balance: null, merchant: 'BOLT', iban: null, note: null,
  method: 'card', key: 'bolt', kind: 'spend', category: null, worth: null, confirmed: 0, source: 'bmail', tg_msg: null, ...over,
});
const texts = (kb: ReturnType<typeof txKeyboard>) => kb.map((row) => row.map((b) => b.text));

test('unsorted payments get categories, rating and kinds', () => {
  const kb = texts(txKeyboard(tx()));
  assert.equal(kb.length, 6); // 2 category rows, worth row, 3 kind rows
  assert.deepEqual(kb.slice(0, 2), [['🚕', '🛴', '🛒', '🚬', '🅿️', '🍺'], ['🚌', '🛍', '💊', '🏠', '📦', '➕']]);
  assert.deepEqual(kb.slice(3), [['✓ Spend', '🔁 Passed on'], ['🏦 Savings', '🤝 Loan'], ['💵 Cash', '🚫 Ignore']]);
});

test('sorted payments collapse to one summary button plus rating', () => {
  const kb = texts(txKeyboard(tx({ category: 'taxi', confirmed: 1, worth: 1 })));
  assert.deepEqual(kb, [['🚕 Taxi · change'], ['✓ Worth it', '🧱 Needed', '👎 Regret']]);
  assert.deepEqual(texts(txKeyboard(tx({ category: 'taxi', confirmed: 1, worth: 2 })))[1], ['👍 Worth it', '✓ Needed', '👎 Regret']); // necessary
  assert.match(txText(tx({ category: 'taxi', confirmed: 1, worth: 2 })), /· 🧱/);
  assert.deepEqual(texts(txKeyboard(tx({ kind: 'podmoga', confirmed: 1 }))), [['🔁 Passed on · change']]);
});

test('"change" expands the full keyboard again; manual entries can be deleted', () => {
  const kb = texts(txKeyboard(tx({ category: 'taxi', confirmed: 1, source: 'manual' }), true));
  assert.equal(kb.length, 7);
  assert.deepEqual(kb[0], ['✓ 🚕', '🛴', '🛒', '🚬', '🅿️', '🍺']);
  assert.deepEqual(kb[6], ['🗑 Delete']);
});

test('money coming in only gets the kinds, two per row', () => {
  assert.deepEqual(texts(txKeyboard(tx({ amount: 25000, kind: 'income' }))), [['✅ 💰 Income'], ['✓ Income', '🔁 Passed on'], ['🏦 Savings', '🤝 Loan'], ['💵 Cash', '🚫 Ignore']]);
});

test('a loan payment asks which loan when there are two', () => {
  const loan = tx({ amount: -2000, kind: 'loan', confirmed: 1 });
  assert.deepEqual(texts(txKeyboard(loan, false, ['Mom', 'Ben'])), [['🤝 Loan · change'], ['Mom', 'Ben']]);
  assert.deepEqual(texts(txKeyboard({ ...loan, debt: 'Ben' }, false, ['Mom', 'Ben'])), [['🤝 Loan · change'], ['Mom', '✓ Ben']]);
  assert.deepEqual(texts(txKeyboard(loan, false, ['Mom'])), [['🤝 Loan · change']]); // one loan: nothing to ask
});

test('categories you added are icons in the same grid, rows kept even', () => {
  const cats = categoriesFrom('{"games":"🎮 Games","kate":"💆🏻‍♀️ Kate","gifts":"🎁 Gifts","coffee":"☕ Coffee & food","gym":"🏋️ Gym"}');
  const kb = texts(txKeyboard(tx({ category: 'kate', confirmed: 1 }), true, [], cats));
  assert.deepEqual(kb.slice(0, 3), [
    ['🚕', '🛴', '🛒', '🚬', '🅿️', '🍺'],
    ['🚌', '🛍', '💊', '🏠', '🎮', '✓ 💆🏻‍♀️'],
    ['🎁', '☕', '🏋️', '📦', '➕'],
  ]);
});

test('only categories that share an emoji show their names', () => {
  const cats = categoriesFrom('{"vape":"🏷 Vape shop","snacks":"🏷 Snacks"}');
  const kb = texts(txKeyboard(tx({ category: 'vape', confirmed: 1 }), true, [], cats));
  assert.deepEqual(kb.slice(0, 3), [['🚕', '🛴', '🛒', '🚬', '🅿️', '🍺'], ['🚌', '🛍', '💊', '🏠', '📦', '➕'], ['✓ Vape shop', '🏷 Snacks']]);
});

test('a suggestion waits for approval: ✅ on top until you confirm it', () => {
  assert.deepEqual(texts(txKeyboard(tx({ category: 'smokes' })))[0], ['✅ 🚬 Cigarettes']); // learned or imported
  assert.ok(!texts(txKeyboard(tx())).flat().some((b) => b.startsWith('✅'))); // nothing to approve without a category
  assert.deepEqual(texts(txKeyboard(tx({ category: 'smokes', confirmed: 1 })))[0], ['🚬 Cigarettes · change']); // approved
});

test('your name for a payment is what the chat shows', () => {
  assert.match(txText(tx({ merchant: 'Platba 7500/000000-123', label: 'Gift for Kate' })), /Gift for Kate/);
  assert.match(txText(tx({ merchant: 'BOLT' })), /BOLT/);
});
