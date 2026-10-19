// Gmail → Money Worker forwarder for Tatra banka b-mail e-mails.
// Free: runs inside your Google account every minute. Setup steps are in README.md.
//
// Script properties (Project settings → Script properties):
//   WORKER_URL     https://money.<your-subdomain>.workers.dev/ingest
//   INGEST_SECRET  the same value as the INGEST_SECRET GitHub secret

// Which e-mails are b-mails. CHECK THIS against one real b-mail (open it, look at "from").
const QUERY = 'from:tatrabanka.sk';

const TZ = 'Europe/Bratislava';
const DAY = 24 * 3600 * 1000;

/** Run once by hand: checks for new b-mails every minute from now on. */
function install() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('forwardNew').timeBased().everyMinutes(1).create();
  PropertiesService.getScriptProperties().setProperty('LAST_MS', String(Date.now() - DAY));
}

/** Called by the trigger. Mails older than 6 hours are stored without a Telegram ping. */
function forwardNew() {
  const props = PropertiesService.getScriptProperties();
  const cursor = Number(props.getProperty('LAST_MS') || Date.now() - DAY);
  const sent = JSON.parse(props.getProperty('SENT_IDS') || '[]');
  // Look 15 minutes behind the cursor: Gmail sometimes indexes a mail a little late.
  const fresh = find_(cursor - 15 * 60 * 1000).filter((m) => !sent.includes(m.getId()));
  const delivered = send_(fresh, Date.now() - 6 * 3600 * 1000);
  if (!delivered.length) return;
  props.setProperty('LAST_MS', String(Math.max(cursor, ...delivered.map((m) => m.getDate().getTime()))));
  props.setProperty('SENT_IDS', JSON.stringify(sent.concat(delivered.map((m) => m.getId())).slice(-100)));
}

/**
 * Optional, run by hand once: imports the last 180 days silently (no Telegram pings),
 * a week at a time, oldest first. Run it again until the log says it's done.
 */
function backfill() {
  const props = PropertiesService.getScriptProperties();
  const end = Number(props.getProperty('LAST_MS') || Date.now());
  const startedAt = Date.now();
  let from = Number(props.getProperty('BACKFILL_MS') || Date.now() - 180 * DAY);
  while (from < end && Date.now() - startedAt < 4 * 60 * 1000) {
    const to = Math.min(from + 7 * DAY, end);
    const messages = find_(from, to);
    const delivered = send_(messages, Infinity, startedAt + 5 * 60 * 1000);
    if (delivered.length < messages.length) {
      // Stopped early: resume at the last delivered mail (the Worker ignores the repeat).
      if (delivered.length) from = delivered[delivered.length - 1].getDate().getTime();
      break;
    }
    from = to;
  }
  props.setProperty('BACKFILL_MS', String(from));
  console.log(from >= end ? 'Backfill done.' : `Imported up to ${new Date(from)}. Run backfill again to continue.`);
}

/** b-mails with fromMs <= date < toMs, oldest first. */
function find_(fromMs, toMs = Infinity) {
  let query = `${QUERY} after:${Math.floor(fromMs / 1000)}`;
  if (toMs !== Infinity) query += ` before:${Math.ceil(toMs / 1000)}`;
  const messages = [];
  GmailApp.search(query, 0, 200).forEach((thread) =>
    thread.getMessages().forEach((m) => {
      const t = m.getDate().getTime();
      if (t >= fromMs && t < toMs) messages.push(m);
    }),
  );
  return messages.sort((a, b) => a.getDate() - b.getDate());
}

/** Posts mails to the Worker in order; stops at the first failure. Returns the ones delivered. */
function send_(messages, silentBeforeMs, deadline = Date.now() + 4 * 60 * 1000) {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WORKER_URL');
  const secret = props.getProperty('INGEST_SECRET');
  const delivered = [];
  for (const m of messages) {
    if (Date.now() > deadline) break; // Apps Script stops runs at 6 minutes
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${secret}` },
      payload: JSON.stringify({
        id: m.getId(),
        date: Utilities.formatDate(m.getDate(), TZ, "yyyy-MM-dd'T'HH:mm"),
        subject: m.getSubject(),
        body: m.getPlainBody(),
        silent: m.getDate().getTime() < silentBeforeMs,
      }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      console.error(`Worker answered ${res.getResponseCode()}: ${res.getContentText()}`);
      break; // retried on the next run, nothing is skipped
    }
    delivered.push(m);
  }
  return delivered;
}
