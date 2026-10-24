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

export type Categories = Record<string, string>; // id → "emoji Name"

/**
 * Built-in categories. Ids are stored on payments and in rules, so they stay put when a
 * label changes ("eat" was "Eating out"). Yours, added by typing a name, live in the
 * `categories` setting and appear before 📦 Other (see categoriesFrom).
 */
export const DEFAULT_CATEGORIES: Categories = {
  taxi: '🚕 Taxi',
  scooter: '🛴 Scooter',
  food: '🛒 Food',
  smokes: '🚬 Cigarettes',
  parking: '🅿️ Parking',
  eat: '🍺 Bar',
  bus: '🚌 Bus',
  shop: '🛍 Shopping',
  health: '💊 Health',
  home: '🏠 Home & bills',
  other: '📦 Other',
};

/** Built-in categories plus the ones you added (the `categories` setting, {id: label}). */
export function categoriesFrom(json: string | null): Categories {
  let custom: Categories = {};
  try {
    const c: unknown = JSON.parse(json ?? '{}');
    if (c && typeof c === 'object' && !Array.isArray(c)) custom = Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === 'string'));
  } catch {
    // keep the built-in ones
  }
  const { other, ...built } = DEFAULT_CATEGORIES;
  const { other: myOther, ...mine } = custom; // you can rename Other, but it stays last
  return { ...built, ...mine, other: myOther ?? other };
}

/**
 * A category from what you typed: "🎮 Games" as is, "games" as "🏷 Games". Typing a name that
 * already exists returns that one. Null when there's no name in it.
 */
export function newCategory(text: string, existing: Categories): [id: string, label: string] | null {
  const label = categoryLabel(text);
  if (!label) return null;
  const nice = label.slice(label.indexOf(' ') + 1);
  const same = Object.entries(existing).find(([, l]) => fold(l.slice(l.indexOf(' ') + 1)) === fold(nice));
  if (same) return same;
  const base = fold(nice).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mine';
  let id = base;
  for (let i = 2; id in existing; i++) id = `${base}-${i}`;
  return [id, label];
}

/** "🎮 games" → "🎮 Games", "vape" → "🏷 Vape"; `fallback` is the emoji to use when none is typed. Null without a name. */
export function categoryLabel(text: string, fallback = '🏷'): string | null {
  // One emoji can be several code points: 💆🏻‍♀️ is a person + skin tone + joiner + ♀ + variation selector.
  const m = text.trim().replace(/\s+/g, ' ').match(/^((?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200D|\uFE0F)+)?\s*(.*)$/u);
  const name = m?.[2].slice(0, 24).trim();
  if (!name || !/\p{L}/u.test(name)) return null;
  return `${m?.[1] ?? fallback} ${name[0].toUpperCase()}${name.slice(1)}`;
}

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
  // "BOLT.EU/O/…" vs "BOLT.EU/P/…": the code after the web address tells kinds of ride apart.
  const n = /^[a-z0-9-]+\.[a-z]{2,3}\/[a-z]/.test(fold(merchant)) ? 3 : 2;
  return words.length ? words.slice(0, n).join(' ') : undefined;
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
    return Array.isArray(rules) ? rules.filter((r): r is Rule => Array.isArray(r?.match) && typeof r.category === 'string') : [];
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

type LoanTx = { amount: number; merchant: string | null; note: string | null; debt?: string | null };

/**
 * The loan a 🤝 Loan payment belongs to: the one you picked, else the one whose bank name
 * it mentions, else the only loan there is. Undefined while it's ambiguous (you haven't picked).
 */
export function debtFor(debts: Debt[], t: LoanTx): Debt | undefined {
  if (t.debt) return debts.find((d) => d.name === t.debt);
  return debts.find((d) => d.match.length && mentions(d.match, [t.merchant, t.note])) ?? (debts.length === 1 ? debts[0] : undefined);
}

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
    const d = debtFor(debts, t);
    const s = d && sums.get(d);
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

/** A payment to someone you still owe is a repayment of that loan. */
export function repaymentOf(debts: Debt[], loans: LoanTx[], amount: number, ...names: Name[]): Debt | undefined {
  if (amount >= 0) return undefined;
  const d = debts.find((x) => x.match.length && mentions(x.match, names));
  return d && owed([d], loans.filter((t) => debtFor(debts, t) === d))[0].owed > 0 ? d : undefined;
}

/** Picking a loan for a bank payment teaches its counterparty's name to that loan (and only that one). */
export function learnLender(debts: Debt[], name: string, bankName: string | null): Debt[] {
  if (!bankName) return debts;
  return debts.map((d) => {
    const others = d.match.filter((m) => fold(m) !== fold(bankName));
    return { ...d, match: d.name === name ? [...others, bankName] : others };
  });
}
