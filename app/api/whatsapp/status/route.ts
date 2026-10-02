import { NextRequest } from "next/server";
import { checkWhatsAppProvider, type WhatsAppProvider } from "@/lib/whatsapp-provider";
import { resolveActor } from "@/lib/api-auth";
import { loadWhatsAppConfig } from "@/lib/whatsapp-config-server";

// Server-side cache — one real check per 15 minutes maximum.
// Free WaSender plan = 1 req/min total (includes message sends).
// We must not waste that quota on status polling.
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { connected: boolean; status: string; message: string; ts: number }>();

export async function GET(request: NextRequest) {
  const actor = await resolveActor(request);
  if (!actor) return Response.json({ ok: false, connected: false, error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  // Provider + keys come from the salon's stored setup, never the browser.
  const ws = await loadWhatsAppConfig(actor.userId);
  const str = (k: string) => (typeof ws[k] === "string" ? (ws[k] as string).trim() : "");
  const provider = (str("provider") || "wasender") as WhatsAppProvider;
  const apiKey = str("apiKey");
  const botSailorApiToken = str("botSailorApiToken");
  const botSailorPhoneNumberId = str("botSailorPhoneNumberId");
  const zaptickApiKey = str("zaptickApiKey");
  const chakraAccessToken = str("chakraAccessToken");
  const chakraPluginId = str("chakraPluginId");
  const chakraWhatsappPhoneNumberId = str("chakraWhatsappPhoneNumberId");
  const force  = searchParams.get("force") === "1"; // manual "Test Connection" click

  const credential = provider === "botsailor" ? botSailorApiToken : provider === "zaptick" ? zaptickApiKey : provider === "chakra" ? chakraAccessToken : apiKey;
  if (!credential) {
    return Response.json({ ok: false, connected: false, error: "Not connected - contact Salon Central support" });
  }

  // Return cached result unless a manual test is requested
  const cacheKey = `${provider}:${credential}:${botSailorPhoneNumberId || chakraWhatsappPhoneNumberId || ""}`;
  const cached = cache.get(cacheKey);
  if (cached && !force && Date.now() - cached.ts < CACHE_TTL_MS) {
    return Response.json({ ok: cached.connected, connected: cached.connected, status: cached.status, message: cached.message, cached: true });
  }

  try {
    const result = await checkWhatsAppProvider({
      provider,
      apiKey: apiKey || undefined,
      botSailorApiToken: botSailorApiToken || undefined,
      botSailorPhoneNumberId: botSailorPhoneNumberId || undefined,
      zaptickApiKey: zaptickApiKey || undefined,
      chakraAccessToken: chakraAccessToken || undefined,
      chakraPluginId: chakraPluginId || undefined,
      chakraWhatsappPhoneNumberId: chakraWhatsappPhoneNumberId || undefined,
    });
    cache.set(cacheKey, { ...result, ts: Date.now() });
    return Response.json({ ok: result.connected, ...result });

  } catch (err) {
    // Network/timeout error — if we have a stale cache, prefer it over falsely showing disconnected
    if (cached) {
      return Response.json({ ok: cached.connected, connected: cached.connected, status: cached.status, message: cached.message, stale: true });
    }
    const providerName = provider === "botsailor" ? "BotSailor" : provider === "zaptick" ? "Zaptick" : provider === "chakra" ? "ChakraHQ" : "WaSender";
    return Response.json({ ok: false, connected: false, status: "UNKNOWN", message: `Could not reach ${providerName}.`, error: String(err) }, { status: 502 });
  }
}
