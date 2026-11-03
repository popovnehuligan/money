import { isKind, learnLender, newCategory, parseDebts, parseRules } from './classify.ts';
import { addCategory, getCategories, getSetting, setSetting, updateTx, type Env, type Tx } from './db.ts';
import { addMonths, monthOf } from './time.ts';
import { passOnSort } from './ingest.ts';
import { footerFor } from './reports.ts';
import { edit, txKeyboard, txText } from './telegram.ts';

export class BadInput extends Error {}

export interface Choice {
  kind?: string;
  category?: string;
  worth?: number | null; // 1 worth it, 2 necessary, 0 regret, null not rated
  debt?: string; // which loan a 🤝 Loan payment pays back (a name from the debts setting)
  newCategory?: string; // a category you typed, e.g. "🎮 Games": created if it's new, then picked
  label?: string | null; // your own name for the payment; empty (or the bank's name) goes back to the bank's
  amount?: number; // cents; only for entries you added yourself
  ts?: string; // "YYYY-MM-DDTHH:MM"; only for entries you added yourself
  half?: string | null; // half of this payment paid back that loan (a name from debts); null undoes it
  repay?: { debt: string; amount: number } | null; // part (or all) of a payment out that paid back a loan, in cents; null undoes it
  countsFor?: string | null; // 'YYYY-MM': the month it counts for (a wage paid early); its own month or null resets
}

/**
 * Applies what you picked (in Telegram or in the dashboard) and keeps the Telegram
 * message for that payment in sync, so both places always show the same thing.
 */
export async function applyChoice(env: Env, t: Tx, c: Choice): Promise<Tx> {
  const patch: Partial<Tx> = {};
  let cats = await getCategories(env.DB);
  if (c.newCategory !== undefined) {
    const made = newCategory(c.newCategory, cats);
    if (!made) throw new BadInput('Type a name for it, e.g. 🎮 Games');
    const [id, label] = made;
    if (!(id in cats)) {
      await addCategory(env.DB, id, label);
      cats = await getCategories(env.DB);
    }
    c = { ...c, category: id };
  }
  if (c.category !== undefined) {
    if (!(c.category in cats)) throw new BadInput(`Unknown category "${c.category}"`);
    // A pass-on pair's category (e.g. ⛑️ Psychologist, which mom pays for) is never spending: it's
    // 🔁 Passed on, or 🤝 paying her back while you owe her and her money doesn't cover it.
    const pass = parseRules(await getSetting(env.DB, 'rules')).find((r) => r.passOnFrom && r.category === c.category);
    if (pass) {
      const s = await passOnSort(env, pass, patch.amount ?? t.amount);
      Object.assign(patch, { kind: s.kind, category: c.category, debt: s.debt, loan_part: null, confirmed: 1 });
    } else Object.assign(patch, { kind: 'spend', category: c.category, confirmed: 1 });
  }
  if (c.kind !== undefined) {
    if (!isKind(c.kind)) throw new BadInput(`Unknown kind "${c.kind}"`);
    Object.assign(patch, { kind: c.kind, confirmed: 1 });
    if (c.kind !== 'spend' && c.kind !== 'cash' && t.loan_part) patch.loan_part = null; // only money going out can pay a loan back
  }
  if (c.worth !== undefined) {
    if (c.worth !== null && c.worth !== 0 && c.worth !== 1 && c.worth !== 2) throw new BadInput('worth must be 1 (worth it), 2 (necessary), 0 (regret) or null');
    patch.worth = c.worth;
  }
  if (c.label !== undefined) {
    const label = String(c.label ?? '').trim().slice(0, 60);
    patch.label = label && label !== (t.merchant ?? t.note) ? label : null;
  }
  if (c.amount !== undefined || c.ts !== undefined) {
    if (t.source === 'bmail') throw new BadInput('Bank payments keep the bank’s amount and time.');
    if (c.amount !== undefined) {
      const amount = Math.round(Number(c.amount));
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e8) throw new BadInput('Enter an amount.');
      patch.amount = amount;
    }
    if (c.ts !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(c.ts))) throw new BadInput('Pick a date and time.');
      patch.ts = c.ts;
    }
  }
  if (c.countsFor !== undefined) {
    const own = monthOf(patch.ts ?? t.ts), m = c.countsFor;
    if (m !== null && ![addMonths(own, -1), own, addMonths(own, 1)].includes(String(m))) throw new BadInput('A payment can count for its own month or the one before or after.');
    patch.month = m === own ? null : m;
  }
  let debts = parseDebts(await getSetting(env.DB, 'debts'));
  const full = Math.abs(patch.amount ?? t.amount);
  const repay = c.repay !== undefined ? c.repay : c.half !== undefined ? (c.half === null ? null : { debt: c.half, amount: Math.round(full / 2) }) : undefined;
  if (repay !== undefined) {
    if (repay === null) Object.assign(patch, { loan_part: null, debt: null });
    else {
      if (!debts.some((d) => d.name === repay.debt)) throw new BadInput(`Unknown loan "${repay.debt}"`);
      const kind = patch.kind ?? t.kind;
      if ((kind !== 'spend' && kind !== 'cash') || t.amount >= 0) throw new BadInput('Only money going out can pay a loan back. For money you borrowed, pick 🤝 Loan.');
      const part = Math.round(Number(repay.amount));
      if (!Number.isFinite(part) || part <= 0 || part > full) throw new BadInput(`Pay back between 0,01 and ${(full / 100).toFixed(2).replace('.', ',')} € of it.`);
      Object.assign(patch, { loan_part: -part, debt: repay.debt });
    }
  } else if (patch.amount !== undefined && t.loan_part) patch.loan_part = -Math.min(Math.abs(t.loan_part), Math.abs(patch.amount));
  if (c.debt !== undefined) {
    if (!debts.some((d) => d.name === c.debt)) throw new BadInput(`Unknown loan "${c.debt}"`);
    Object.assign(patch, { kind: 'loan', debt: c.debt, confirmed: 1 });
    // A bank payment's counterparty is the lender: later payments to them sort themselves.
    if (t.source === 'bmail') await setSetting(env.DB, 'debts', JSON.stringify((debts = learnLender(debts, c.debt, t.merchant))));
  }
  await updateTx(env.DB, t.n, patch);
  const updated = { ...t, ...patch };
  if (updated.tg_msg) await edit(env, updated.tg_msg, txText(updated, await footerFor(env, updated), cats), txKeyboard(updated, false, debts.map((d) => d.name), cats));
  return updated;
}
