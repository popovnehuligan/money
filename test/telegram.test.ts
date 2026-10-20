import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tx } from '../src/db.ts';
import { txKeyboard } from '../src/telegram.ts';

const tx = (over: Partial<Tx> = {}): Tx => ({
  n: 7, ext_id: 'g', ts: '2026-10-19T09:00', amount: -760, currency: 'EUR', balance: null, merchant: 'BOLT', iban: null, note: null,
  method: 'card', key: 'bolt', kind: 'spend', category: null, worth: null, confirmed: 0, source: 'bmail', tg_msg: null, ...over,
});
const texts = (kb: ReturnType<typeof txKeyboard>) => kb.map((row) => row.map((b) => b.text));

test('unsorted payments get categories, rating and kinds', () => {
  const kb = texts(txKeyboard(tx()));
  assert.equal(kb.length, 5); // 2 category rows, worth row, 2 kind rows
  assert.deepEqual(kb[0], ['🛒', '☕', '🚕', '🎉']);
  assert.deepEqual(kb.slice(3), [['✓ Spend', '🔁 Passed on'], ['🏦 Savings', '🚫 Ignore']]);
});

test('sorted payments collapse to one summary button plus rating', () => {
  const kb = texts(txKeyboard(tx({ category: 'transport', confirmed: 1, worth: 1 })));
  assert.deepEqual(kb, [['🚕 Transport · change'], ['✓ Worth it', '👎 Regret']]);
  assert.deepEqual(texts(txKeyboard(tx({ kind: 'podmoga', confirmed: 1 }))), [['🔁 Passed on · change']]);
});

test('"change" expands the full keyboard again; manual entries can be deleted', () => {
  const kb = texts(txKeyboard(tx({ category: 'transport', confirmed: 1, source: 'manual' }), true));
  assert.equal(kb.length, 6);
  assert.deepEqual(kb[0], ['🛒', '☕', '✓ 🚕', '🎉']);
  assert.deepEqual(kb[5], ['🗑 Delete']);
});

test('money coming in only gets the kinds, two per row', () => {
  assert.deepEqual(texts(txKeyboard(tx({ amount: 25000, kind: 'income' }))), [['✓ Income', '🔁 Passed on'], ['🏦 Savings', '🚫 Ignore']]);
});
