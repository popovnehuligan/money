import { fold } from './parse.ts';

// spend/income count as expenses/income. savings = moves to/from your savings
// account (shown as "saved", never as spending). podmoga ("Passed on") = money you
// only pass on, like podmoga jobs or a parent's money for a bill: only the net of
// in minus out counts. ignore = moves between your own
// accounts that shouldn't count at all.
export type Kind = 'spend' | 'income' | 'savings' | 'podmoga' | 'ignore';

export const KINDS: Record<Kind, string> = {
  spend: '💸 Spend',
  income: '💰 Income',
  savings: '🏦 Savings',
  podmoga: '🔁 Passed on',
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
