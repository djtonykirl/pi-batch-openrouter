import * as crypto from "node:crypto";

/**
 * Three distinct identifiers (never conflate them):
 *   local job ID          B-20261016-A7C2              (ours; directory name)
 *   provider batch ID     batch_xxxxx                  (OpenRouter's)
 *   request custom_id     B-20261016-A7C2:request-001  (correlates request <-> result)
 */

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
  return `${localId}:request-${String(index + 1).padStart(3, "0")}`;
}
