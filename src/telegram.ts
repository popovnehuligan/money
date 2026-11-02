import { DEFAULT_CATEGORIES, KINDS, categoryEmoji, defaultKind, type Categories, type Kind } from './classify.ts';
import type { Env, Tx } from './db.ts';
import { monthName } from './time.ts';

type Button = { text: string; callback_data: string } | { text: string; web_app: { url: string } };
export type Keyboard = Button[][];

export async function tg<T = unknown>(env: Env, method: string, body: object): Promise<T | undefined> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json<{ ok: boolean; result?: T; description?: string }>();
  if (!data.ok) console.error(`telegram ${method} failed: ${data.description}`);
  return data.result;
}

export async function send(env: Env, text: string, keyboard?: Keyboard): Promise<number | undefined> {
  const msg = await tg<{ message_id: number }>(env, 'sendMessage', {
    chat_id: env.CHAT_ID,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard && { inline_keyboard: keyboard },
  });
  return msg?.message_id;
}

export const edit = (env: Env, messageId: number, text: string, keyboard: Keyboard) =>
  tg(env, 'editMessageText', {
    chat_id: env.CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard },
  });

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NUM = new Intl.NumberFormat('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1250 -> "12,50 €"; with signed, positives get a "+". */
export function eur(cents: number, signed = false): string {
  const sign = cents < 0 ? '−' : signed && cents > 0 ? '+' : '';
  return `${sign}${NUM.format(Math.abs(cents) / 100)} €`;
}

const ICON: Record<Kind, string> = { spend: '💸', income: '💰', savings: '🏦', podmoga: '🔁', loan: '🤝', cash: '💵', ignore: '🚫' };

const when = (ts: string) => `${Number(ts.slice(8, 10))}.${Number(ts.slice(5, 7))}. ${ts.slice(11, 16)}`;

export function txText(t: Tx, footer?: string, cats: Categories = DEFAULT_CATEGORIES): string {
  const who = t.label ?? t.merchant ?? t.note ?? (t.method === 'cash' ? 'Cash' : 'Unknown');
  const half = t.kind === 'spend' && t.loan_part && t.debt ? ` · ½ paid back ${esc(t.debt)}` : '';
  const label = (t.kind === 'spend' ? cats[t.category ?? ''] ?? 'No category yet' : KINDS[t.kind]) + half;
  const worth = (t.worth === 1 ? ' · 👍' : t.worth === 2 ? ' · 🧱' : t.worth === 0 ? ' · 👎' : '') + (t.month ? ` · for ${monthName(t.month)}` : '');
  const lines = [`${ICON[t.kind]} <b>${eur(t.amount, true)}</b> · ${esc(who)}`, `${label} · ${t.method} · ${when(t.ts)}${worth}`];
  if (footer) lines.push('', footer);
  return lines.join('\n');
}

/** Splits buttons into rows of at most `max`, as even as possible: 17 → 6, 6, 5. */
function evenRows<T>(items: T[], max: number): T[][] {
  const count = Math.ceil(items.length / max), rows: T[][] = [];
  for (let i = 0, start = 0; i < count; i++) {
    const size = Math.floor(items.length / count) + (i < items.length % count ? 1 : 0);
    rows.push(items.slice(start, (start += size)));
  }
  return rows;
}

/**
 * Unsorted payments get the full keyboard. Once you've picked a kind or category the
 * message collapses to one summary button (tap to change) plus 👍/👎, so the chat stays calm.
 *
 * Telegram makes buttons only as wide as the message, so rows hold at most two labels,
 * categories are emoji only, and a ticked label drops its emoji to make room for ✓.
 */
export function txKeyboard(t: Tx, expanded = false, debts: string[] = [], cats: Categories = DEFAULT_CATEGORIES): Keyboard {
  const tick = (on: boolean, text: string) => (on ? `✓ ${text.replace(/^\S+\s/, '')}` : text);
  const rows: Keyboard = [];
  // With more than one loan, a 🤝 Loan payment asks which one (ticked once you've picked).
  const debtRows = (): Keyboard => {
    if (t.kind !== 'loan' || debts.length < 2) return [];
    const buttons = debts.map((name, i) => ({ text: t.debt === name ? `✓ ${name}` : name, callback_data: `b:${i}:${t.n}` }));
    const pairs: Keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) pairs.push(buttons.slice(i, i + 2));
    return pairs;
  };
  const worthRow = (): Button[] => [
    { text: tick(t.worth === 1, '👍 Worth it'), callback_data: `w:1:${t.n}` },
    { text: tick(t.worth === 2, '🧱 Needed'), callback_data: `w:2:${t.n}` },
    { text: tick(t.worth === 0, '👎 Regret'), callback_data: `w:0:${t.n}` },
  ];

  if (t.confirmed && !expanded) {
    const label = t.kind === 'spend' ? cats[t.category ?? ''] ?? KINDS.spend : KINDS[t.kind];
    rows.push([{ text: `${label} · change`, callback_data: `e:1:${t.n}` }]);
    if (t.kind === 'spend') rows.push(worthRow());
    return [...rows, ...debtRows()];
  }

  // A suggestion you haven't approved yet (a learned shop, a rule, an import): one tap to say it's right.
  if (!t.confirmed && !(t.kind === 'spend' && !t.category)) {
    rows.push([{ text: `✅ ${t.kind === 'spend' ? cats[t.category ?? ''] ?? KINDS.spend : KINDS[t.kind]}`, callback_data: `a:0:${t.n}` }]);
  }

  if (t.kind === 'spend') {
    // Every category as its emoji, in rows of up to six, then ➕ to type a new one. Only a
    // category whose emoji another one shares shows its name (two per row, below the grid).
    const pick = (id: string, text: string) => ({ text, callback_data: `c:${id}:${t.n}` });
    const ids = Object.keys(cats);
    const emoji = (id: string) => categoryEmoji(cats[id]);
    const unique = (id: string) => emoji(id) !== null && ids.filter((other) => emoji(other) === emoji(id)).length === 1;
    const grid = ids
      .filter(unique)
      .map((id) => pick(id, `${t.category === id ? '✓ ' : ''}${emoji(id)}`))
      .concat({ text: '➕', callback_data: `n:0:${t.n}` });
    const named = ids.filter((id) => !unique(id)).map((id) => pick(id, tick(t.category === id, cats[id])));
    rows.push(...evenRows(grid, 6));
    for (let i = 0; i < named.length; i += 2) rows.push(named.slice(i, i + 2));
    rows.push(worthRow());
  }
  const kinds = ([defaultKind(t.amount), 'podmoga', 'savings', 'loan', 'cash', 'ignore'] as Kind[]).map((k) => ({ text: tick(t.kind === k, KINDS[k]), callback_data: `k:${k}:${t.n}` }));
  rows.push(kinds.slice(0, 2), kinds.slice(2, 4), kinds.slice(4), ...debtRows());
  if (t.source !== 'bmail') rows.push([{ text: '🗑 Delete', callback_data: `d:0:${t.n}` }]);
  return rows;
}
