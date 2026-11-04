export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

const UNITS = { s: 1, m: 60, min: 60, h: 3600, hod: 3600 };

/**
 * Parses "1:23:45", "45:00", "90" (minutes), "+5m", "-30s", "+1h".
 * Returns { seconds, relative } or null.
 */
export function parseTime(text) {
  const input = text.trim().toLowerCase().replace(/\s+/g, '').replace(',', '.');
  const match = /^([+-])?(.+)$/.exec(input);
  if (!match) return null;
  const [, sign, body] = match;
  let seconds;
  if (body.includes(':')) {
    const parts = body.split(':').map(Number);
    if (parts.length > 3 || parts.some(p => !Number.isFinite(p) || p < 0) || parts.slice(1).some(p => p >= 60)) return null;
    seconds = parts.reduce((acc, part) => acc * 60 + part, 0);
  } else {
    const unitMatch = /^(\d+(?:\.\d+)?)(s|m|min|h|hod)?$/.exec(body);
    if (!unitMatch) return null;
    seconds = Number(unitMatch[1]) * UNITS[unitMatch[2] ?? 'm'];
  }
  if (!sign) return { seconds, relative: false };
  return { seconds: sign === '-' ? -seconds : seconds, relative: true };
}

const DAY_WORDS = { dnes: 0, dneska: 0, vcera: 1, včera: 1, predevcirem: 2, předevčírem: 2 };
const DEFAULT_HOUR = 20;

/**
 * Parses when something was watched, in local time: "včera", "dnes 21:30",
 * "28.10.", "28.10.2026 20:00" or just "21:30" (today). Empty means now.
 * A day without a year that would lie in the future means last year.
 * Returns epoch milliseconds, or null.
 */
export function parseWhen(text, now = new Date()) {
  const input = text?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
  if (!input) return now.getTime();
  const match = /^(?:(dnes|dneska|včera|vcera|předevčírem|predevcirem)|(\d{1,2})\.\s?(\d{1,2})\.?(?:\s?(\d{4}))?)?\s?(?:(\d{1,2}):(\d{2}))?$/.exec(input);
  if (!match || (!match[1] && !match[2] && !match[5])) return null;
  const [, word, day, month, year, hour, minute] = match;
  const date = new Date(now);
  date.setSeconds(0, 0);
  if (word) date.setDate(date.getDate() - DAY_WORDS[word]);
  if (day) {
    date.setFullYear(Number(year ?? now.getFullYear()), Number(month) - 1, Number(day));
    if (date.getDate() !== Number(day)) return null;
  }
  if (hour) {
    if (Number(hour) > 23 || Number(minute) > 59) return null;
    date.setHours(Number(hour), Number(minute));
  } else {
    date.setHours(DEFAULT_HOUR, 0);
  }
  if (day && !year && date > now) date.setFullYear(date.getFullYear() - 1);
  // "dnes" without a time later than now: it was watched today, so cap at now.
  if (word && !hour && date > now) return now.getTime();
  return date.getTime();
}
