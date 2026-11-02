import { applyRules, debtFor, defaultKind, joinGap, keyFor, lenderOf, owed, repaymentOf, parseDebts, parseRules, passOnRule, type Kind } from './classify.ts';
import { debtNames, deleteTx, getCategories, getSetting, insertTx, insertUnparsed, latestBmail, latestOpenGap, movedBetween, learned, loanPayments, passedOnTotal, updateTx, type Env, type NewTx, type Tx } from './db.ts';
import { parseBalanceNotice, parseBmail } from './parse.ts';
import { footerFor } from './reports.ts';
import { edit, esc, send, tg, txKeyboard, txText } from './telegram.ts';

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
 * Bank movements into or out of savings, and payments a `quiet` rule sorts, are stored as
 * approved: you asked not to be asked about them. Null if already stored.
 */
export async function record(env: Env, t: Omit<NewTx, 'key' | 'kind' | 'category'>, key = keyFor(t.merchant ?? undefined, t.iban ?? undefined), kind?: Kind): Promise<Tx | null> {
  const store = (kind: Kind, category: string | null, debt?: string, quiet = false) =>
    insertTx(env.DB, { ...t, key: key ?? null, kind, category, debt, approved: quiet || (kind === 'savings' && t.source === 'bmail') });
  if (kind) return store(kind, null);
  const rules = parseRules(await getSetting(env.DB, 'rules'));

  const pass = passOnRule(rules, t.amount, t.merchant, t.note);
  const debts = parseDebts(await getSetting(env.DB, 'debts'));
  if (pass && t.amount < 0) {
    // Their bill, paid with your own money while you owe them: that's you paying them back.
    const lender = lenderOf(debts, pass);
    if (lender && (await passedOnTotal(env.DB, pass.category)).kept < -t.amount) {
      const loans = (await loanPayments(env.DB)).filter((x) => debtFor(debts, x) === lender);
      if (owed([lender], loans)[0].owed > 0) return store('loan', null, lender.name);
    }
  }
  if (pass) return store('podmoga', pass.category ?? null);

  const repaid = debts.length ? repaymentOf(debts, await loanPayments(env.DB), t.amount, t.merchant, t.note) : undefined;
  if (repaid) return store('loan', null, repaid.name);

  const rule = applyRules(rules, t.amount, t.merchant, t.note);
  if (rule === 'ask') return store(defaultKind(t.amount), null);
  if (rule) {
    const kind = rule.kind ?? defaultKind(t.amount);
    const tx = await store(kind, kind === 'spend' ? (rule.category ?? null) : null, undefined, rule.quiet);
    if (tx && rule.label) {
      await updateTx(env.DB, tx.n, { label: rule.label }); // your name for who pays you, e.g. "Studio work"
      return { ...tx, label: rule.label };
    }
    return tx;
  }
  const prior = key ? await learned(env.DB, key, t.amount) : null;
  if (prior) return store(prior.kind, prior.category);
  return store(t.method === 'atm' ? 'cash' : defaultKind(t.amount), null); // an ATM: a suggestion to approve
}

const GAP_HEADER = '⚖️ Your balance moved by more than the b-mails explain. A standing order, a fee, a savings transfer?';

async function message(env: Env, t: Tx): Promise<[string, ReturnType<typeof txKeyboard>]> {
  const cats = await getCategories(env.DB);
  const text = txText(t, await footerFor(env, t), cats);
  return [t.source === 'gap' ? `${GAP_HEADER}\n\n${text}` : text, txKeyboard(t, false, await debtNames(env.DB), cats)];
}

export async function notify(env: Env, t: Tx): Promise<void> {
  const id = await send(env, ...(await message(env, t)));
  if (id) await updateTx(env.DB, t.n, { tg_msg: id });
}

/** Redraws a payment's chat message after the payment changed. */
async function redraw(env: Env, t: Tx): Promise<void> {
  if (t.tg_msg) await edit(env, t.tg_msg, ...(await message(env, t)));
}

export async function ingest(env: Env, msg: IngestMessage): Promise<'new' | 'duplicate' | 'unparsed' | 'balance'> {
  const parsed = parseBmail(msg.subject, msg.body);
  // The 07:00 "Account balance" b-mail has no payment in it: archive it without a ping.
  if (!parsed && parseBalanceNotice(msg.subject, msg.body) !== null) return 'balance';
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
  const tx = await record(
    env,
    {
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
    },
    undefined,
    parsed.savings ? 'savings' : undefined,
  );
  if (!tx) return 'duplicate';

  // b-mail skips some movements (standing orders, fees). If the balance moved more than the
  // bank movements since the last known balance explain, record the difference so it can be
  // sorted (e.g. as 🏦 Savings). Movements without a balance (round-ups into savings) count too.
  // Keyed by amount, so a recurring "−100 € gap" you marked as savings is recognised next time.
  if (tx.balance !== null && prev?.balance != null && prev.ts <= tx.ts && (await getSetting(env.DB, 'gaps')) !== 'off') {
    const gap = tx.balance - (prev.balance + (await movedBetween(env.DB, prev.n, tx.n)) + tx.amount);
    const open = gap === 0 ? null : await latestOpenGap(env.DB);
    const joined = joinGap(open, gap, tx.ts);
    if (open && joined.join && joined.amount === 0) {
      // It evened out: nothing to explain any more.
      await deleteTx(env.DB, open.n);
      if (open.tg_msg) await tg(env, 'deleteMessage', { chat_id: env.CHAT_ID, message_id: open.tg_msg });
    } else if (open && joined.join) {
      const patch = { amount: joined.amount, key: `gap ${joined.amount}`, kind: open.kind === 'spend' || open.kind === 'income' ? defaultKind(joined.amount) : open.kind };
      await updateTx(env.DB, open.n, patch);
      await redraw(env, { ...open, ...patch });
    } else if (gap !== 0) {
      const g = await record(
        env,
        { ext_id: `gap-${msg.id}`, ts: tx.ts, amount: gap, currency: 'EUR', balance: null, merchant: 'Unexplained balance change', iban: null, note: null, method: 'gap', source: 'gap', raw: null },
        `gap ${gap}`,
      );
      if (g && !msg.silent && !g.confirmed) await notify(env, g);
    }
  }

  if (!msg.silent && !tx.confirmed) await notify(env, tx); // already sorted: nothing to ask
  return 'new';
}
