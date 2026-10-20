// Design preview only (npm run preview): example data plus an in-memory stand-in for
// the Worker's /api routes, so the dashboard can be looked at without deploying.
// It reuses the real dashboard/statistics code, so the numbers behave like production.
// Not part of the Worker bundle.
import { CATEGORIES, defaultKind, isKind, owed, parseDebts, type Kind } from '../src/classify.ts';
import { dashboard, readSettings } from '../src/dashboard.ts';
import type { Tx } from '../src/db.ts';
import { noSpendStreak } from '../src/stats.ts';
import { addMonths } from '../src/time.ts';

const TODAY = '2026-10-19';

// [day, time, euros (negative = out), label, kind, category, worth, method]
type Row = [string, string, number, string, Kind?, string?, (0 | 1)?, string?];
const OCTOBER: Row[] = [
  ['01', '08:02', 1400, 'Studio Nova s.r.o.', 'income', undefined, undefined, 'transfer'],
  ['01', '12:40', -18.4, 'LIDL SK 0123 BRATISLAVA', 'spend', 'food', 1],
  ['02', '09:15', -19.9, 'DPB Bratislava', 'spend', 'transport', 1],
  ['02', '19:22', -14.6, 'WOLT', 'spend', 'eat', 0],
  ['03', '07:30', -150, 'Savings account', 'savings', undefined, undefined, 'transfer'],
  ['03', '18:05', -32.15, 'BILLA 0456', 'spend', 'food'],
  ['04', '21:10', -11.99, 'STEAM GAMES', 'spend', 'fun', 0],
  ['05', '13:20', -4.5, 'Coffee', 'spend', 'eat', 1, 'cash'],
  ['06', '17:45', -24.8, 'KAUFLAND 1120', 'spend', 'food', 1],
  ['07', '08:50', -6.4, 'BOLT.EU/O/2410', 'spend', 'transport'],
  ['08', '10:12', 500, 'Event Agency Danube', 'podmoga', undefined, undefined, 'transfer'],
  ['08', '16:30', -400, 'Crew payout', 'podmoga', undefined, undefined, 'transfer'],
  ['08', '20:15', -38.5, 'BISTRO SAVOY', 'spend', 'eat', 1],
  ['09', '12:05', -15, 'O2 Slovakia', 'spend', 'home'],
  ['10', '18:40', -12.3, 'DR.MAX 077', 'spend', 'health', 1],
  ['11', '15:00', -59.99, 'ZALANDO', 'spend', 'shop', 0],
  ['12', '19:30', -21.7, 'LIDL SK 0123 BRATISLAVA', 'spend', 'food'],
  ['13', '22:45', -9.2, 'BOLT.EU/O/2410', 'spend', 'transport', 0],
  ['14', '11:00', 260, 'Event Agency Danube', 'podmoga', undefined, undefined, 'transfer'],
  ['14', '11:40', -220, 'Crew payout', 'podmoga', undefined, undefined, 'transfer'],
  ['14', '20:10', -26.4, 'CINEMA CITY', 'spend', 'fun', 1],
  ['15', '07:30', -50, 'Savings account', 'savings', undefined, undefined, 'transfer'],
  ['15', '18:20', -17.85, 'BILLA 0456', 'spend', 'food'],
  ['16', '20:00', -40, 'Mom', 'loan', undefined, undefined, 'transfer'],
  ['19', '08:41', -3.8, 'Kafíčko na rohu', 'spend', undefined, undefined, 'cash'],
  ['19', '09:12', -7.6, 'BOLT.EU/O/2410', 'spend'],
  ['15', '19:05', -13.2, 'TESCO EXPRESS', 'spend'],
];

// September: a full, quieter month generated from a fixed seed.
function september(): Row[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pool: [string, string, number][] = [
    ['LIDL SK 0123 BRATISLAVA', 'food', 22], ['BILLA 0456', 'food', 18], ['WOLT', 'eat', 16], ['BOLT.EU/O/2410', 'transport', 8],
    ['Coffee', 'eat', 4], ['STEAM GAMES', 'fun', 12], ['DR.MAX 077', 'health', 10], ['DECATHLON', 'shop', 35],
  ];
  const rows: Row[] = [['01', '08:00', 1400, 'Studio Nova s.r.o.', 'income', undefined, undefined, 'transfer'], ['03', '07:30', -180, 'Savings account', 'savings', undefined, undefined, 'transfer'], ['09', '12:05', -15, 'O2 Slovakia', 'spend', 'home']];
  for (let day = 1; day <= 30; day++) {
    if (rnd() < 0.25) continue;
    const [label, cat, base] = pool[Math.floor(rnd() * pool.length)];
    const amount = -Math.round(base * (0.6 + rnd()) * 100) / 100;
    rows.push([String(day).padStart(2, '0'), `${10 + Math.floor(rnd() * 11)}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`, amount, label, 'spend', cat, rnd() < 0.3 ? (rnd() < 0.7 ? 1 : 0) : undefined]);
  }
  return rows;
}

let n = 0;
const toTx = (month: string) => ([day, time, euros, label, kind, category, worth, method]: Row): Tx => {
  const amount = Math.round(euros * 100);
  return {
    n: ++n,
    ext_id: `demo-${n}`,
    ts: `${month}-${day}T${time}`,
    amount,
    currency: 'EUR',
    balance: null,
    merchant: label,
    iban: null,
    note: null,
    method: method ?? 'card',
    key: null,
    kind: kind ?? defaultKind(amount),
    category: category ?? null,
    worth: worth ?? null,
    confirmed: category || (kind && kind !== defaultKind(amount)) ? 1 : 0,
    source: method === 'cash' ? 'manual' : 'bmail',
    tg_msg: null,
  };
};
let txs: Tx[] = [...september().map(toTx('2026-09')), ...OCTOBER.map(toTx('2026-10'))];
const settings: Record<string, string> = { budget: '60000', goal_name: 'Japan trip', goal_amount: '200000', savings_start: '45000', debts: '[{"name":"Mom","match":["mom"],"amount":10000}]' };
const EARLIER_SAVINGS = [{ month: '2026-08', saved: 15000 }, { month: '2026-07', saved: 12000 }];

function summary(month = TODAY.slice(0, 7)) {
  const inMonth = (m: string) => txs.filter((t) => t.ts.startsWith(m)).sort((a, b) => b.ts.localeCompare(a.ts) || b.n - a.n);
  const byMonth = new Map<string, number>();
  for (const t of txs) if (t.kind === 'savings') byMonth.set(t.ts.slice(0, 7), (byMonth.get(t.ts.slice(0, 7)) ?? 0) - t.amount);
  const savedByMonth = [...[...byMonth].map(([m, saved]) => ({ month: m, saved })).sort((a, b) => b.month.localeCompare(a.month)), ...EARLIER_SAVINGS];
  const spendDays = new Set(txs.filter((t) => t.kind === 'spend' && t.amount < 0).map((t) => t.ts.slice(0, 10)));
  return dashboard({
    month: month <= TODAY.slice(0, 7) ? month : TODAY.slice(0, 7),
    today: TODAY,
    txs: inMonth(month),
    prevTxs: inMonth(addMonths(month, -1)),
    settings: readSettings(settings),
    savedByMonth,
    streak: noSpendStreak(spendDays, '2026-09-01', TODAY),
    debts: owed(parseDebts(settings.debts), txs.filter((t) => t.kind === 'loan')),
  });
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const realFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const [path, query = ''] = String(input).split('?');
  if (!path.startsWith('/api/')) return realFetch(input, init);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  await new Promise((r) => setTimeout(r, 120));
  const month = new URLSearchParams(query).get('month') ?? body.month ?? undefined;
  switch (path) {
    case '/api/summary':
      return json(summary(month));
    case '/api/tx': {
      const t = txs.find((x) => x.n === body.n);
      if (!t) return json({ error: 'That payment no longer exists.' }, 404);
      if (body.category !== undefined && body.category in CATEGORIES) Object.assign(t, { kind: 'spend', category: body.category, confirmed: 1 });
      if (body.kind !== undefined && isKind(body.kind)) Object.assign(t, { kind: body.kind, confirmed: 1 });
      if (body.worth !== undefined) t.worth = body.worth;
      return json(summary(t.ts.slice(0, 7)));
    }
    case '/api/delete':
      txs = txs.filter((x) => x.n !== body.n || x.source === 'bmail');
      return json(summary(month));
    case '/api/cash': {
      const now = new Date();
      const t = toTx('2026-10')([TODAY.slice(8), `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, body.amount / 100, body.note || 'Cash', undefined, body.category, undefined, 'cash']);
      txs.push(t);
      return json(summary());
    }
    case '/api/settings':
      for (const [k, key] of [['budget', 'budget'], ['goalAmount', 'goal_amount'], ['savingsStart', 'savings_start']] as const) {
        if (k in body) body[k] === null ? delete settings[key] : (settings[key] = String(body[k]));
      }
      if ('goalName' in body) settings.goal_name = String(body.goalName || '');
      return json(summary(month));
  }
  return json({ error: 'Not found' }, 404);
};

// Minimal stand-in for telegram-web-app.js.
const noop = () => {};
(window as unknown as { Telegram: unknown }).Telegram = {
  WebApp: {
    initData: 'preview',
    initDataUnsafe: {},
    ready: noop,
    expand: noop,
    onEvent: noop,
    HapticFeedback: { impactOccurred: noop, selectionChanged: noop, notificationOccurred: noop },
    BackButton: { show: noop, hide: noop, onClick: noop },
  },
};

// Make it obvious these aren't real figures.
addEventListener('DOMContentLoaded', () => {
  const banner = document.createElement('p');
  banner.textContent = 'Example data';
  banner.style.cssText =
    'position:fixed;z-index:50;left:50%;top:calc(22px + env(safe-area-inset-top, 0px));transform:translateX(-50%);margin:0;padding:6px 12px;border-radius:12px;background:rgba(2,8,26,.7);color:#a9bbdc;font:500 11px ui-monospace,monospace;letter-spacing:.06em;pointer-events:none;white-space:nowrap';
  document.body.append(banner);
});
