// Parses timeslots like "Mon/Wed 09:00-10:30" and detects overlaps.
const DAY = '(Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const SLOT_RE = new RegExp(`^${DAY}(/${DAY})* ([01]\\d|2[0-3]):[0-5]\\d-([01]\\d|2[0-3]):[0-5]\\d$`);

function parseSlot(slot) {
  if (typeof slot !== 'string' || !SLOT_RE.test(slot)) return null;
  const [d, t] = slot.split(' ');
  const [a, b] = t.split('-');
  const toMin = (x) => { const [h, m] = x.split(':').map(Number); return h * 60 + m; };
  const start = toMin(a), end = toMin(b);
  if (end <= start) return null;
  return { days: [...new Set(d.split('/'))], start, end };
}

function slotsOverlap(s1, s2) {
  const a = parseSlot(s1), b = parseSlot(s2);
  if (!a || !b) return false;
  return a.days.some((d) => b.days.includes(d)) && a.start < b.end && b.start < a.end;
}

module.exports = { parseSlot, slotsOverlap };
