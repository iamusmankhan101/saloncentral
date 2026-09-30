/**
 * lib/polyfills.ts
 *
 * Browser APIs the app calls that older Safari (< 15.4) lacks. Imported once
 * from the root layout's client component. Syntax is handled by the
 * browserslist in package.json; this only covers missing runtime functions.
 */

if (typeof window !== "undefined") {
  const c = window.crypto as Crypto & { randomUUID?: () => string };
  if (c && typeof c.randomUUID !== "function" && typeof c.getRandomValues === "function") {
    c.randomUUID = () => {
      const b = c.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
    };
  }

  if (typeof window.structuredClone !== "function") {
    // Callers clone plain JSON-shaped data (settings, cart items), so a JSON
    // round-trip is sufficient here.
    window.structuredClone = (<T,>(value: T): T =>
      value === undefined ? value : JSON.parse(JSON.stringify(value))) as typeof structuredClone;
  }
}

export {};
