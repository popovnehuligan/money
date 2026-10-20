import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noSpendStreak, safeToSpend, summarize, type StatTx } from '../src/stats.ts';
import { keyFor } from '../src/classify.ts';

const tx = (ts: string, amount: number, kind: StatTx['kind'], extra: Partial<StatTx> = {}): StatTx => ({
  ts,
  amount,
  kind,
  category: null,
  worth: null,
  ...extra,
});

test('podmoga pass-through only counts the net', () => {
  // 500 in, 400 out the same day: you earned 100 and spent nothing.
  const s = summarize([tx('2026-10-05T10:00', 50000, 'podmoga'), tx('2026-10-05T15:00', -40000, 'podmoga')]);
  assert.equal(s.realIncome, 10000);
  assert.equal(s.realSpent, 0);
  assert.equal(s.podmogaNet, 10000);
});

test('a podmoga job that lost money counts as spending', () => {
  const s = summarize([tx('2026-10-05T10:00', 30000, 'podmoga'), tx('2026-10-05T15:00', -35000, 'podmoga')]);
  assert.equal(s.realIncome, 0);
  assert.equal(s.realSpent, 5000);
});

test('savings transfers are saved, not spent', () => {
  const s = summarize([
    tx('2026-10-01T08:00', 150000, 'income'),
    tx('2026-10-15T00:00', -10000, 'savings'),
    tx('2026-10-16T12:00', -2000, 'spend', { category: 'eat', worth: 0 }),
    tx('2026-10-17T12:00', -3000, 'spend', { category: 'food', worth: 1 }),
    tx('2026-10-18T12:00', 500, 'spend', { category: 'food' }), // refund
  ]);
  assert.equal(s.saved, 10000);
  assert.equal(s.spent, 4500);
  assert.equal(s.regret, 2000);
  assert.equal(s.left, 150000 - 4500 - 10000);
  assert.deepEqual(s.byCategory, [['food', 2500], ['eat', 2000]]);
});

test('loans are neither income nor spending, but they move what is left', () => {
  const s = summarize([tx('2026-10-01T08:00', 150000, 'income'), tx('2026-10-20T09:00', -4000, 'loan'), tx('2026-10-21T09:00', -2000, 'spend', { category: 'food' })]);
  assert.equal(s.realIncome, 150000);
  assert.equal(s.realSpent, 2000);
  assert.equal(s.loans, -4000);
  assert.equal(s.left, 150000 - 2000 - 4000);
});

test('ignored transfers do not count anywhere', () => {
  const s = summarize([tx('2026-10-01T08:00', -20000, 'ignore')]);
  assert.equal(s.realSpent + s.realIncome + s.saved, 0);
});

test('safe to spend rolls leftovers forward', () => {
  // 31-day month, 620 budget, 100 spent before the 11th: 520 over 21 days.
  const month = [tx('2026-10-03T12:00', -10000, 'spend'), tx('2026-10-11T09:00', -500, 'spend'), tx('2026-10-11T09:30', -20000, 'savings')];
  assert.deepEqual(safeToSpend(62000, month, '2026-10-11'), { allowance: 2476, spentToday: 500, left: 1976 });
});

test('no-spend streak counts full days back from yesterday', () => {
  const days = new Set(['2026-10-15', '2026-10-19']);
  assert.equal(noSpendStreak(days, '2026-10-01', '2026-10-19'), 3);
  assert.equal(noSpendStreak(days, '2026-10-18', '2026-10-19'), 1);
});

test('merchant keys ignore terminal numbers and towns', () => {
  assert.equal(keyFor('LIDL SK 0123 BRATISLAVA'), keyFor('LIDL SK 0456 KOSICE'));
  assert.equal(keyFor('Jana', 'SK3112000000198742637541'), 'SK3112000000198742637541');
});
