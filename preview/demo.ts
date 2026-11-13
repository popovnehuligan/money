// Design preview only (npm run preview): example data plus an in-memory stand-in for
// the Worker's /api routes, so the dashboard can be looked at without deploying.
// It reuses the real dashboard/statistics code, so the numbers behave like production.
// Not part of the Worker bundle.
import { DEFAULT_CATEGORIES, categoriesFrom, categoryLabel, defaultKind, isKind, newCategory, owed, parseDebts, type Kind } from '../src/classify.ts';
import { dashboard, readSettings, txView } from '../src/dashboard.ts';
import type { Tx } from '../src/db.ts';
import { noSpendStreak } from '../src/stats.ts';
import { addMonths } from '../src/time.ts';

const TODAY = '2026-10-19';

// [day, time, euros (negative = out), label, kind, category, worth, method]
type Row = [string, string, number, string, Kind?, string?, (0 | 1)?, string?];
const OCTOBER: Row[] = [
  ['01', '08:02', 1400, 'Studio Nova s.r.o.', 'income', undefined, undefined, 'transfer'],
  ['01', '12:40', -18.4, 'LIDL SK 0123 BRATISLAVA', 'spend', 'food', 1],
  ['02', '09:15', -1.1, 'DPB Bratislava', 'spend', 'bus', 1],
  ['02', '19:22', -14.6, 'WOLT', 'spend', 'food', 0],
  ['03', '07:30', -150, 'Savings account', 'savings', undefined, undefined, 'transfer'],
  ['03', '18:05', -32.15, 'BILLA 0456', 'spend', 'food'],
  ['04', '21:10', -11.99, 'STEAM GAMES', 'spend', 'fun', 0],
  ['04', '12:30', -9.4, 'Tabak - Press -OC NI', 'spend', 'smokes'],
  ['05', '13:20', -4.5, 'Coffee', 'spend', 'eat', 1, 'cash'],
  ['06', '17:45', -24.8, 'KAUFLAND 1120', 'spend', 'food', 1],
  ['07', '08:50', -6.4, 'BOLT.EU/O/2410', 'spend', 'taxi'],
  ['07', '18:10', -2.55, 'BOLT.EU/P/2610', 'spend', 'scooter'],
  ['08', '10:12', 500, 'Event Agency Danube', 'podmoga', undefined, undefined, 'transfer'],
  ['08', '16:30', -400, 'Crew payout', 'podmoga', undefined, undefined, 'transfer'],
  ['08', '20:15', -38.5, 'BISTRO SAVOY', 'spend', 'eat', 1],
  ['09', '12:05', -15, 'O2 Slovakia', 'spend', 'home'],
  ['09', '14:20', -9.15, 'EasyPark Slovakia', 'spend', 'parking', 1],
  ['10', '18:40', -12.3, 'DR.MAX 077', 'spend', 'health', 1],
  ['11', '15:00', -59.99, 'ZALANDO', 'spend', 'shop', 0],
  ['12', '19:30', -21.7, 'LIDL SK 0123 BRATISLAVA', 'spend', 'food'],
  ['13', '22:45', -9.2, 'BOLT.EU/O/2410', 'spend', 'taxi', 0],
  ['14', '11:00', 260, 'Event Agency Danube', 'podmoga', undefined, undefined, 'transfer'],
  ['14', '11:40', -220, 'Crew payout', 'podmoga', undefined, undefined, 'transfer'],
  ['14', '20:10', -26.4, 'CINEMA CITY', 'spend', 'fun', 1],
  ['14', '23:40', -4.5, 'Hub bar', 'spend', 'eat', 1],
  ['15', '07:30', -50, 'Savings account', 'savings', undefined, undefined, 'transfer'],
  ['15', '18:20', -17.85, 'BILLA 0456', 'spend', 'food'],
  ['16', '20:00', -40, 'Mom', 'loan', undefined, undefined, 'transfer'],
  ['17', '11:15', -40, 'ATM Obchodna 12', 'cash', undefined, undefined, 'atm'],
  ['19', '08:41', -3.8, 'Kafíčko na rohu', 'spend', undefined, undefined, 'cash'],
  ['19', '09:12', -7.6, 'BOLT.EU/O/2410', 'spend'],
  ['15', '19:05', -13.2, 'TESCO EXPRESS', 'spend'],
];

// September: a full, quieter month generated from a fixed seed.
function september(): Row[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pool: [string, string, number][] = [
    ['LIDL SK 0123 BRATISLAVA', 'food', 22], ['BILLA 0456', 'food', 18], ['Tabak Press', 'smokes', 9], ['BOLT.EU/O/2410', 'taxi', 8],
    ['Hub bar', 'eat', 4], ['BOLT.EU/P/2610', 'scooter', 3], ['EasyPark Slovakia', 'parking', 6], ['DECATHLON', 'shop', 35],
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
    debt: null,
    label: null,
    loan_part: null,
    month: null,
  };
};
let txs: Tx[] = [...september().map(toTx('2026-09')), ...OCTOBER.map(toTx('2026-10'))];
const cashIds = new Set<string>(); // cash entries already stored, by their form's id
const settings: Record<string, string> = { budget: '60000', goal_name: 'Japan trip', goal_amount: '200000', savings_start: '45000', categories: '{"fun":"🎉 Fun"}', debts: '[{"name":"Mom","match":["mom"],"amount":10000},{"name":"Ben","match":[],"amount":17520}]' };
const EARLIER_SAVINGS = [{ month: '2026-08', saved: 15000 }, { month: '2026-07', saved: 12000 }];

function summary(month = TODAY.slice(0, 7)) {
  const inMonth = (m: string) => txs.filter((t) => (t.month ?? t.ts.slice(0, 7)) === m).sort((a, b) => b.ts.localeCompare(a.ts) || b.n - a.n);
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
    loans: parseDebts(settings.debts).map((d) => ({ name: d.name, amount: d.amount, dir: d.dir ?? 'owe' })),
    incomeSources: [...new Set(txs.filter((t) => t.kind === 'income' && t.amount > 0).map((t) => t.label ?? t.merchant ?? 'Cash'))],
    debts: owed(parseDebts(settings.debts), [...txs.filter((t) => t.kind === 'loan'), ...txs.filter((t) => (t.kind === 'spend' || t.kind === 'cash' || t.kind === 'income') && t.loan_part).map((t) => ({ ...t, amount: t.loan_part! }))]),
    loanHistory: txs.filter((t) => t.kind === 'loan' || t.loan_part).sort((a, b) => b.ts.localeCompare(a.ts)).map((t) => ({ n: t.n, ts: t.ts, part: t.kind === 'loan' ? t.amount : t.loan_part!, debt: t.debt ?? (parseDebts(settings.debts).find((d) => d.match.some((m) => (t.merchant ?? '').toLowerCase().includes(m)))?.name ?? null), label: t.label ?? t.merchant ?? 'Cash' })),
    categories: categoriesFrom(settings.categories),
    balance: { amount: 41235, ts: `${TODAY}T09:12` },
    unrated: txs.filter((t) => t.kind === 'spend' && t.amount < 0 && t.worth === null).length,
    passedOn: txs.filter((t) => t.kind === 'podmoga').reduce((p, t) => (t.amount > 0 ? { ...p, in: p.in + t.amount, kept: p.kept + t.amount } : { ...p, out: p.out - t.amount, kept: p.kept + t.amount }), { in: 0, out: 0, kept: 0 }),
  });
}

// Same as the Worker: a typed name becomes a category (or the existing one with that name).
function typedCategory(text: string): string | undefined {
  const made = newCategory(text, categoriesFrom(settings.categories));
  if (!made) return undefined;
  settings.categories = JSON.stringify({ ...JSON.parse(settings.categories ?? '{}'), [made[0]]: made[1] });
  return made[0];
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
      if (body.newCategory !== undefined) body.category = typedCategory(body.newCategory);
      if (body.category !== undefined && body.category in categoriesFrom(settings.categories)) Object.assign(t, { kind: 'spend', category: body.category, confirmed: 1 });
      if (body.kind !== undefined && isKind(body.kind)) Object.assign(t, { kind: body.kind, confirmed: 1 });
      if (body.worth !== undefined) t.worth = body.worth;
      if (body.debt !== undefined) Object.assign(t, { kind: 'loan', debt: body.debt, confirmed: 1 });
      if (body.countsFor !== undefined) t.month = body.countsFor === t.ts.slice(0, 7) ? null : body.countsFor;
      if (body.half !== undefined) Object.assign(t, body.half ? { loan_part: Math.round(t.amount / 2), debt: body.half } : { loan_part: null, debt: null });
      if (body.repay !== undefined) Object.assign(t, body.repay ? { loan_part: t.amount < 0 ? -body.repay.amount : body.repay.amount, debt: body.repay.debt } : { loan_part: null, debt: null });
      if (body.label !== undefined) t.label = String(body.label ?? '').trim() || null;
      if (body.amount !== undefined && t.source !== 'bmail') t.amount = body.amount;
      if (body.ts !== undefined && t.source !== 'bmail') t.ts = body.ts;
      return json(body.quiet ? { ok: true } : summary(t.ts.slice(0, 7)));
    }
    case '/api/unrated': {
      const list = txs.filter((t) => t.kind === 'spend' && t.amount < 0 && t.worth === null).sort((a, b) => b.ts.localeCompare(a.ts) || b.n - a.n);
      return json({ tx: list.map(txView) });
    }
    case '/api/delete':
      txs = txs.filter((x) => x.n !== body.n || x.source === 'bmail');
      return json(summary(month));
    case '/api/cash': {
      // Like the Worker: an entry form's id is stored once, however often it's sent.
      if (body.id && cashIds.has(body.id)) return json(summary());
      if (body.id) cashIds.add(body.id);
      const now = new Date();
      const category = body.newCategory !== undefined ? typedCategory(body.newCategory) : body.category;
      const t = toTx('2026-10')([TODAY.slice(8), `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, body.amount / 100, body.note || 'Cash', body.debt ? 'loan' : undefined, body.debt ? undefined : category, undefined, 'cash']);
      if (body.debt) Object.assign(t, { debt: body.debt, confirmed: 1, ...(body.ts ? { ts: body.ts } : {}) });
      txs.push(t);
      return json(summary());
    }
    case '/api/category': {
      const mine = JSON.parse(settings.categories ?? '{}');
      const cats = categoriesFrom(settings.categories);
      if (typeof body.add === 'string') typedCategory(body.add);
      else if (body.rename in cats) settings.categories = JSON.stringify({ ...mine, [body.rename]: categoryLabel(body.label, cats[body.rename].split(' ')[0]) ?? cats[body.rename] });
      else if (body.remove in cats && body.remove !== 'other') {
        if (body.remove in DEFAULT_CATEGORIES) mine[body.remove] = null;
        else delete mine[body.remove];
        settings.categories = JSON.stringify(mine);
        for (const t of txs) if (t.category === body.remove) Object.assign(t, { category: null, confirmed: 0 });
      }
      return json(summary(month));
    }
    case '/api/settings':
      for (const [k, key] of [['budget', 'budget'], ['goalAmount', 'goal_amount'], ['savingsStart', 'savings_start']] as const) {
        if (k in body) body[k] === null ? delete settings[key] : (settings[key] = String(body[k]));
      }
      if ('goalName' in body) settings.goal_name = String(body.goalName || '');
      if ('name' in body) body.name ? (settings.name = String(body.name)) : delete settings.name;
      if ('caps' in body) body.caps ? (settings.caps = JSON.stringify(body.caps)) : delete settings.caps;
      if ('saveTarget' in body) settings.save_target = String(body.saveTarget);
      if ('loans' in body) {
        const before = parseDebts(settings.debts);
        settings.debts = JSON.stringify(body.loans.map((l: { name: string; amount: number; dir?: string }) => ({ name: l.name, match: before.find((d) => d.name === l.name)?.match ?? [], amount: l.amount, dir: l.dir ?? before.find((d) => d.name === l.name)?.dir ?? 'owe' })));
      }
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
