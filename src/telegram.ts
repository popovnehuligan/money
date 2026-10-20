import { CATEGORIES, KINDS, defaultKind, type Kind } from './classify.ts';
import type { Env, Tx } from './db.ts';

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

const ICON: Record<Kind, string> = { spend: '💸', income: '💰', savings: '🏦', podmoga: '🔁', loan: '🤝', ignore: '🚫' };

const when = (ts: string) => `${Number(ts.slice(8, 10))}.${Number(ts.slice(5, 7))}. ${ts.slice(11, 16)}`;

export function txText(t: Tx, footer?: string): string {
  const who = t.merchant ?? t.note ?? (t.method === 'cash' ? 'Cash' : 'Unknown');
  const label = t.kind === 'spend' ? CATEGORIES[t.category ?? ''] ?? 'No category yet' : KINDS[t.kind];
  const worth = t.worth === 1 ? ' · 👍' : t.worth === 0 ? ' · 👎' : '';
  const lines = [`${ICON[t.kind]} <b>${eur(t.amount, true)}</b> · ${esc(who)}`, `${label} · ${t.method} · ${when(t.ts)}${worth}`];
  if (footer) lines.push('', footer);
  return lines.join('\n');
}

/**
 * Unsorted payments get the full keyboard. Once you've picked a kind or category the
 * message collapses to one summary button (tap to change) plus 👍/👎, so the chat stays calm.
 *
 * Telegram makes buttons only as wide as the message, so rows hold at most two labels,
 * categories are emoji only, and a ticked label drops its emoji to make room for ✓.
 */
export function txKeyboard(t: Tx, expanded = false, debts: string[] = []): Keyboard {
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
    { text: tick(t.worth === 0, '👎 Regret'), callback_data: `w:0:${t.n}` },
  ];

  if (t.confirmed && !expanded) {
    const label = t.kind === 'spend' ? CATEGORIES[t.category ?? ''] ?? KINDS.spend : KINDS[t.kind];
    rows.push([{ text: `${label} · change`, callback_data: `e:1:${t.n}` }]);
    if (t.kind === 'spend') rows.push(worthRow());
    return [...rows, ...debtRows()];
  }

  if (t.kind === 'spend') {
    const cats = Object.entries(CATEGORIES).map(([id, label]) => {
      const emoji = label.split(' ')[0];
      return { text: t.category === id ? `✓ ${emoji}` : emoji, callback_data: `c:${id}:${t.n}` };
    });
    for (let i = 0; i < cats.length; i += 4) rows.push(cats.slice(i, i + 4));
    rows.push(worthRow());
  }
  const kinds = ([defaultKind(t.amount), 'podmoga', 'savings', 'loan', 'ignore'] as Kind[]).map((k) => ({ text: tick(t.kind === k, KINDS[k]), callback_data: `k:${k}:${t.n}` }));
  rows.push(kinds.slice(0, 2), kinds.slice(2, 4), kinds.slice(4), ...debtRows());
  if (t.source !== 'bmail') rows.push([{ text: '🗑 Delete', callback_data: `d:0:${t.n}` }]);
  return rows;
}
