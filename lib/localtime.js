// Turning "due 2026-09-08 at 15:00" into an absolute instant is the one piece of date
// handling the server cannot do with the Date constructor. `new Date("2026-09-08T15:00")`
// resolves against the *runtime's* zone, which on Vercel is UTC — so a 3pm Pacific
// deadline became 8am Pacific, and reminders fired seven hours early. Resolve against a
// named zone explicitly instead.

export const TZ = "America/Los_Angeles";

// How far a named zone sits from UTC at a given instant (handles DST, since the answer
// changes across the year).
function offsetMsAt(utcMs, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value])
  );
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === "24" ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return asIfUtc - utcMs;
}

// "2026-09-08" + "15:00" in `tz` -> epoch ms. The offset is applied twice because the
// first guess can land on the wrong side of a DST switch, and the corrected instant may
// sit at a different offset than the naive one did.
export function zonedToEpochMs(ymd, hhmm, tz = TZ) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const [hh, mm] = String(hhmm).split(":").map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) return null;
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  return naive - offsetMsAt(naive - offsetMsAt(naive, tz), tz);
}

// The local calendar date and hour at a given instant.
export function localAt(ms, tz = TZ) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false,
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour === "24" ? 0 : p.hour) };
}

// Today's local calendar date and hour, for digest timing and "is this overdue" checks.
export function localNow(tz = TZ) {
  return localAt(Date.now(), tz);
}

// Calendar arithmetic on a YYYY-MM-DD string, without tripping over month lengths.
export function addDays(ymd, n) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
