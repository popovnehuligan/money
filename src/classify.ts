import { fold } from './parse.ts';

// spend/income count as expenses/income. savings = moves to/from your savings
// account (shown as "saved", never as spending). podmoga ("Passed on") = money you
// only pass on, like podmoga jobs or a parent's money for a bill: only the net of
// in minus out counts. loan = borrowing or paying back: it changes what you
// owe (see Debt), never income or spending. ignore = moves between your own
// accounts that shouldn't count at all.
export type Kind = 'spend' | 'income' | 'savings' | 'podmoga' | 'loan' | 'ignore';

export const KINDS: Record<Kind, string> = {
  spend: '💸 Spend',
  income: '💰 Income',
  savings: '🏦 Savings',
  podmoga: '🔁 Passed on',
  loan: '🤝 Loan',
  ignore: '🚫 Ignore',
};

export const CATEGORIES: Record<string, string> = {
  food: '🛒 Groceries',
  eat: '☕ Cafés & bars',
  transport: '🚕 Transport',
  fun: '🎉 Fun',
  home: '🏠 Home & bills',
  health: '💊 Health',
  shop: '🛍 Shopping',
  other: '📦 Other',
};

export const isKind = (k: string): k is Kind => k in KINDS;

export const defaultKind = (amount: number): Kind => (amount < 0 ? 'spend' : 'income');

/**
 * Key for "same merchant / same counterparty", used to reuse your earlier choices.
 * Card merchants carry terminal numbers and towns ("LIDL SK 0123 BRATISLAVA"),
 * so only the first two words of the letters-only name are kept.
 */
export function keyFor(merchant?: string, iban?: string): string | undefined {
  if (iban) return iban;
  if (!merchant) return undefined;
  const words = fold(merchant).replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
  return words.length ? words.slice(0, 2).join(' ') : undefined;
}

/**
 * Your own sorting rules, kept in the `rules` setting (not in this public repo), e.g.
 * [{"match":["cafe hub"],"multipleOf":150,"max":900,"category":"eat"}]: payments up to 9 €
 * to a name containing "cafe hub" that are a multiple of 1.50 € go to cafés & bars. Other
 * payments to that name are left for you to sort instead of reusing the earlier choice.
 *
 * With `passOnFrom`, a rule pairs someone else's money with the bill it pays, e.g.
 * [{"match":["dr novak"],"passOnFrom":["mom name"],"category":"health"}]: money from mom is
 * 🔁 Passed on, and so is a payment to Dr Novak while some of mom's money is still waiting.
 * When none is, you paid yourself, so it's spending in `category`.
 */
export interface Rule {
  match: string[];
  multipleOf?: number; // cents
  max?: number; // cents
  category: string;
  passOnFrom?: string[];
}

export function parseRules(json: string | null): Rule[] {
  try {
    const rules: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(rules) ? rules.filter((r): r is Rule => Array.isArray(r?.match) && r.category in CATEGORIES) : [];
  } catch {
    return [];
  }
}

type Name = string | null | undefined;
const mentions = (list: string[], names: Name[]) => {
  const text = fold(names.filter(Boolean).join(' '));
  return list.some((m) => text.includes(fold(m)));
};

/** A category when a rule decides, 'ask' when a rule's name matches but the amount doesn't, else null. */
export function applyRules(rules: Rule[], amount: number, ...names: Name[]): string | 'ask' | null {
  if (amount >= 0) return null;
  for (const r of rules) {
    if (r.passOnFrom || !mentions(r.match, names)) continue;
    const fits = (!r.multipleOf || -amount % r.multipleOf === 0) && (!r.max || -amount <= r.max);
    return fits ? r.category : 'ask';
  }
  return null;
}

/** The pass-on rule a payment belongs to: money coming in from `passOnFrom`, or a payment to `match`. */
export function passOnRule(rules: Rule[], amount: number, ...names: Name[]): Rule | null {
  return rules.find((r) => r.passOnFrom && mentions(amount > 0 ? r.passOnFrom : r.match, names)) ?? null;
}

/** How much of that someone's money is still waiting to be passed on, given recent 🔁 Passed on payments. */
export function waitingToPassOn(rule: Rule, passedOn: { amount: number; merchant: string | null; note: string | null }[]): number {
  const people = [...rule.match, ...(rule.passOnFrom ?? [])];
  return passedOn.filter((t) => mentions(people, [t.merchant, t.note])).reduce((sum, t) => sum + t.amount, 0);
}

/**
 * Money you owe, kept in the `debts` setting, e.g. [{"name":"Mom","match":["kovac maria"],"amount":10000}]:
 * 100 € owed to Mom when tracking started. 🤝 Loan payments to them count it down, money
 * they lend you counts it up. `match` holds their name as the bank shows it (database only).
 */
export interface Debt {
  name: string;
  match: string[];
  amount: number; // cents
}

export function parseDebts(json: string | null): Debt[] {
  try {
    const debts: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(debts) ? debts.filter((d): d is Debt => typeof d?.name === 'string' && Array.isArray(d.match) && Number.isFinite(d.amount)) : [];
  } catch {
    return [];
  }
}

/** The debt a payment is about: the one whose names it mentions, else (for 🤝 Loan payments) the first. */
export function debtFor(debts: Debt[], ...names: Name[]): Debt | undefined {
  return debts.find((d) => d.match.length && mentions(d.match, names)) ?? debts[0];
}

type LoanTx = { amount: number; merchant: string | null; note: string | null };

export interface Owed {
  name: string;
  borrowed: number; // the starting amount plus anything lent since
  paid: number;
  owed: number;
}

/** Where each debt stands, given every 🤝 Loan payment so far. */
export function owed(debts: Debt[], loans: LoanTx[]): Owed[] {
  const sums = new Map(debts.map((d) => [d, { name: d.name, borrowed: d.amount, paid: 0, owed: 0 }]));
  for (const t of loans) {
    const s = sums.get(debtFor(debts, t.merchant, t.note)!);
    if (!s) continue;
    if (t.amount > 0) s.borrowed += t.amount;
    else s.paid -= t.amount;
  }
  return [...sums.values()].map((s) => ({ ...s, owed: s.borrowed - s.paid }));
}

/** "Mom: 60 € to go · 40 € of 100 € paid back", or a cheer when it's done. */
export function owedText(o: Owed, eur: (cents: number) => string): string {
  const name = o.name.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!); // Telegram HTML
  if (o.owed <= 0) return `🎉 ${name} is paid back in full.`;
  return `${name}: <b>${eur(o.owed)}</b> to go · ${eur(o.paid)} of ${eur(o.borrowed)} paid back`;
}

/** A payment to someone you still owe is a repayment. */
export function isRepayment(debts: Debt[], loans: LoanTx[], amount: number, ...names: Name[]): boolean {
  if (amount >= 0) return false;
  const d = debts.find((x) => x.match.length && mentions(x.match, names));
  return !!d && owed([d], loans.filter((t) => debtFor(debts, t.merchant, t.note) === d))[0].owed > 0;
}
