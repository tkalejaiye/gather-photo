import { describe, it, expect } from "vitest";
import { generateSlug, isValidSlugShape } from "@/lib/events/slug";

describe("event slug", () => {
  it("is URL-safe, 14 chars, and only uses the no-look-alike alphabet", () => {
    // Alphabet excludes 0/1/o/l/i to avoid handwritten/print confusion.
    const alphabet = /^[23456789abcdefghjkmnpqrstuvwxyz]+$/;
    for (let i = 0; i < 100; i++) {
      const s = generateSlug();
      expect(s).toMatch(alphabet);
      expect(s.length).toBe(14);
      expect(isValidSlugShape(s)).toBe(true);
    }
  });

  it("avoids look-alike characters (0, o, 1, l, i)", () => {
    // 5000 samples — if any forbidden char ever appears, the alphabet is wrong.
    const forbidden = /[01loi]/;
    for (let i = 0; i < 5000; i++) {
      expect(generateSlug()).not.toMatch(forbidden);
    }
  });

  it("is unique across 50k samples (no collisions)", () => {
    // At 70 bits of entropy the birthday-collision floor is ~2^35 samples;
    // 50k is comfortably below that. A failure here means the generator is
    // not actually random.
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i++) {
      seen.add(generateSlug());
    }
    expect(seen.size).toBe(50_000);
  });

  it("is unguessable — high per-position entropy", () => {
    // Sample 10k slugs; the most common character at any position should
    // appear roughly 10000/31 ≈ 322 times. A biased RNG (e.g. timestamp +
    // counter) would cluster heavily — we cap at 5x the expected mean.
    const N = 10_000;
    const LEN = 14;
    const counts: Record<number, Record<string, number>> = {};
    for (let i = 0; i < N; i++) {
      const s = generateSlug();
      for (let p = 0; p < LEN; p++) {
        counts[p] ??= {};
        counts[p][s[p]] = (counts[p][s[p]] ?? 0) + 1;
      }
    }
    for (let p = 0; p < LEN; p++) {
      const max = Math.max(...Object.values(counts[p]));
      expect(max).toBeLessThan((N / 31) * 5);
    }
  });

  it("rejects malformed slugs in isValidSlugShape", () => {
    expect(isValidSlugShape("short")).toBe(false);
    expect(isValidSlugShape("0".repeat(14))).toBe(false); // 0 not in alphabet
    expect(isValidSlugShape("o".repeat(14))).toBe(false); // o not in alphabet
    expect(isValidSlugShape("ABCDEFGHJKMNPQ")).toBe(false); // uppercase
    expect(isValidSlugShape(generateSlug())).toBe(true);
  });
});
