import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidTimeZone, partsInZone, zonedTimeToUtc } from "./time.ts";

test("resolves a local slot to the correct UTC instant", () => {
  // 09:00 in New York on a standard-time date is 14:00 UTC.
  const utc = zonedTimeToUtc(
    { year: 2026, month: 1, day: 15, hour: 9, minute: 0 },
    "America/New_York",
  );
  assert.equal(utc.toISOString(), "2026-01-15T14:00:00.000Z");
});

test("accounts for daylight saving time", () => {
  // Same wall-clock slot in July is 13:00 UTC, an hour earlier than in January.
  const utc = zonedTimeToUtc(
    { year: 2026, month: 7, day: 15, hour: 9, minute: 0 },
    "America/New_York",
  );
  assert.equal(utc.toISOString(), "2026-07-15T13:00:00.000Z");
});

test("handles zones with a half-hour offset", () => {
  const utc = zonedTimeToUtc(
    { year: 2026, month: 3, day: 1, hour: 9, minute: 0 },
    "Asia/Kolkata",
  );
  assert.equal(utc.toISOString(), "2026-03-01T03:30:00.000Z");
});

test("round-trips a local slot through UTC", () => {
  const local = { year: 2026, month: 11, day: 3, hour: 18, minute: 30 };
  const back = partsInZone(zonedTimeToUtc(local, "Asia/Shanghai"), "Asia/Shanghai");
  assert.deepEqual(back, local);
});

test("renders midnight as hour 0", () => {
  const midnight = zonedTimeToUtc(
    { year: 2026, month: 6, day: 1, hour: 0, minute: 0 },
    "Europe/London",
  );
  assert.equal(partsInZone(midnight, "Europe/London").hour, 0);
});

test("validates time zone names", () => {
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("Not/A_Zone"), false);
});
