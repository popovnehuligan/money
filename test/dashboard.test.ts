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
  assert.equal(d.prev.realSpent, 3000);
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
