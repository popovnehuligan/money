import type { Kind } from './classify.ts';
import type { StatTx } from './stats.ts';
import { addMonths } from './time.ts';

export interface Env {
  DB: D1Database;
  TELEGRAM_TOKEN: string;
  TELEGRAM_SECRET: string; // checked on every Telegram webhook call
  INGEST_SECRET: string; // shared with the Apps Script forwarder
  CHAT_ID: string; // your Telegram chat; everyone else is ignored
  OWN_IBANS?: string; // comma-separated IBANs of your own accounts, never taken as the counterparty
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
}

export type NewTx = Omit<Tx, 'n' | 'worth' | 'confirmed' | 'tg_msg'> & { raw: string | null };

const COLS = 'n, ext_id, ts, amount, currency, balance, merchant, iban, note, method, key, kind, category, worth, confirmed, source, tg_msg';

/** Returns the stored row, or null if this ext_id was already imported. */
export function insertTx(db: D1Database, t: NewTx): Promise<Tx | null> {
  return db
    .prepare(
      `INSERT INTO tx (ext_id, ts, amount, currency, balance, merchant, iban, note, method, key, kind, category, source, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ext_id) DO NOTHING RETURNING ${COLS}`,
    )
    .bind(t.ext_id, t.ts, t.amount, t.currency, t.balance, t.merchant, t.iban, t.note, t.method, t.key, t.kind, t.category, t.source, t.raw)
    .first<Tx>();
}

export const getTx = (db: D1Database, n: number) => db.prepare(`SELECT ${COLS} FROM tx WHERE n = ?`).bind(n).first<Tx>();

type Patch = Partial<Pick<Tx, 'kind' | 'category' | 'worth' | 'confirmed' | 'tg_msg'>>;

export async function updateTx(db: D1Database, n: number, patch: Patch): Promise<void> {
  const keys = Object.keys(patch) as (keyof Patch)[];
  if (!keys.length) return;
  await db
    .prepare(`UPDATE tx SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE n = ?`)
    .bind(...keys.map((k) => patch[k] ?? null), n)
    .run();
}

export const deleteTx = (db: D1Database, n: number) => db.prepare('DELETE FROM tx WHERE n = ?').bind(n).run();

/** Your most recent explicit choice for this merchant/counterparty. */
export const learned = (db: D1Database, key: string) =>
  db
    .prepare('SELECT kind, category FROM tx WHERE key = ? AND confirmed = 1 ORDER BY ts DESC, n DESC LIMIT 1')
    .bind(key)
    .first<Pick<Tx, 'kind' | 'category'>>();

export const latestBmail = (db: D1Database) =>
  db.prepare(`SELECT ${COLS} FROM tx WHERE source = 'bmail' ORDER BY ts DESC, n DESC LIMIT 1`).first<Tx>();

/** Transactions with from <= ts < to (both "YYYY-MM-DD…" strings). */
export async function txBetween(db: D1Database, from: string, to: string): Promise<Tx[]> {
  const { results } = await db.prepare(`SELECT ${COLS} FROM tx WHERE ts >= ? AND ts < ? ORDER BY ts DESC, n DESC`).bind(from, to).all<Tx>();
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
