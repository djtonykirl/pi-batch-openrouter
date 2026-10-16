/**
 * Explicit timestamp handling.
 *
 * Regression-sensitive: an earlier version stored `Date.now()` (milliseconds)
 * next to OpenRouter's `finalized_at` (Unix seconds) and fed both to
 * `new Date(...)`, producing 1970 dates. Never pass an ambiguously-unit'd number
 * to `new Date()` — go through these functions instead. Internal timestamps are
 * ISO-8601 UTC strings.
 */

/** 2000-01-01T00:00:00Z and 2100-01-01T00:00:00Z in Unix seconds. */
const MIN_PLAUSIBLE_SECONDS = 946_684_800;
const MAX_PLAUSIBLE_SECONDS = 4_102_444_800;

export type TimestampResult =
  | { ok: true; iso: string }
  | { ok: false; reason: "missing" | "not_a_number" | "implausible" | "unparseable" };

export function nowIso(): string {
  return new Date().toISOString();
}

function plausibleSeconds(seconds: number): boolean {
  return seconds >= MIN_PLAUSIBLE_SECONDS && seconds <= MAX_PLAUSIBLE_SECONDS;
}

/** Unix seconds -> ISO. Rejects values outside 2000..2100 (e.g. a millisecond value passed by mistake). */
export function fromUnixSeconds(value: unknown): TimestampResult {
  if (value === null || value === undefined) return { ok: false, reason: "missing" };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "not_a_number" };
  if (!plausibleSeconds(value)) return { ok: false, reason: "implausible" };
  return { ok: true, iso: new Date(Math.round(value * 1000)).toISOString() };
}

/** Unix milliseconds -> ISO. Rejects values outside 2000..2100 (e.g. a seconds value passed by mistake). */
export function fromUnixMilliseconds(value: unknown): TimestampResult {
  if (value === null || value === undefined) return { ok: false, reason: "missing" };
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "not_a_number" };
  if (!plausibleSeconds(value / 1000)) return { ok: false, reason: "implausible" };
  return { ok: true, iso: new Date(Math.round(value)).toISOString() };
}

/** ISO-8601 string -> normalised ISO UTC. Requires a date part; rejects free text. */
export function fromIsoString(value: unknown): TimestampResult {
  if (value === null || value === undefined || value === "") return { ok: false, reason: "missing" };
  if (typeof value !== "string") return { ok: false, reason: "not_a_number" };
  if (!/^\d{4}-\d{2}-\d{2}(T|$)/.test(value)) return { ok: false, reason: "unparseable" };
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return { ok: false, reason: "unparseable" };
  if (!plausibleSeconds(ms / 1000)) return { ok: false, reason: "implausible" };
  return { ok: true, iso: new Date(ms).toISOString() };
}

/**
 * OpenRouter documents `created_at` / `finalized_at` as integer Unix seconds.
 * An ISO string is also accepted defensively. A number with millisecond
 * magnitude is NOT silently converted — it is reported as implausible so the
 * caller can record a diagnostic instead of inventing a date.
 */
export function parseProviderTimestamp(value: unknown): TimestampResult {
  if (typeof value === "string") return fromIsoString(value);
  return fromUnixSeconds(value);
}

/** ISO -> epoch ms for arithmetic (scheduling). Returns NaN for invalid input. */
export function isoToEpochMs(iso: string | undefined | null): number {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

/** Compact human display: "2026-10-16 14:03Z". Invalid input renders as "-". */
export function formatIsoShort(iso: string | undefined | null): string {
  if (!iso) return "-";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "-";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
}
