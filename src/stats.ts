import type { Kind } from './classify.ts';
import { addDays, daysInMonth, dayOf, monthOf } from './time.ts';

export interface StatTx {
  ts: string;
  amount: number;
  kind: Kind;
  category: string | null;
  worth: number | null;
  loan_part?: number | null; // part of a payment that moved a loan (paid one back, lent, or got paid back)
}

/** A payment's own part: all of it, minus any part that moved a loan (spending you're owed back, money paid back to you). */
export const ownPart = (t: Pick<StatTx, 'amount' | 'loan_part'>) => t.amount - (t.loan_part ?? 0);

export interface Summary {
  income: number; // 💰 Income payments only
  earned: number; // what you earned: income plus what you kept from passed-on money
  spent: number; // what you spent: spending plus any passed-on overdraft
  saved: number;
  // 🔁 Passed on: someone else's money through your account. Its raw amounts never count as
  // earned or spent, only its net: kept money is earned; paying out more than came in (and more
  // than was still waiting from earlier months) is an overdraft, which is spent.
  podmogaIn: number;
  podmogaOut: number;
  podmogaNet: number; // this month's change of the passed-on running total
  overdraft: number; // the part of `spent` that is passed-on overdraft
  loans: number; // borrowed minus paid back (negative when you paid back more)
  left: number; // earned - spent - saved + loans
  regret: number; // spending you marked 👎
  byCategory: [string, number][]; // biggest first
}

/** `passedOnBefore`: the passed-on running total before these payments (money still waiting to go out). */
export function summarize(txs: StatTx[], passedOnBefore = 0): Summary {
  let income = 0, spent = 0, saved = 0, podmogaIn = 0, podmogaOut = 0, loans = 0, regret = 0;
  const cats = new Map<string, number>();
  for (const t of txs) {
    if (t.kind === 'income') {
      income += ownPart(t); // part of it may be someone paying you back (loan_part): not earnings
      loans += t.loan_part ?? 0;
    }
    else if (t.kind === 'savings') saved -= t.amount;
    else if (t.kind === 'loan') loans += t.amount;
    else if (t.kind === 'podmoga') {
      if (t.amount > 0) podmogaIn += t.amount;
      else podmogaOut -= t.amount;
    } else if (t.kind === 'spend') {
      // A refund is a positive "spend" and simply lowers the total. Half a bar bill that paid a
      // loan back is half spending, half paying back.
      const own = ownPart(t);
      spent -= own;
      loans += t.loan_part ?? 0;
      const c = t.category ?? 'other';
      cats.set(c, (cats.get(c) ?? 0) - own);
      if (t.worth === 0) regret -= own;
    }
  }
  const podmogaNet = podmogaIn - podmogaOut;
  const earned = income + Math.max(0, podmogaNet);
  const overdraft = Math.max(0, -podmogaNet - Math.max(0, passedOnBefore)); // payouts beyond everything that came in
  return {
    income,
    earned,
    spent: spent + overdraft,
    saved,
    podmogaIn,
    podmogaOut,
    podmogaNet,
    overdraft,
    loans,
    left: earned - spent - overdraft - saved + loans,
    regret,
    byCategory: [...cats].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]),
  };
}

const spendOn = (txs: StatTx[], test: (day: string) => boolean) =>
  txs.reduce((sum, t) => (t.kind === 'spend' && test(dayOf(t.ts)) ? sum - ownPart(t) : sum), 0);

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
