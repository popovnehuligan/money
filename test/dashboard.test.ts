import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboard, readSettings } from '../src/dashboard.ts';
import type { Tx } from '../src/db.ts';

const tx = (n: number, ts: string, amount: number, over: Partial<Tx> = {}): Tx => ({
  n, ext_id: `e${n}`, ts, amount, currency: 'EUR', balance: null, merchant: null, iban: null, note: null,
  method: 'card', key: null, kind: amount < 0 ? 'spend' : 'income', category: null, worth: null, confirmed: 0, source: 'bmail', tg_msg: null, ...over,
});

test('savings total, goal pace and labels', () => {
  const d = dashboard({
    month: '2026-10',
    today: '2026-10-19',
    txs: [tx(2, '2026-10-15T07:30', -5000, { kind: 'savings', method: 'gap', source: 'gap' }), tx(1, '2026-10-02T10:00', -1250, { merchant: 'LIDL' })],
    prevTxs: [tx(0, '2026-09-10T10:00', -3000)],
    settings: readSettings({ budget: '60000', goal_name: 'Japan', goal_amount: '200000', savings_start: '45000' }),
    savedByMonth: [{ month: '2026-10', saved: 5000 }, { month: '2026-09', saved: 18000 }, { month: '2026-08', saved: 0 }, { month: '2026-07', saved: 12000 }],
    streak: 2,
    debts: [{ name: 'Mom', borrowed: 10000, paid: 4000, owed: 6000 }],
  });
  assert.equal(d.savings.total, 45000 + 35000);
  assert.equal(d.savings.perMonth, Math.round((5000 + 18000 + 12000) / 3)); // months with nothing saved are skipped
  assert.equal(d.prev.spent, 3000);
  assert.equal(d.safe?.allowance, Math.floor((60000 - 1250) / 13));
  assert.deepEqual(d.debts, [{ name: 'Mom', borrowed: 10000, paid: 4000, owed: 6000 }]);
  assert.deepEqual(d.tx.map((t) => [t.label, t.method, t.deletable]), [['Balance change', 'Balance change', true], ['LIDL', 'Card', false]]);
});

test('past months have no allowance or streak; empty settings read as unset', () => {
  const d = dashboard({ month: '2026-09', today: '2026-10-19', txs: [], prevTxs: [], settings: readSettings({}), savedByMonth: [], streak: 5, debts: [] });
  assert.equal(d.safe, null);
  assert.equal(d.streak, 0);
  assert.equal(d.budget, null);
  assert.equal(d.savings.goalAmount, null);
});

test('your account balance is shown for the current month only', () => {
  const base = { today: '2026-11-01', txs: [], prevTxs: [], settings: readSettings({}), savedByMonth: [], streak: 0, debts: [], balance: { amount: 5981, ts: '2026-11-01T11:42' } };
  assert.deepEqual(dashboard({ ...base, month: '2026-11' }).balance, { amount: 5981, ts: '2026-11-01T11:42' });
  assert.equal(dashboard({ ...base, month: '2026-10' }).balance, null);
});

test('earnings by source: income grouped by who paid it, biggest first, plus what passed-on money left you', () => {
  const d = dashboard({
    month: '2026-10', today: '2026-10-19', prevTxs: [], settings: readSettings({}), savedByMonth: [], streak: 0, debts: [],
    txs: [
      tx(1, '2026-10-01T09:00', 35000, { merchant: 'NOVAK Maria' }),
      tx(2, '2026-10-20T09:00', 25000, { merchant: 'Client s.r.o.' }),
      tx(3, '2026-10-30T09:00', 35000, { merchant: 'NOVAK Maria' }),
      tx(4, '2026-10-05T09:00', 30000, { kind: 'podmoga', merchant: 'Job' }),
      tx(5, '2026-10-06T09:00', -15000, { kind: 'podmoga', merchant: 'Crew' }),
      tx(6, '2026-10-07T09:00', -500, { merchant: 'Shop' }),
    ],
  });
  assert.deepEqual(d.earnedFrom.sources, [{ name: 'NOVAK Maria', amount: 70000, count: 2 }, { name: 'Client s.r.o.', amount: 25000, count: 1 }]);
  assert.equal(d.earnedFrom.keptPassedOn, 15000);
  assert.equal(d.summary.earned, 70000 + 25000 + 15000);
});
