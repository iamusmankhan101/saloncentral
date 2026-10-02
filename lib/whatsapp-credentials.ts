/**
 * WhatsApp provider setup (API keys, phone-number IDs, template names) is
 * managed by the platform admin, never by salons.
 *
 * It stays in the salon's settings row (`wasender.*`) because every server-side
 * sender (crons, queues, /api/whatsapp/send) already reads it from there, but
 * it is stripped before settings reach a salon's browser and can't be changed
 * by a salon's settings save. The browser only learns `connected` (a key is
 * set for the chosen provider) and `provider` (needed for pacing and for the
 * providers that can't post to groups) — never a key.
 */

type Json = Record<string, unknown>;

/** Provider-specific fields an admin manages. `provider` itself is admin-managed too but is shown (not secret). */
export function isProviderField(key: string): boolean {
  return key === "apiKey" || key.startsWith("botSailor") || key.startsWith("zaptick") || key.startsWith("chakra");
}

/** The credential that matters for the selected provider. */
export function activeCredential(ws: Json | null | undefined): string {
  if (!ws) return "";
  const provider = String(ws.provider ?? "wasender");
  const v = provider === "botsailor" ? ws.botSailorApiToken
    : provider === "zaptick" ? ws.zaptickApiKey
    : provider === "chakra" ? ws.chakraAccessToken
    : ws.apiKey;
  return typeof v === "string" ? v.trim() : "";
}

/** Settings as a salon's browser may see them: provider fields removed, `wasender.connected` added. */
export function settingsForSalon(settings: Json): Json {
  const ws = settings.wasender as Json | undefined;
  if (!ws || typeof ws !== "object") return settings;
  const safe: Json = {};
  for (const [k, v] of Object.entries(ws)) if (!isProviderField(k)) safe[k] = v;
  safe.connected = !!activeCredential(ws);
  return { ...settings, wasender: safe };
}

/**
 * A salon's settings save, with the admin-managed provider setup taken from
 * what's stored — whatever the browser sent for those fields is ignored, so a
 * salon can neither change nor (by saving a stale copy) wipe them.
 */
export function mergeSalonSettingsSave(incoming: Json, stored: Json | null): Json {
  const inWs = (incoming.wasender && typeof incoming.wasender === "object" ? incoming.wasender : {}) as Json;
  const storedWs = (stored?.wasender && typeof stored.wasender === "object" ? stored.wasender : {}) as Json;
  const merged: Json = {};
  for (const [k, v] of Object.entries(inWs)) if (!isProviderField(k) && k !== "connected" && k !== "provider") merged[k] = v;
  for (const [k, v] of Object.entries(storedWs)) if (isProviderField(k) || k === "provider") merged[k] = v;
  return { ...incoming, wasender: merged };
}

/** The editable provider setup an admin sees for one salon. */
export function providerSetupOf(settings: Json | null): Json {
  const ws = (settings?.wasender ?? {}) as Json;
  const out: Json = { provider: ws.provider ?? "wasender" };
  for (const [k, v] of Object.entries(ws)) if (isProviderField(k)) out[k] = v;
  return out;
}
