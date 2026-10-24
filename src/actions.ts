import { isKind, learnLender, newCategory, parseDebts } from './classify.ts';
import { addCategory, getCategories, getSetting, setSetting, updateTx, type Env, type Tx } from './db.ts';
import { footerFor } from './reports.ts';
import { edit, txKeyboard, txText } from './telegram.ts';

export class BadInput extends Error {}

export interface Choice {
  kind?: string;
  category?: string;
  worth?: number | null;
  debt?: string; // which loan a 🤝 Loan payment pays back (a name from the debts setting)
  newCategory?: string; // a category you typed, e.g. "🎮 Games": created if it's new, then picked
  label?: string | null; // your own name for the payment; empty (or the bank's name) goes back to the bank's
  amount?: number; // cents; only for entries you added yourself
  ts?: string; // "YYYY-MM-DDTHH:MM"; only for entries you added yourself
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
    Object.assign(patch, { kind: 'spend', category: c.category, confirmed: 1 });
  }
  if (c.kind !== undefined) {
    if (!isKind(c.kind)) throw new BadInput(`Unknown kind "${c.kind}"`);
    Object.assign(patch, { kind: c.kind, confirmed: 1 });
  }
  if (c.worth !== undefined) {
    if (c.worth !== null && c.worth !== 0 && c.worth !== 1) throw new BadInput('worth must be 1, 0 or null');
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
  let debts = parseDebts(await getSetting(env.DB, 'debts'));
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
