import { fold } from './parse.ts';

// spend/income count as expenses/income. savings = moves to/from your savings
// account (shown as "saved", never as spending). podmoga = pass-through job
// money: only the net of in minus out counts. ignore = moves between your own
// accounts that shouldn't count at all.
export type Kind = 'spend' | 'income' | 'savings' | 'podmoga' | 'ignore';

export const KINDS: Record<Kind, string> = {
  spend: '💸 Spend',
  income: '💰 Income',
  savings: '🏦 Savings',
  podmoga: '🔁 Podmoga',
  ignore: '🚫 Ignore',
};

export const CATEGORIES: Record<string, string> = {
  food: '🛒 Groceries',
  eat: '🍔 Eating out',
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
