import APP_HTML from './app.html';
import { handleUpdate, type Update } from './bot.ts';
import type { Env } from './db.ts';
import { ingest, type IngestMessage } from './ingest.ts';
import { summaryApi } from './miniapp.ts';
import { morningText, wrapText } from './reports.ts';
import { send, tg } from './telegram.ts';
import { addMonths, dayOf, localStamp, monthOf } from './time.ts';

const COMMANDS = [
  { command: 'today', description: "Today's allowance" },
  { command: 'month', description: 'This month so far' },
  { command: 'budget', description: 'Set the monthly budget, e.g. /budget 600' },
  { command: 'help', description: 'How this works' },
];

/** One-time wiring of the bot to this Worker: open /setup?key=<INGEST_SECRET> in a browser. */
async function setup(env: Env, url: URL): Promise<Response> {
  if (!env.INGEST_SECRET || url.searchParams.get('key') !== env.INGEST_SECRET) return new Response('Forbidden', { status: 403 });
  await tg(env, 'setWebhook', {
    url: `${url.origin}/tg`,
    secret_token: env.TELEGRAM_SECRET,
    allowed_updates: ['message', 'callback_query'],
  });
  await tg(env, 'setMyCommands', { commands: COMMANDS });
  if (env.CHAT_ID) {
    await tg(env, 'setChatMenuButton', {
      chat_id: Number(env.CHAT_ID),
      menu_button: { type: 'web_app', text: '📊 Dashboard', web_app: { url: `${url.origin}/app` } },
    });
  }
  return new Response(
    env.CHAT_ID
      ? 'Done. Open your bot in Telegram and send /start.'
      : 'Webhook set. Now send any message to your bot: it replies with your chat id. Save it as CHAT_ID, redeploy, and open this page again.',
  );
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname === '/ingest') {
      if (!env.INGEST_SECRET || req.headers.get('authorization') !== `Bearer ${env.INGEST_SECRET}`) return new Response('Forbidden', { status: 403 });
      const msg = await req.json<IngestMessage>();
      if (!msg?.id || !msg.date || typeof msg.body !== 'string') return Response.json({ error: 'id, date and body are required' }, { status: 400 });
      return Response.json({ status: await ingest(env, { ...msg, subject: msg.subject ?? '' }) });
    }

    if (req.method === 'POST' && url.pathname === '/tg') {
      if (!env.TELEGRAM_SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_SECRET) return new Response('Forbidden', { status: 403 });
      try {
        await handleUpdate(env, await req.json<Update>());
      } catch (e) {
        console.error(e); // still answer 200, otherwise Telegram re-sends the same update forever
      }
      return new Response('ok');
    }

    if (url.pathname === '/setup') return setup(env, url);
    if (url.pathname === '/app') return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/api/summary') return summaryApi(env, req, url);
    return new Response('Not found', { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const today = dayOf(localStamp());
        if (today.endsWith('-01')) await send(env, await wrapText(env, addMonths(monthOf(today), -1)));
        await send(env, await morningText(env));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
