/**
 * Typed, sortable id factory — `newId(prefix)` => `${prefix}_<26-char ULID>`.
 *
 * The 26-char body is a ULID (https://github.com/ulid/spec): a 48-bit
 * millisecond timestamp followed by 80 bits of cryptographic randomness, encoded
 * in Crockford base32. We emit it **lowercased** so it matches the canonical id
 * regex in `@/lib/case` (`[0-9a-hjkmnp-tv-z]{26}` — Crockford's alphabet minus
 * i/l/o/u). The timestamp prefix makes ids lexicographically sortable by
 * creation time, which keeps "newest first" listings stable.
 *
 * Edge/Workers-safe: uses Web Crypto `crypto.getRandomValues` (available in the
 * Workers runtime and in Node >= 18), never `node:crypto`, so this module is
 * safe to import from any runtime the store/handoff/evidence code runs in.
 */

// Crockford base32, lowercased to match the Case Object id regex.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ENCODING_LEN = ALPHABET.length; // 32
const TIME_LEN = 10; // chars encoding the 48-bit timestamp
const RANDOM_LEN = 16; // chars of randomness => 80 bits
const ULID_LEN = TIME_LEN + RANDOM_LEN; // 26

/** Encode the low 48 bits of `now` (ms) into `TIME_LEN` Crockford chars. */
function encodeTime(now: number): string {
  let t = Math.floor(now);
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = t % ENCODING_LEN;
    out = ALPHABET[mod] + out;
    t = (t - mod) / ENCODING_LEN;
  }
  return out;
}

/** `RANDOM_LEN` Crockford chars from cryptographically strong randomness. */
function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    // Map each byte into the 32-char alphabet (uniform enough for id entropy).
    out += ALPHABET[(bytes[i] ?? 0) % ENCODING_LEN];
  }
  return out;
}

/** A bare 26-char ULID (no prefix). */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/**
 * Mint a typed id: `${prefix}_<ulid>`. The prefix is the Case Object's typed
 * namespace (e.g. "case", "ten", "ev", "pkt", "cns", "rem"); the result matches
 * that prefix's `idPattern` in `@/lib/case`.
 */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/** The fixed length of the ULID body (26), exported for validators/tests. */
export const ULID_BODY_LEN = ULID_LEN;
