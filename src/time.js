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
    if (parts.length > 3 || parts.some(p => !Number.isFinite(p) || p < 0)) return null;
    seconds = parts.reduce((acc, part) => acc * 60 + part, 0);
  } else {
    const unitMatch = /^(\d+(?:\.\d+)?)(s|m|min|h|hod)?$/.exec(body);
    if (!unitMatch) return null;
    seconds = Number(unitMatch[1]) * UNITS[unitMatch[2] ?? 'm'];
  }
  if (!sign) return { seconds, relative: false };
  return { seconds: sign === '-' ? -seconds : seconds, relative: true };
}
