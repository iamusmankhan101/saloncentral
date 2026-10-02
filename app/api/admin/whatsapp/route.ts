/**
 * Admin-only: view, set and test a salon's WhatsApp provider setup. Salons
 * never see or change these fields (see lib/whatsapp-credentials.ts).
 *
 * GET  ?userId=<salonOwnerId>          → the salon's provider setup
 * POST { userId, setup }               → save it (provider fields only)
 * POST { userId, test: true }          → check the stored setup with the provider
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/api-auth";
import { backupExistingSalonData } from "@/lib/data-backup";
import { checkWhatsAppProvider, ycloudConfigOf, type WhatsAppProvider } from "@/lib/whatsapp-provider";
import { activeCredential, isProviderField, providerSetupOf } from "@/lib/whatsapp-credentials";

type Json = Record<string, unknown>;
const PROVIDERS = new Set(["wasender", "botsailor", "zaptick", "chakra", "ycloud"]);

async function loadSettings(userId: string): Promise<Json | null> {
  const res = await db.execute({ sql: "SELECT data FROM salon_data WHERE entity = ?", args: [`${userId}_settings`] });
  if (!res.rows.length) return null;
  try { return JSON.parse(res.rows[0].data as string) as Json; } catch { return null; }
}

export async function GET(req: NextRequest) {
  if (!(await requireAdmin(req))) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const userId = req.nextUrl.searchParams.get("userId") ?? "";
  if (!userId) return Response.json({ ok: false, error: "Missing userId" }, { status: 400 });
  const settings = await loadSettings(userId);
  const setup = providerSetupOf(settings);
  return Response.json({ ok: true, setup, connected: !!activeCredential(setup) });
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin(req))) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  let body: { userId?: string; setup?: Json; test?: boolean };
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "Invalid body" }, { status: 400 }); }
  const userId = String(body.userId ?? "");
  if (!userId) return Response.json({ ok: false, error: "Missing userId" }, { status: 400 });

  const settings = (await loadSettings(userId)) ?? {};
  const ws = (settings.wasender && typeof settings.wasender === "object" ? settings.wasender : {}) as Json;

  if (body.test) {
    const str = (k: string) => (typeof ws[k] === "string" && ws[k] ? (ws[k] as string).trim() : undefined);
    if (!activeCredential(ws)) return Response.json({ ok: false, connected: false, message: "No API key saved for this salon yet." });
    try {
      const result = await checkWhatsAppProvider({
        provider: (str("provider") ?? "wasender") as WhatsAppProvider,
        apiKey: str("apiKey"), botSailorApiToken: str("botSailorApiToken"), botSailorPhoneNumberId: str("botSailorPhoneNumberId"),
        zaptickApiKey: str("zaptickApiKey"), chakraAccessToken: str("chakraAccessToken"),
        chakraPluginId: str("chakraPluginId"), chakraWhatsappPhoneNumberId: str("chakraWhatsappPhoneNumberId"),
        ...ycloudConfigOf(ws),
      });
      return Response.json({ ok: result.connected, ...result });
    } catch (err) {
      return Response.json({ ok: false, connected: false, message: `Could not reach the provider: ${String(err)}` }, { status: 502 });
    }
  }

  const setup = (body.setup && typeof body.setup === "object" ? body.setup : {}) as Json;
  const provider = String(setup.provider ?? "wasender");
  if (!PROVIDERS.has(provider)) return Response.json({ ok: false, error: "Unknown provider" }, { status: 400 });

  const nextWs: Json = { ...ws, provider };
  for (const [k, v] of Object.entries(setup)) {
    if (isProviderField(k)) nextWs[k] = typeof v === "string" ? v.trim() : "";
  }
  await backupExistingSalonData(`${userId}_settings`, userId);
  await db.execute({
    sql: "INSERT OR REPLACE INTO salon_data (entity, data, updated_at) VALUES (?, ?, ?)",
    args: [`${userId}_settings`, JSON.stringify({ ...settings, wasender: nextWs }), new Date().toISOString()],
  });
  return Response.json({ ok: true, connected: !!activeCredential(nextWs) });
}
