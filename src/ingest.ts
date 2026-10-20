import { applyRules, defaultKind, keyFor, repaymentOf, parseDebts, parseRules, passOnRule, waitingToPassOn, type Kind } from './classify.ts';
import { debtNames, getSetting, insertTx, insertUnparsed, latestBmail, learned, loanPayments, passedOnSince, updateTx, type Env, type NewTx, type Tx } from './db.ts';
import { parseBmail } from './parse.ts';
import { footerFor } from './reports.ts';
import { esc, send, txKeyboard, txText } from './telegram.ts';
import { addDays, dayOf } from './time.ts';

export interface IngestMessage {
  id: string; // Gmail message id, used to skip duplicates
  date: string; // local "YYYY-MM-DDTHH:MM" when the e-mail arrived
  subject: string;
  body: string;
  silent?: boolean; // backfill: store, but don't ping Telegram
}

/**
 * Stores a transaction, sorted by your rules first (pass-on pairs, repayments to someone
 * you owe, name rules), else by your last choice for the same merchant/counterparty.
 * Null if already stored.
 */
export async function record(env: Env, t: Omit<NewTx, 'key' | 'kind' | 'category'>, key = keyFor(t.merchant ?? undefined, t.iban ?? undefined)): Promise<Tx | null> {
  const store = (kind: Kind, category: string | null, debt?: string) => insertTx(env.DB, { ...t, key: key ?? null, kind, category, debt });
  const rules = parseRules(await getSetting(env.DB, 'rules'));

  const pass = passOnRule(rules, t.amount, t.merchant, t.note);
  if (pass && t.amount > 0) return store('podmoga', null);
  if (pass) {
    const waiting = waitingToPassOn(pass, await passedOnSince(env.DB, addDays(dayOf(t.ts), -60)));
    return waiting >= -t.amount ? store('podmoga', null) : store('spend', pass.category);
  }

  const debts = parseDebts(await getSetting(env.DB, 'debts'));
  const repaid = debts.length ? repaymentOf(debts, await loanPayments(env.DB), t.amount, t.merchant, t.note) : undefined;
  if (repaid) return store('loan', null, repaid.name);

  const rule = applyRules(rules, t.amount, t.merchant, t.note);
  if (rule) return store('spend', rule === 'ask' ? null : rule);
  const prior = key ? await learned(env.DB, key) : null;
  return store(prior?.kind ?? defaultKind(t.amount), prior?.category ?? null);
}

export async function notify(env: Env, t: Tx, header?: string): Promise<void> {
  const text = txText(t, await footerFor(env, t));
  const id = await send(env, header ? `${header}\n\n${text}` : text, txKeyboard(t, false, await debtNames(env.DB)));
  if (id) await updateTx(env.DB, t.n, { tg_msg: id });
}

export async function ingest(env: Env, msg: IngestMessage): Promise<'new' | 'duplicate' | 'unparsed'> {
  const parsed = parseBmail(msg.subject, msg.body);
  if (!parsed) {
    const isNew = await insertUnparsed(env.DB, msg.id, msg.date, msg.subject, msg.body);
    if (isNew && !msg.silent) {
      await send(
        env,
        `🤔 I couldn't read this e-mail from Tatra banka, so it isn't counted (it stays in your inbox):\n<b>${esc(msg.subject)}</b>\n${esc(msg.body.slice(0, 400))}\n\nIf it was a payment, type it in, e.g. <code>12.50 lidl</code>.`,
      );
    }
    return 'unparsed'; // the forwarder only archives mails that were read as payments
  }

  const own = (env.OWN_IBANS ?? '').split(',').map((s) => s.replace(/\s/g, '')).filter(Boolean);
  const prev = await latestBmail(env.DB);
  const tx = await record(env, {
    ext_id: msg.id,
    ts: parsed.ts ?? msg.date,
    amount: parsed.amount,
    currency: parsed.currency,
    balance: parsed.balance ?? null,
    merchant: parsed.merchant ?? null,
    iban: parsed.ibans.find((i) => !own.includes(i)) ?? null,
    note: parsed.note ?? null,
    method: parsed.method,
    source: 'bmail',
    raw: `${msg.subject}\n${msg.body}`,
  });
  if (!tx) return 'duplicate';

  // b-mail skips some movements (standing orders, fees). If the balance moved more than
  // this payment explains, record the difference so it can be sorted (e.g. as 🏦 Savings).
  // Keyed by amount, so a recurring "−100 € gap" you marked as savings is recognised next time.
  if (tx.balance !== null && prev?.balance != null && prev.ts <= tx.ts && (await getSetting(env.DB, 'gaps')) !== 'off') {
    const gap = tx.balance - (prev.balance + tx.amount);
    if (gap !== 0) {
      const g = await record(
        env,
        { ext_id: `gap-${msg.id}`, ts: tx.ts, amount: gap, currency: 'EUR', balance: null, merchant: 'Unexplained balance change', iban: null, note: null, method: 'gap', source: 'gap', raw: null },
        `gap ${gap}`,
      );
      if (g && !msg.silent) await notify(env, g, '⚖️ Your balance moved by more than the b-mails explain. A standing order, a fee, a savings transfer?');
    }
  }

  if (!msg.silent) await notify(env, tx);
  return 'new';
}
