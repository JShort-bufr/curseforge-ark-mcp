/**
 * The whole of this repo's redaction, deliberately.
 *
 * ADR-002 §12.1 refuses to port the sibling repo's 224-line allow-list response
 * filter, and the reason is recorded there rather than here so it can be argued
 * with: that module protects a server connect address and a gameserver response
 * carrying plaintext credentials including an admin password. Every byte this
 * server receives is public CurseForge catalog data — mod names, file versions,
 * dependency graphs, all visible on the public website without authentication.
 *
 * Performing the same ceremony for a much smaller risk teaches the next reader
 * to discount the ceremony everywhere, including next door where it is real.
 *
 * So this repo keeps exactly one rule: NEVER ECHO THE API KEY. One function,
 * applied to error messages and to any upstream body snippet before it can
 * enter the model's context.
 *
 * If it ever turns out that some class of data this server touches is NOT
 * public — a private game visible only to this key, which §5 notes can exist —
 * then §12 is void for that data and this file is the wrong size.
 */

/** The stand-in. Fixed string so a test can assert on it, and obviously not a value. */
export const REDACTED = "[redacted:api-key]";

/**
 * Remove every occurrence of the key from a string.
 *
 * The 8-character floor is not defensive padding: a short or empty `key` would
 * make `split` match everywhere and turn a useful message into confetti, and an
 * empty string matches at every index. A key that short is not a CurseForge key,
 * and config.ts refuses one anyway.
 *
 * Case-sensitive on purpose. The key is sent verbatim in a header; a
 * case-folded search would be a different string than the one that can leak.
 */
export function scrubKey(text: string, key: string | null | undefined): string {
  if (typeof key !== "string" || key.length < 8) return text;
  return text.split(key).join(REDACTED);
}

/**
 * Bound an upstream body snippet AND scrub it.
 *
 * Snippets are permitted here — unlike in the sibling repo — because the body is
 * public catalog data and a CurseForge error body is often the only thing that
 * says which argument was wrong. Bounded because an unbounded upstream string
 * in a model's context is a different problem from a secret one, and scrubbed as
 * belt-and-braces: this server never puts the key in a body, so a key appearing
 * in one would mean something has gone wrong that this function should not be
 * the first to notice quietly.
 */
export function safeSnippet(text: string, key: string | null | undefined, maxChars = 300): string {
  return scrubKey(text.slice(0, maxChars), key);
}
