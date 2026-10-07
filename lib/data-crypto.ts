/**
 * lib/data-crypto.ts
 *
 * Encryption at rest for salon data, on top of whatever the database host
 * does: the `data` column of salon_data and of the three backup tables is
 * AES-256-GCM encrypted before it leaves the server, so a copied database, a
 * leaked DB token or a downloaded backup reveals nothing without the key.
 *
 * Applied in one place — lib/db.ts wraps the client with sealStatement() on
 * the way in and openResult() on the way out — so none of the ~30 routes that
 * read or write these tables had to change. Every write of these columns is an
 * `INSERT … INTO table (cols) VALUES (…)`, which is what sealStatement
 * recognises (UPDATEs on these tables never set them); nothing queries inside
 * them, so ciphertext there is safe.
 *
 * Key: DATA_ENCRYPTION_KEY, 32 random bytes base64 (`openssl rand -base64 32`).
 * Unset → values are stored as plain text exactly as before, so a deploy
 * without the key keeps working. Losing the key loses the data: keep a copy
 * somewhere safe outside Vercel.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import type { InArgs, InStatement, ResultSet, Row, Value } from "@libsql/client";

const PREFIX = "enc:v1:";

/** table → the column holding salon data. */
const ENCRYPTED_COLUMNS: Record<string, string> = {
  salon_data: "data",
  salon_data_backups: "data",
  salon_backup_bundles: "data",
  database_backups: "data",
  // The WhatsApp receipt queue keeps a full copy of each POS invoice.
  wa_pos_receipt_queue: "invoice_json",
};
export const ENCRYPTED_TABLES = Object.keys(ENCRYPTED_COLUMNS);

let warned = false;

function getKey(): Buffer | null {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) {
    if (!warned && process.env.NODE_ENV === "production") {
      console.warn("[data-crypto] DATA_ENCRYPTION_KEY is not set — salon data is stored unencrypted.");
      warned = true;
    }
    return null;
  }
  const key = Buffer.from(raw, "base64");
  // Fail closed: a mistyped key must never be used to write data nobody can read back.
  if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).");
  return key;
}

export function encryptionEnabled(): boolean {
  return getKey() !== null;
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Encrypts `plain` when a key is configured; returns it unchanged otherwise. */
export function encryptValue(plain: string): string {
  const key = getKey();
  if (!key || isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${body.toString("base64")}`;
}

export function decryptValue(value: string): string {
  if (!isEncrypted(value)) return value;
  const key = getKey();
  if (!key) throw new Error("Encrypted salon data found but DATA_ENCRYPTION_KEY is not set.");
  const [iv, tag, body] = value.slice(PREFIX.length).split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

const INSERT_RE = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i;

/** Encrypts the data argument of an INSERT into one of the encrypted tables. */
export function sealStatement(stmt: InStatement): InStatement {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  const match = INSERT_RE.exec(sql);
  if (!match || typeof stmt === "string" || !Array.isArray(stmt.args)) return stmt;
  const column = ENCRYPTED_COLUMNS[match[1].toLowerCase()];
  if (!column) return stmt;
  // Column position → argument position: VALUES can mix literals ('pending', 0)
  // in with the placeholders, so count the `?`s before the column's own slot.
  const columnAt = match[2].split(",").map((c) => c.trim().toLowerCase()).indexOf(column);
  const values = match[3].split(",").map((v) => v.trim());
  if (columnAt < 0 || values[columnAt] !== "?") return stmt;
  const index = values.slice(0, columnAt).filter((v) => v === "?").length;
  const value = stmt.args[index];
  if (typeof value !== "string") return stmt;
  const args = [...stmt.args];
  args[index] = encryptValue(value);
  return { sql, args };
}

/** The (sql, args) call form folded into one statement. */
export function toStatement(stmtOrSql: InStatement, args?: InArgs): InStatement {
  return typeof stmtOrSql === "string" && args !== undefined ? { sql: stmtOrSql, args } : stmtOrSql;
}

/**
 * Decrypts any encrypted cell in place of the row. libsql rows have read-only
 * index properties, so an affected row is rebuilt in the same shape (indexed
 * values, `length`, and the named columns).
 */
export function openResult(result: ResultSet): ResultSet {
  for (let r = 0; r < result.rows.length; r++) {
    const row = result.rows[r];
    const values: Value[] = Array.from({ length: row.length }, (_, i) => row[i]);
    if (!values.some(isEncrypted)) continue;
    const opened = values.map((v) => (isEncrypted(v) ? decryptValue(v) : v));
    const out = {} as Row;
    Object.defineProperty(out, "length", { value: opened.length });
    opened.forEach((v, i) => Object.defineProperty(out, i, { value: v }));
    result.columns.forEach((name, i) => {
      if (!Object.prototype.hasOwnProperty.call(out, name)) {
        Object.defineProperty(out, name, { value: opened[i], enumerable: true, configurable: true, writable: true });
      }
    });
    result.rows[r] = out;
  }
  return result;
}
