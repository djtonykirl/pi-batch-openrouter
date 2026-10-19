import * as crypto from "node:crypto";

/**
 * Three distinct identifiers (never conflate them):
 *   local job ID          B-20261016-A7C2              (ours; directory name)
 *   provider batch ID     batch_xxxxx                  (OpenRouter's)
 *   request custom_id     B-20261016-A7C2_request-001  (correlates request <-> result)
 */

/**
 * Some upstream batch backends (Anthropic, verified live 2026-10-17: HTTP 422) only accept
 * custom_id characters in [A-Za-z0-9_-] and at most 64 characters, so no ':' or '.'.
 */
export const CUSTOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Crockford base32 without I, L, O, U — unambiguous when read aloud or retyped.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const LOCAL_ID_PATTERN = /^B-\d{8}-[0-9A-HJKMNP-TV-Z]{4,8}$/;

/** `B-YYYYMMDD-XXXX`; 20 random bits. Uniqueness is enforced by the caller via exclusive mkdir. */
export function newLocalJobId(now: Date = new Date(), randomChars = 4): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const bytes = crypto.randomBytes(randomChars);
  let suffix = "";
  for (let i = 0; i < randomChars; i++) suffix += ALPHABET[bytes[i]! % 32];
  return `B-${ymd}-${suffix}`;
}

export function isLocalJobId(value: string): boolean {
  return LOCAL_ID_PATTERN.test(value);
}

export function customIdFor(localId: string, index: number): string {
  return `${localId}_request-${String(index + 1).padStart(3, "0")}`;
}

/** Problems that make a set of custom_ids unsafe to submit (empty = OK). Uniqueness is exact (provider-side). */
export function customIdProblems(ids: readonly string[]): string[] {
  const problems: string[] = [];
  if (ids.length === 0) problems.push("batch has no requests");
  const seen = new Set<string>();
  for (const id of ids) {
    if (!CUSTOM_ID_PATTERN.test(id)) problems.push(`custom_id "${id}" does not match ${CUSTOM_ID_PATTERN.source}`);
    if (seen.has(id)) problems.push(`duplicate custom_id "${id}"`);
    seen.add(id);
  }
  return problems;
}
