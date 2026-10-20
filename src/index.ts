import FORWARDER from '../apps-script/Code.gs';
import APP_HTML from './app.html';
import { derivedSecret } from './auth.ts';
import { dashboardButton, handleUpdate, type Update } from './bot.ts';
import { getSetting, setSetting, type Env, type RawEnv } from './db.ts';
import { ingest, type IngestMessage } from './ingest.ts';
import { api } from './miniapp.ts';
import { morningText, wrapText } from './reports.ts';
import { send, tg } from './telegram.ts';
import { addMonths, dayOf, localStamp, monthOf } from './time.ts';

const COMMANDS = [
  { command: 'today', description: "Today's allowance" },
  { command: 'month', description: 'This month so far' },
  { command: 'budget', description: 'Set the monthly budget, e.g. /budget 600' },
  { command: 'owe', description: 'What you still owe, e.g. /owe Mom 100' },
  { command: 'help', description: 'How this works' },
];

/** Fills in secrets derived from the bot token and the owner chat saved by /start. */
async function withDefaults(env: RawEnv): Promise<Env> {
  return {
    ...env,
    TELEGRAM_SECRET: env.TELEGRAM_SECRET || (await derivedSecret(env.TELEGRAM_TOKEN, 'webhook')),
    INGEST_SECRET: env.INGEST_SECRET || (await derivedSecret(env.TELEGRAM_TOKEN, 'ingest')),
    CHAT_ID: env.CHAT_ID || (await getSetting(env.DB, 'owner_chat')) || '',
  };
}

const keyOf = (req: Request, url: URL) => url.searchParams.get('key') ?? req.headers.get('authorization')?.replace(/^Bearer /, '');

/** Wires the bot to this Worker. The deploy workflow calls it; opening it in a browser works too. */
async function setup(env: Env, req: Request, url: URL): Promise<Response> {
  if (keyOf(req, url) !== env.INGEST_SECRET) return new Response('Forbidden', { status: 403 });
  await setSetting(env.DB, 'base_url', url.origin);
  await tg(env, 'setWebhook', { url: `${url.origin}/tg`, secret_token: env.TELEGRAM_SECRET, allowed_updates: ['message', 'callback_query'] });
  await tg(env, 'setMyCommands', { commands: COMMANDS });
  await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Dashboard', web_app: { url: `${url.origin}/app` } } });
  const me = await tg<{ username: string }>(env, 'getMe', {});
  return Response.json({ ok: true, bot: me?.username ? `https://t.me/${me.username}` : null, owner: env.CHAT_ID ? 'connected' : 'send /start to the bot' });
}

export default {
  async fetch(req, rawEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/app') return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const env = await withDefaults(rawEnv);

    if (req.method === 'POST' && url.pathname === '/ingest') {
      if (keyOf(req, url) !== env.INGEST_SECRET) return new Response('Forbidden', { status: 403 });
      const msg = await req.json<IngestMessage>();
      if (!msg?.id || !msg.date || typeof msg.body !== 'string') return Response.json({ error: 'id, date and body are required' }, { status: 400 });
      return Response.json({ status: await ingest(env, { ...msg, subject: msg.subject ?? '' }) });
    }

    if (req.method === 'POST' && url.pathname === '/tg') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_SECRET) return new Response('Forbidden', { status: 403 });
      try {
        await handleUpdate(env, await req.json<Update>());
      } catch (e) {
        console.error(e); // still answer 200, otherwise Telegram re-sends the same update forever
      }
      return new Response('ok');
    }

    if (url.pathname === '/setup') return setup(env, req, url);

    // The Gmail forwarder with your Worker URL and key already filled in (linked from the bot's welcome message).
    if (url.pathname === '/forwarder.gs') {
      if (keyOf(req, url) !== env.INGEST_SECRET) return new Response('Forbidden', { status: 403 });
      const code = FORWARDER.replace('__WORKER_URL__', `${url.origin}/ingest`).replace('__INGEST_SECRET__', env.INGEST_SECRET);
      return new Response(code, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }

    if (url.pathname.startsWith('/api/')) return api(env, req, url);
    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event, rawEnv, ctx) {
    ctx.waitUntil(
      (async () => {
        const env = await withDefaults(rawEnv);
        if (!env.CHAT_ID) return;
        const today = dayOf(localStamp());
        if (today.endsWith('-01')) await send(env, await wrapText(env, addMonths(monthOf(today), -1)));
        await send(env, await morningText(env), await dashboardButton(env));
      })(),
    );
  },
} satisfies ExportedHandler<RawEnv>;
