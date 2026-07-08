// Minimal class-name joiner (zero deps — TECH_SPEC §8 guest bundle budget).
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
