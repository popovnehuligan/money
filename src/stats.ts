import type { Kind } from './classify.ts';
import { addDays, daysInMonth, dayOf, monthOf } from './time.ts';

export interface StatTx {
  ts: string;
  amount: number;
  kind: Kind;
  category: string | null;
  worth: number | null;
}

export interface Summary {
  income: number;
  spent: number;
  saved: number;
  podmogaIn: number;
  podmogaOut: number;
  podmogaNet: number;
  realIncome: number; // income + podmoga net when positive
  realSpent: number; // spending + podmoga net when negative
  left: number; // realIncome - realSpent - saved
  regret: number; // spending you marked 👎
  byCategory: [string, number][]; // biggest first
}

export function summarize(txs: StatTx[]): Summary {
  let income = 0, spent = 0, saved = 0, podmogaIn = 0, podmogaOut = 0, regret = 0;
  const cats = new Map<string, number>();
  for (const t of txs) {
    if (t.kind === 'income') income += t.amount;
    else if (t.kind === 'savings') saved -= t.amount;
    else if (t.kind === 'podmoga') {
      if (t.amount > 0) podmogaIn += t.amount;
      else podmogaOut -= t.amount;
    } else if (t.kind === 'spend') {
      // A refund is a positive "spend" and simply lowers the total.
      spent -= t.amount;
      const c = t.category ?? 'other';
      cats.set(c, (cats.get(c) ?? 0) - t.amount);
      if (t.worth === 0) regret -= t.amount;
    }
  }
  const podmogaNet = podmogaIn - podmogaOut;
  const realIncome = income + Math.max(podmogaNet, 0);
  const realSpent = spent + Math.max(-podmogaNet, 0);
  return {
    income,
    spent,
    saved,
    podmogaIn,
    podmogaOut,
    podmogaNet,
    realIncome,
    realSpent,
    left: realIncome - realSpent - saved,
    regret,
    byCategory: [...cats].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]),
  };
}

const spendOn = (txs: StatTx[], test: (day: string) => boolean) =>
  txs.reduce((sum, t) => (t.kind === 'spend' && test(dayOf(t.ts)) ? sum - t.amount : sum), 0);

/**
 * Daily allowance that rolls over: whatever is left of the monthly budget,
 * split over the remaining days. Spend less today and every later day gets more.
 */
export function safeToSpend(budget: number, monthTxs: StatTx[], today: string) {
  const spentBefore = spendOn(monthTxs, (d) => d < today);
  const spentToday = spendOn(monthTxs, (d) => d === today);
  const daysLeft = daysInMonth(monthOf(today)) - Number(today.slice(8, 10)) + 1;
  const allowance = Math.floor((budget - spentBefore) / daysLeft);
  return { allowance, spentToday, left: allowance - spentToday };
}

/** Full days without any spending, counting back from yesterday. */
export function noSpendStreak(spendDays: Set<string>, firstDay: string, today: string): number {
  let streak = 0;
  for (let d = addDays(today, -1); d >= firstDay && !spendDays.has(d); d = addDays(d, -1)) streak++;
  return streak;
}
