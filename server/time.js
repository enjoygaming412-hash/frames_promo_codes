// All promo days and cooldown messages are anchored to the community timezone.
export const TIMEZONE = 'America/Toronto';
export const COOLDOWN_HOURS = 24;
export const COOLDOWN_MS = COOLDOWN_HOURS * 60 * 60 * 1000;

const DATE_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const OFFSET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const LABEL_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

const SHORT_LABEL_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const WEEKDAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  weekday: 'long',
});

function partMap(format, date) {
  const map = {};
  for (const part of format.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return map;
}

/** Calendar date (YYYY-MM-DD) currently active in America/Toronto. */
export function torontoDate(date = new Date()) {
  const p = partMap(DATE_PARTS, date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Offset of the community timezone at a given instant, in minutes east of UTC. */
function torontoOffsetMinutes(date) {
  const p = partMap(OFFSET_PARTS, date);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** The instant when the next promo day starts (next midnight in America/Toronto). */
export function nextTorontoMidnight(date = new Date()) {
  const [year, month, day] = torontoDate(date).split('-').map(Number);
  const naive = Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0);
  let guess = naive;
  for (let i = 0; i < 3; i += 1) {
    guess = naive - torontoOffsetMinutes(new Date(guess)) * 60000;
  }
  return new Date(guess);
}

/** Human readable instant, e.g. "Saturday, May 2, 2026 at 11:14 PM EDT". */
export function torontoTimeLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return LABEL_FORMAT.format(date).replace(/ at /, ' at ');
}

export function torontoDateLabel(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    // Noon UTC keeps the calendar label stable for any offset.
    return SHORT_LABEL_FORMAT.format(new Date(Date.UTC(y, m - 1, d, 12)));
  }
  return SHORT_LABEL_FORMAT.format(new Date(value));
}

export function torontoWeekday(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return WEEKDAY_FORMAT.format(new Date(Date.UTC(y, m - 1, d, 12)));
  }
  return WEEKDAY_FORMAT.format(new Date(value));
}

/** Add whole days to a YYYY-MM-DD string without timezone drift. */
export function addDays(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days, 12));
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

export function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}
