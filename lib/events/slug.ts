// Unguessable event slug. Privacy of an event relies on this string being
// unforgeable (TECH_SPEC.md §9), so the generator must be cryptographically
// random — never Math.random or a timestamp.
//
// 14 chars from a 32-symbol alphabet = 70 bits of entropy. That's well past
// brute-force range for any realistic attacker, while keeping the URL short
// enough to print on a wedding card.

// Crockford-style base32 minus look-alikes (0/O, 1/I/L). Output is also
// case-insensitive friendly when read aloud.
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const LENGTH = 14;

export function generateSlug(): string {
  const bytes = new Uint8Array(LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function isValidSlugShape(s: string): boolean {
  if (s.length !== LENGTH) return false;
  for (const c of s) if (!ALPHABET.includes(c)) return false;
  return true;
}
