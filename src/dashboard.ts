// Everything the dashboard shows for one month, as one plain object. Pure, so the
// Worker and the design preview (preview/demo.ts) build it the same way.
import { CATEGORIES } from './classify.ts';
import type { Tx } from './db.ts';
import { safeToSpend, summarize, type StatTx } from './stats.ts';
import { addMonths, daysInMonth, monthName, monthOf } from './time.ts';

export interface DashboardSettings {
  budget: number | null; // cents per month
  goalName: string | null;
  goalAmount: number | null; // cents
  savingsStart: number; // cents already in savings before tracking started
}

export function readSettings(s: Record<string, string>): DashboardSettings {
  const cents = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));
  return {
    budget: cents(s.budget),
    goalName: s.goal_name || null,
    goalAmount: cents(s.goal_amount),
    savingsStart: cents(s.savings_start) ?? 0,
  };
}

const METHOD: Record<string, string> = { card: 'Card', transfer: 'Transfer', atm: 'ATM', cash: 'Cash', gap: 'Balance change', other: 'Bank' };

export interface DashboardInput {
  month: string;
  today: string;
  txs: Tx[]; // this month, newest first
  prevTxs: StatTx[]; // previous month
  settings: DashboardSettings;
  savedByMonth: { month: string; saved: number }[]; // newest first, every month with savings
  streak: number;
}

export function dashboard(o: DashboardInput) {
  const current = o.month === monthOf(o.today);
  const s = o.settings;
  const prev = summarize(o.prevTxs);
  const savedTotal = o.savedByMonth.reduce((sum, m) => sum + m.saved, 0);
  // Pace for the goal: average of the last three months you saved anything in.
  const recent = o.savedByMonth.filter((m) => m.saved > 0).slice(0, 3);
  return {
    month: o.month,
    name: monthName(o.month),
    prevName: monthName(addMonths(o.month, -1)),
    current,
    today: o.today,
    days: daysInMonth(o.month),
    budget: s.budget,
    safe: current && s.budget !== null ? safeToSpend(s.budget, o.txs, o.today) : null,
    streak: current ? o.streak : 0,
    summary: summarize(o.txs),
    prev: { realIncome: prev.realIncome, realSpent: prev.realSpent, saved: prev.saved },
    savings: {
      goalName: s.goalName,
      goalAmount: s.goalAmount,
      start: s.savingsStart,
      total: s.savingsStart + savedTotal,
      perMonth: recent.length ? Math.round(recent.reduce((sum, m) => sum + m.saved, 0) / recent.length) : 0,
    },
    categories: CATEGORIES,
    tx: o.txs.map((t) => ({
      n: t.n,
      ts: t.ts,
      amount: t.amount,
      kind: t.kind,
      category: t.category,
      worth: t.worth,
      confirmed: t.confirmed === 1,
      label: t.merchant ?? t.note ?? METHOD[t.method] ?? t.method,
      method: METHOD[t.method] ?? t.method,
      deletable: t.source !== 'bmail',
    })),
  };
}

export type Dashboard = ReturnType<typeof dashboard>;
