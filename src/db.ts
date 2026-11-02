import { categoriesFrom, parseDebts, type Categories, type Kind } from './classify.ts';
import type { StatTx } from './stats.ts';
import { addMonths } from './time.ts';

/** Bindings and secrets as configured in Cloudflare. Only TELEGRAM_TOKEN is required. */
export interface RawEnv {
  DB: D1Database;
  TELEGRAM_TOKEN: string;
  TELEGRAM_SECRET?: string; // checked on every Telegram webhook call; derived from the token if unset
  INGEST_SECRET?: string; // shared with the Gmail forwarder; derived from the token if unset
  CHAT_ID?: string; // your Telegram chat; normally set by sending /start once
  OWN_IBANS?: string; // comma-separated IBANs of your own accounts, never taken as the counterparty
}

/** RawEnv with every default filled in (see withDefaults in index.ts). */
export interface Env extends RawEnv {
  TELEGRAM_SECRET: string;
  INGEST_SECRET: string;
  CHAT_ID: string; // '' until someone sends /start
}

export interface Tx {
  n: number;
  ext_id: string;
  ts: string;
  amount: number;
  currency: string;
  balance: number | null;
  merchant: string | null;
  iban: string | null;
  note: string | null;
  method: string;
  key: string | null;
  kind: Kind;
  category: string | null;
  worth: number | null;
  confirmed: number;
  source: string;
  tg_msg: number | null;
  debt: string | null; // which loan a 🤝 Loan payment belongs to (or the loan loan_part paid back)
  label: string | null; // your own name for it, shown instead of the bank's
  loan_part?: number | null; // part of a spending payment that paid back the loan in `debt` (e.g. half)
}

export type NewTx = Omit<Tx, 'n' | 'worth' | 'confirmed' | 'tg_msg' | 'debt' | 'label' | 'loan_part'> & {
  raw: string | null;
  debt?: string | null;
  approved?: boolean; // stored as already sorted: nothing to ask in the chat
};

const COLS = 'n, ext_id, ts, amount, currency, balance, merchant, iban, note, method, key, kind, category, worth, confirmed, source, tg_msg, debt, label, loan_part';

/** Returns the stored row, or null if this ext_id was already imported. */
export function insertTx(db: D1Database, t: NewTx): Promise<Tx | null> {
  return db
    .prepare(
      `INSERT INTO tx (ext_id, ts, amount, currency, balance, merchant, iban, note, method, key, kind, category, source, raw, debt, confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ext_id) DO NOTHING RETURNING ${COLS}`,
    )
    .bind(t.ext_id, t.ts, t.amount, t.currency, t.balance, t.merchant, t.iban, t.note, t.method, t.key, t.kind, t.category, t.source, t.raw, t.debt ?? null, t.approved ? 1 : 0)
    .first<Tx>();
}

export const getTx = (db: D1Database, n: number) => db.prepare(`SELECT ${COLS} FROM tx WHERE n = ?`).bind(n).first<Tx>();

type Patch = Partial<Pick<Tx, 'kind' | 'category' | 'worth' | 'confirmed' | 'tg_msg' | 'debt' | 'label' | 'amount' | 'ts' | 'key' | 'loan_part'>>;

export async function updateTx(db: D1Database, n: number, patch: Patch): Promise<void> {
  const keys = Object.keys(patch) as (keyof Patch)[];
  if (!keys.length) return;
  await db
    .prepare(`UPDATE tx SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE n = ?`)
    .bind(...keys.map((k) => patch[k] ?? null), n)
    .run();
}

export const deleteTx = (db: D1Database, n: number) => db.prepare('DELETE FROM tx WHERE n = ?').bind(n).run();

/** Your most recent explicit choice for this merchant/counterparty, for money going the same way. */
export const learned = (db: D1Database, key: string, amount: number) =>
  db
    // Only choices for money going the same way: +350 € from someone being income says nothing about paying them.
    .prepare('SELECT kind, category FROM tx WHERE key = ? AND confirmed = 1 AND (amount < 0) = ? ORDER BY ts DESC, n DESC LIMIT 1')
    .bind(key, amount < 0 ? 1 : 0)
    .first<Pick<Tx, 'kind' | 'category'>>();

/** The latest b-mail that told us your main account's balance. */
export const latestBmail = (db: D1Database) =>
  db.prepare(`SELECT ${COLS} FROM tx WHERE source = 'bmail' AND balance IS NOT NULL ORDER BY ts DESC, n DESC LIMIT 1`).first<Tx>();

/**
 * Sum of the b-mail movements stored after one transaction and before another (by arrival).
 * Gap entries don't count: the balance we start from already includes what they describe,
 * and counting them made every gap answer the previous one (−20.19, +20.19, −20.19…).
 */
export async function movedBetween(db: D1Database, afterN: number, beforeN: number): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM tx WHERE source = 'bmail' AND n > ? AND n < ?")
    .bind(afterN, beforeN)
    .first<{ s: number }>();
  return row?.s ?? 0;
}

/** The newest balance difference you haven't answered yet. */
export const latestOpenGap = (db: D1Database) =>
  db.prepare(`SELECT ${COLS} FROM tx WHERE source = 'gap' AND confirmed = 0 ORDER BY n DESC LIMIT 1`).first<Tx>();

/** Transactions with from <= ts < to (both "YYYY-MM-DD…" strings). */
export async function txBetween(db: D1Database, from: string, to: string): Promise<Tx[]> {
  const { results } = await db.prepare(`SELECT ${COLS} FROM tx WHERE ts >= ? AND ts < ? ORDER BY ts DESC, n DESC`).bind(from, to).all<Tx>();
  return results;
}

/** Everything 🔁 Passed on so far: what came in, what went out, and what you kept (the running total). */
export async function passedOnTotal(db: D1Database, category?: string): Promise<{ in: number; out: number; kept: number }> {
  const sql = `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS i, COALESCE(-SUM(CASE WHEN amount < 0 THEN amount END), 0) AS o FROM tx WHERE kind = 'podmoga'${category ? ' AND category = ?' : ''}`;
  const st = db.prepare(sql);
  const r = await (category ? st.bind(category) : st).first<{ i: number; o: number }>();
  const i = r?.i ?? 0, o = r?.o ?? 0;
  return { in: i, out: o, kept: i - o };
}

/** Spending you haven't rated yet (👍 worth it, 🧱 necessary, 👎 regret), newest first. */
export async function unratedTx(db: D1Database): Promise<Tx[]> {
  const { results } = await db.prepare(`SELECT ${COLS} FROM tx WHERE kind = 'spend' AND amount < 0 AND worth IS NULL ORDER BY ts DESC, n DESC`).all<Tx>();
  return results;
}
export async function unratedCount(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS c FROM tx WHERE kind = 'spend' AND amount < 0 AND worth IS NULL").first<{ c: number }>())?.c ?? 0;
}

/** Names of your loans, for the "which loan?" buttons. */
export const debtNames = async (db: D1Database) => parseDebts(await getSetting(db, 'debts')).map((d) => d.name);

/** Every 🤝 Loan payment, and the parts of spending that paid a loan back, to work out what's still owed. */
export async function loanPayments(db: D1Database): Promise<Pick<Tx, 'amount' | 'merchant' | 'note' | 'debt'>[]> {
  const { results } = await db
    .prepare("SELECT amount, merchant, note, debt FROM tx WHERE kind = 'loan' UNION ALL SELECT loan_part, merchant, note, debt FROM tx WHERE kind = 'spend' AND loan_part IS NOT NULL")
    .all<Pick<Tx, 'amount' | 'merchant' | 'note' | 'debt'>>();
  return results;
}

export const txInMonth = (db: D1Database, month: string): Promise<StatTx[]> => txBetween(db, `${month}-01`, `${addMonths(month, 1)}-01`);

export async function spendDaysSince(db: D1Database, day: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT DISTINCT substr(ts, 1, 10) AS d FROM tx WHERE kind = 'spend' AND amount < 0 AND ts >= ?")
    .bind(day)
    .all<{ d: string }>();
  return new Set(results.map((r) => r.d));
}

export async function firstDay(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT substr(MIN(ts), 1, 10) AS d FROM tx').first<{ d: string | null }>();
  return row?.d ?? null;
}

export async function insertUnparsed(db: D1Database, extId: string, ts: string, subject: string, body: string): Promise<boolean> {
  const res = await db
    .prepare('INSERT INTO unparsed (ext_id, ts, subject, body) VALUES (?, ?, ?, ?) ON CONFLICT(ext_id) DO NOTHING')
    .bind(extId, ts, subject, body)
    .run();
  return res.meta.changes > 0;
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export const setSetting = (db: D1Database, key: string, value: string) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();

export async function getBudget(db: D1Database): Promise<number | null> {
  const v = await getSetting(db, 'budget');
  return v === null ? null : Number(v);
}

export async function getSettings(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

/** Built-in categories plus yours. */
export const getCategories = async (db: D1Database): Promise<Categories> => categoriesFrom(await getSetting(db, 'categories'));

/** Your categories and your names for built-in ones (the built-in list itself lives in the code). */
export const myCategories = async (db: D1Database): Promise<Categories> => JSON.parse((await getSetting(db, 'categories')) ?? '{}') as Categories;
export const saveMyCategories = (db: D1Database, mine: Categories) => setSetting(db, 'categories', JSON.stringify(mine));

/** Saves a category you typed, or a new name for an existing one. */
export async function addCategory(db: D1Database, id: string, label: string): Promise<void> {
  await saveMyCategories(db, { ...(await myCategories(db)), [id]: label });
}

/** A category you deleted: its payments go back to "to sort". */
export const uncategorize = (db: D1Database, id: string) => db.prepare('UPDATE tx SET category = NULL, confirmed = 0 WHERE category = ?').bind(id).run();

export const deleteSetting = (db: D1Database, key: string) => db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();

/** Euro cents moved into savings per month, newest first, for the months that have any. */
export async function savedByMonth(db: D1Database): Promise<{ month: string; saved: number }[]> {
  const { results } = await db
    .prepare("SELECT substr(ts, 1, 7) AS month, -SUM(amount) AS saved FROM tx WHERE kind = 'savings' GROUP BY month ORDER BY month DESC")
    .all<{ month: string; saved: number }>();
  return results;
}
