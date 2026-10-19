import { CATEGORIES, isKind } from './classify.ts';
import { updateTx, type Env, type Tx } from './db.ts';
import { footerFor } from './reports.ts';
import { edit, txKeyboard, txText } from './telegram.ts';

export class BadInput extends Error {}

export interface Choice {
  kind?: string;
  category?: string;
  worth?: number | null;
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
  await updateTx(env.DB, t.n, patch);
  const updated = { ...t, ...patch };
  if (updated.tg_msg) await edit(env, updated.tg_msg, txText(updated, await footerFor(env, updated)), txKeyboard(updated));
  return updated;
}
