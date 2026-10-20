// Parser for Tatra banka b-mail notification e-mails.
//
// Written WITHOUT a real b-mail sample, so it is deliberately loose: it looks
// for amounts, Slovak/English direction words and "Label: value" lines rather
// than one exact template. Anything it can't read lands in the `unparsed` table
// and in Telegram, so nothing is lost silently. Once real (redacted) samples
// exist, tighten this and add them to test/parse.test.ts.

export type Method = 'card' | 'transfer' | 'atm' | 'other';

export interface ParsedTx {
  amount: number; // cents, negative = money left the account
  currency: string;
  balance?: number; // cents, account balance after the transaction
  merchant?: string;
  ibans: string[]; // every full IBAN in the message, spaces removed
  note?: string;
  method: Method;
  ts?: string; // local "YYYY-MM-DDTHH:MM" when the message states it
}

/** Lowercase and strip diacritics so "Prijatá platba" matches "prijata platba". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const CURRENCY = '(EUR|€|CZK|USD|GBP|PLN|HUF|CHF)';
const NUMBER = '(\\d{1,3}(?:[ .\\u00a0]\\d{3})+|\\d+)(?:[.,](\\d{1,2}))?';
const AMOUNT_FIRST = new RegExp(`([+\\-−]?)\\s?${NUMBER}\\s?${CURRENCY}(?![A-Za-z])`, 'g');
const CURRENCY_FIRST = new RegExp(`${CURRENCY}\\s?([+\\-−]?)\\s?${NUMBER}`, 'g');

const BALANCE_CUE = /zostatok|balance|disponib/;
const CREDIT_CUE = /\bkredit\b|prijat|prichadzaj|pripis|vratenie|refund|incoming|credited/;
const DEBIT_CUE = /\bdebet\b|odchadzaj|platba kart|zaplat|vyber|odpis|uhrad|debited|outgoing|card payment|purchase|withdrawal|nakup/;

const MERCHANT_LABELS = ['obchodnik', 'miesto', 'prevadzka', 'merchant', 'prijemca', 'nazov prijemcu', 'platitel', 'nazov platitela', 'protistrana', 'nazov protiuctu', 'payee', 'payer', 'from', 'to'];
const NOTE_LABELS = ['sprava pre prijemcu', 'sprava', 'poznamka', 'popis', 'informacia pre prijemcu', 'referencia', 'reference', 'message', 'variabilny symbol', 'vs'];

const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g;

// Newsletters from the bank mention amounts and "kartou" too; b-mails are plain notifications.
const NEWSLETTER = /tatranews|nezobrazuje sa vam|odhlasit|unsubscribe|newsletter/;

interface Money {
  cents: number;
  sign: string;
  currency: string;
  start: number;
  end: number;
}

function findMoney(text: string): Money[] {
  const toMoney = (sign: string, whole: string, dec: string | undefined, cur: string, m: RegExpExecArray): Money => ({
    cents: Number(whole.replace(/[ . ]/g, '')) * 100 + Number((dec ?? '0').padEnd(2, '0')),
    sign: sign === '−' ? '-' : sign,
    currency: cur === '€' ? 'EUR' : cur.toUpperCase(),
    start: m.index,
    end: m.index + m[0].length,
  });
  const found = [...text.matchAll(AMOUNT_FIRST)].map((m) => toMoney(m[1], m[2], m[3], m[4], m));
  if (found.length) return found;
  return [...text.matchAll(CURRENCY_FIRST)].map((m) => toMoney(m[2], m[3], m[4], m[1], m));
}

function labelled(lines: string[], labels: string[]): string | undefined {
  for (const line of lines) {
    const m = line.match(/^\s*([^:]{2,40}):\s*(.+?)\s*$/);
    if (!m) continue;
    const label = fold(m[1]).trim();
    if (labels.some((l) => label === l || label.startsWith(`${l} `))) return m[2];
  }
  return undefined;
}

function findDate(text: string): string | undefined {
  const m = text.match(/(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})(?:[^\d\n]{1,12}(\d{1,2}):(\d{2}))?/);
  if (!m) return undefined;
  const [, day, month, year, hour = '0', minute = '0'] = m;
  if (+day < 1 || +day > 31 || +month < 1 || +month > 12 || +hour > 23 || +minute > 59) return undefined;
  const p = (x: string) => x.padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}T${p(hour)}:${p(minute)}`;
}

/** Earliest of the two cues wins, so a subject like "Prijatá platba" decides. */
function direction(folded: string): 1 | -1 | 0 {
  const credit = folded.search(CREDIT_CUE);
  const debit = folded.search(DEBIT_CUE);
  if (credit === -1 && debit === -1) return 0;
  if (debit === -1 || (credit !== -1 && credit < debit)) return 1;
  return -1;
}

export function parseBmail(subject: string, body: string): ParsedTx | null {
  const text = `${subject}\n${body}`.normalize('NFC').replace(/\r/g, '');
  const folded = fold(text);
  if (NEWSLETTER.test(folded)) return null;
  const money = findMoney(text);

  let amount: Money | undefined;
  let balance: Money | undefined;
  money.forEach((m, i) => {
    // Only look back to the previous amount, so "Suma 5 EUR, zostatok 100 EUR" labels each correctly.
    const context = folded.slice(Math.max(i ? money[i - 1].end : 0, m.start - 50), m.start);
    if (BALANCE_CUE.test(context)) balance ??= m;
    else if (!amount || (amount.currency !== 'EUR' && m.currency === 'EUR')) amount = m;
  });
  if (!amount) return null;

  const ibans = [...text.matchAll(IBAN)].map((m) => m[0].replace(/ /g, ''));
  const method: Method = /bankomat|\batm\b|vyber hotovost|cash withdrawal/.test(folded)
    ? 'atm'
    : /kart|\bcard\b|google pay|apple pay|\bpos\b/.test(folded)
      ? 'card'
      : ibans.length || /prevod|sepa|trvaly prikaz|inkaso|transfer|platba/.test(folded)
        ? 'transfer'
        : 'other';

  let sign = amount.sign === '-' ? -1 : amount.sign === '+' ? 1 : direction(folded);
  if (sign === 0 && (method === 'card' || method === 'atm')) sign = -1;
  if (sign === 0) return null;

  const lines = text.split('\n');
  let merchant = labelled(lines, MERCHANT_LABELS);
  if (merchant && merchant.replace(/ /g, '').match(/^[A-Z]{2}\d{2}[A-Z0-9]+$/)) merchant = undefined;
  if (!merchant) {
    const m = folded.match(/\b(?:u obchodnika|v prevadzke|at)\s+([^\n,;]+?)(?=\s+(?:dna|on|v sume|suma)\b|\s+\d{1,2}\.\d{1,2}\.|[,;\n]|$)/);
    if (m && m.index !== undefined) {
      const start = m.index + m[0].length - m[1].length;
      merchant = text.slice(start, start + m[1].length).trim();
    }
  }

  return {
    amount: sign * amount.cents,
    currency: amount.currency,
    balance: balance && balance.currency === 'EUR' ? (balance.sign === '-' ? -balance.cents : balance.cents) : undefined,
    merchant: merchant || undefined,
    ibans,
    note: labelled(lines, NOTE_LABELS),
    method,
    ts: findDate(text),
  };
}
