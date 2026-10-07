import { createClient, type Client, type InArgs, type InStatement } from "@libsql/client";
import { openResult, sealStatement, toStatement } from "@/lib/data-crypto";

// Create the client at module load time with a fallback URL so the module can
// be imported during `next build` without throwing.  No network connection is
// made until the first call to db.execute() / db.batch() etc., which only
// happens at request time when the real env vars are present.
const raw: Client = createClient({
  url:       process.env.TURSO_DATABASE_URL ?? "http://localhost:8080",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Salon data is encrypted on its way into the database and decrypted on its
// way out (lib/data-crypto.ts), here, so every caller gets it for free.
// ponytail: only execute/batch are wrapped — transaction() isn't used on salon data; wrap it if that changes.
export const db: Client = new Proxy(raw, {
  get(target, prop) {
    if (prop === "execute") {
      return (stmt: InStatement, args?: InArgs) =>
        target.execute(sealStatement(toStatement(stmt, args))).then(openResult);
    }
    if (prop === "batch") {
      return (stmts: InStatement[], mode?: Parameters<Client["batch"]>[1]) =>
        target.batch(stmts.map(sealStatement), mode).then((results) => results.map(openResult));
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

// Convenience accessor — same instance, kept for symmetry with callers that
// already use getDb() after the lazy-singleton refactor.
export function getDb(): Client {
  return db;
}
