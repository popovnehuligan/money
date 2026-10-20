import { CATEGORIES, isKind, learnLender, parseDebts } from './classify.ts';
import { getSetting, setSetting, updateTx, type Env, type Tx } from './db.ts';
import { footerFor } from './reports.ts';
import { edit, txKeyboard, txText } from './telegram.ts';

export class BadInput extends Error {}

export interface Choice {
  kind?: string;
  category?: string;
  worth?: number | null;
  debt?: string; // which loan a 🤝 Loan payment pays back (a name from the debts setting)
}

/**
 * Applies what you picked (in Telegram or in the dashboard) and keeps the Telegram
 * message for that payment in sync, so both places always show the same thing.
 */
export async function applyChoice(env: Env, t: Tx, c: Choice): Promise<Tx> {
  const patch: Partial<Tx> = {};
  if (c.category !== undefined) {
    if (!(c.category in CATEGORIES)) throw new BadInput(`Unknown category "${c.category}"`);
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
  let debts = parseDebts(await getSetting(env.DB, 'debts'));
  if (c.debt !== undefined) {
    if (!debts.some((d) => d.name === c.debt)) throw new BadInput(`Unknown loan "${c.debt}"`);
    Object.assign(patch, { kind: 'loan', debt: c.debt, confirmed: 1 });
    // A bank payment's counterparty is the lender: later payments to them sort themselves.
    if (t.source === 'bmail') await setSetting(env.DB, 'debts', JSON.stringify((debts = learnLender(debts, c.debt, t.merchant))));
  }
  await updateTx(env.DB, t.n, patch);
  const updated = { ...t, ...patch };
  if (updated.tg_msg) await edit(env, updated.tg_msg, txText(updated, await footerFor(env, updated)), txKeyboard(updated, false, debts.map((d) => d.name)));
  return updated;
}
