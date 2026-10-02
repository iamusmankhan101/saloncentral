export type WhatsAppProvider = "wasender" | "botsailor" | "zaptick" | "chakra" | "ycloud";

export interface WhatsAppProviderConfig {
  provider?: WhatsAppProvider;
  apiKey?: string;
  botSailorApiToken?: string;
  botSailorPhoneNumberId?: string;
  botSailorTemplateReminder?: string;
  botSailorTemplateConfirmation?: string;
  botSailorTemplateFollowup?: string;
  botSailorTemplateCancellation?: string;
  botSailorTemplateBirthday?: string;
  botSailorTemplateWinback?: string;
  zaptickApiKey?: string;
  chakraAccessToken?: string;
  chakraPluginId?: string;
  chakraWhatsappPhoneNumberId?: string;
  chakraTemplateReminder?: string;
  chakraTemplateConfirmation?: string;
  chakraTemplateFollowup?: string;
  chakraTemplateCancellation?: string;
  chakraTemplateBirthday?: string;
  chakraTemplateWinback?: string;
  /** YCloud (official Meta partner) API key — Developers → API Keys. */
  ycloudApiKey?: string;
  /** The salon's WhatsApp business number registered in YCloud, e.g. +923001234567. */
  ycloudFromNumber?: string;
  /** Language code the templates were approved in, e.g. "en" or "en_US". */
  ycloudTemplateLanguage?: string;
  /** Used for any message type without its own template below (manual sends, alerts, receipts). */
  ycloudTemplateDefault?: string;
  ycloudTemplateReminder?: string;
  ycloudTemplateConfirmation?: string;
  ycloudTemplateFollowup?: string;
  ycloudTemplateCancellation?: string;
  ycloudTemplateBirthday?: string;
  ycloudTemplateWinback?: string;
}

/** Every YCloud field of a stored `wasender` settings object, for building a provider config. */
export function ycloudConfigOf(ws: unknown): Partial<WhatsAppProviderConfig> {
  const src = (ws && typeof ws === "object" ? ws : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (k.startsWith("ycloud") && typeof v === "string") out[k] = v;
  return out as Partial<WhatsAppProviderConfig>;
}

/**
 * Meta rejects a template parameter containing a newline, a tab or more than
 * four spaces in a row (error 132018), and caps body parameters at 1024
 * characters. The app's composed messages are multi-line, so flatten them.
 */
export function templateParamText(text: string): string {
  const flat = text
    .replace(/\s*\n+\s*/g, " · ")
    .replace(/\t/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim();
  return flat.length > 1024 ? `${flat.slice(0, 1021)}...` : flat;
}

export interface WhatsAppSendResult {
  ok: boolean;
  status: number;
  skipped?: boolean;
  data?: unknown;
  errorReason?: string;
}

export function activeWhatsAppCredential(config: WhatsAppProviderConfig): string {
  if (config.provider === "botsailor") return config.botSailorApiToken || "";
  if (config.provider === "zaptick") return config.zaptickApiKey || "";
  if (config.provider === "chakra") return config.chakraAccessToken || "";
  if (config.provider === "ycloud") return config.ycloudApiKey || "";
  return config.apiKey || "";
}

/**
 * Detects obviously-fake/placeholder phone numbers — every digit the same
 * (0000000000), sequential runs (1234567890, 0123456789, 9876543210, ...), or the
 * "count from 1" pattern (12345678910 = "1"+"2"+...+"9"+"10") that test/demo
 * bookings tend to get typed in — so WhatsApp sends are skipped for them instead
 * of failing (or worse, landing on some unrelated real number) at the provider.
 */
export function isFakePlaceholderPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return false;

  if (/^(\d)\1+$/.test(digits)) return true;

  const chars = digits.split("");
  const isAscending = chars.length > 1 && chars.every((d, i) => i === 0 || (Number(d) - Number(chars[i - 1]) + 10) % 10 === 1);
  const isDescending = chars.length > 1 && chars.every((d, i) => i === 0 || (Number(chars[i - 1]) - Number(d) + 10) % 10 === 1);
  if (isAscending || isDescending) return true;

  let counted = "";
  for (let n = 1; counted.length < digits.length; n++) counted += String(n);
  if (counted.slice(0, digits.length) === digits) return true;

  return false;
}

export function isNonWhatsAppRecipientError(reason?: string): boolean {
  return /jid does not exist on whatsapp/i.test(reason || "");
}

export async function sendWhatsAppMessage(
  config: WhatsAppProviderConfig,
  phone: string,
  text: string,
  options?: { messageType?: "reminder" | "confirmation" | "followup" | "cancellation" | "birthday" | "winback" | "manual" },
): Promise<WhatsAppSendResult> {
  // Group JIDs (…@g.us) aren't phone numbers, so the fake-number check doesn't apply.
  if (!phone.endsWith("@g.us") && isFakePlaceholderPhone(phone)) {
    return { ok: false, skipped: true, status: 200, errorReason: "Recipient looks like a fake/placeholder phone number." };
  }

  const provider = config.provider ?? "wasender";

  // ─── Zaptick Provider ───────────────────────────────────────────────────────
  if (provider === "zaptick") {
    const apiKey = config.zaptickApiKey || "";
    
    if (!apiKey) {
      return { ok: false, status: 500, errorReason: "Zaptick API key is required." };
    }

    // Zaptick uses WhatsApp Web multi-device protocol - supports both individual and group messages
    // Works with existing personal/business WhatsApp numbers (QR code connection)
    const normalizedPhone = phone.replace(/\D/g, "");
    const recipientNumber = phone.endsWith("@g.us") ? phone : normalizedPhone;

    try {
      const response = await fetch("https://api.zaptick.io/api/v1/messages/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          recipient: recipientNumber,
          message: text,
        }),
      });

      const data = await response.json().catch(() => ({})) as { 
        success?: boolean; 
        status?: string;
        message?: string; 
        error?: string;
      };

      const ok = response.ok && (data.success === true || data.status === "success");
      return { 
        ok, 
        status: response.status, 
        data, 
        errorReason: ok ? undefined : (data.error || data.message || `HTTP ${response.status}`) 
      };
    } catch (err) {
      return { 
        ok: false, 
        status: 500, 
        errorReason: err instanceof Error ? err.message : "Failed to connect to Zaptick API" 
      };
    }
  }

  // ─── YCloud Provider ────────────────────────────────────────────────────────
  // YCloud is an official Meta partner (Cloud API), so business-initiated
  // messages must use an approved template. Each template is expected to have
  // one body variable ({{1}}) that receives the app's composed message, the
  // same convention as ChakraHQ. With no template configured at all it falls
  // back to plain text, which Meta only delivers inside the 24h window after
  // the customer last messaged the salon.
  // Docs: https://docs.ycloud.com/reference/whatsapp_message-send-directly
  if (provider === "ycloud") {
    const apiKey = config.ycloudApiKey || "";
    const from = (config.ycloudFromNumber || "").replace(/[^\d+]/g, "");
    if (!apiKey || !from) {
      return { ok: false, status: 500, errorReason: "YCloud API key and business WhatsApp number are required." };
    }
    if (phone.endsWith("@g.us")) {
      return { ok: false, status: 400, errorReason: "YCloud (Meta Cloud API) does not support WhatsApp group recipients." };
    }

    const messageType = options?.messageType;
    const byType: Record<string, string | undefined> = {
      reminder: config.ycloudTemplateReminder, confirmation: config.ycloudTemplateConfirmation,
      followup: config.ycloudTemplateFollowup, cancellation: config.ycloudTemplateCancellation,
      birthday: config.ycloudTemplateBirthday, winback: config.ycloudTemplateWinback,
    };
    const templateName = ((messageType && byType[messageType]) || config.ycloudTemplateDefault || "").trim();
    const to = `+${phone.replace(/\D/g, "")}`;
    const fromE164 = from.startsWith("+") ? from : `+${from}`;
    const body = templateName
      ? {
          from: fromE164, to, type: "template",
          template: {
            name: templateName,
            language: { code: (config.ycloudTemplateLanguage || "en").trim() },
            components: [{ type: "body", parameters: [{ type: "text", text: templateParamText(text) }] }],
          },
        }
      : { from: fromE164, to, type: "text", text: { body: text.slice(0, 4096) } };

    try {
      const response = await fetch("https://api.ycloud.com/v2/whatsapp/messages/sendDirectly", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey, Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json().catch(() => ({})) as {
        status?: string; errorCode?: string; errorMessage?: string;
        error?: { message?: string; code?: string; whatsappApiError?: { message?: string } }; message?: string;
      };
      // sendDirectly returns the message with status accepted/sent/delivered/read, or failed.
      const ok = response.ok && data.status !== "failed";
      const errorReason = ok ? undefined
        : (data.errorMessage || data.error?.whatsappApiError?.message || data.error?.message || data.message || `HTTP ${response.status}`)
          + (!templateName ? " (no YCloud template is set, so this was sent as plain text, which only works within 24h of the customer's last message)" : "");
      return { ok, status: response.status, data, errorReason };
    } catch (err) {
      return { ok: false, status: 500, errorReason: err instanceof Error ? err.message : "Failed to connect to YCloud API" };
    }
  }

  // ─── ChakraHQ Provider ──────────────────────────────────────────────────────
  // ChakraHQ is a Meta Cloud API partner (like BotSailor) — business-initiated
  // messages outside the 24h customer service window require an approved
  // WhatsApp template, so this always sends via send-template-message rather
  // than free text. See https://apidocs.chakrahq.com (chakra-chat-sdk source).
  if (provider === "chakra") {
    const accessToken = config.chakraAccessToken || "";
    const pluginId = config.chakraPluginId || "";
    const whatsappPhoneNumberId = config.chakraWhatsappPhoneNumberId || "";
    if (!accessToken || !pluginId || !whatsappPhoneNumberId) {
      return { ok: false, status: 500, errorReason: "Chakra access token, Plugin ID, and WhatsApp Phone Number ID are required." };
    }
    if (phone.endsWith("@g.us")) {
      return { ok: false, status: 400, errorReason: "ChakraHQ (Meta Cloud API) does not support WhatsApp group recipients." };
    }

    const messageType = options?.messageType;
    let templateName = "";
    if (messageType === "reminder") templateName = config.chakraTemplateReminder || "";
    else if (messageType === "confirmation") templateName = config.chakraTemplateConfirmation || "";
    else if (messageType === "followup") templateName = config.chakraTemplateFollowup || "";
    else if (messageType === "cancellation") templateName = config.chakraTemplateCancellation || "";
    else if (messageType === "birthday") templateName = config.chakraTemplateBirthday || "";
    else if (messageType === "winback") templateName = config.chakraTemplateWinback || "";
    if (!templateName) {
      return { ok: false, status: 500, errorReason: `No ChakraHQ template configured for message type "${messageType || "manual"}".` };
    }

    const toPhoneNumber = phone.replace(/\D/g, "");
    const path = `/v1/ext/plugin/whatsapp/${encodeURIComponent(pluginId)}/phoneNumber/${encodeURIComponent(toPhoneNumber)}/send-template-message`;

    try {
      const response = await fetch(`https://api.chakrahq.com${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          whatsappPhoneNumberId,
          templateName,
          mapping: [{ schemaPropertyName: "1", schemaPropertyValue: text }],
        }),
      });

      const data = await response.json().catch(() => ({})) as { _data?: unknown; _errors?: string[] };
      const ok = response.ok && !data._errors?.length;
      return { ok, status: response.status, data, errorReason: ok ? undefined : (data._errors?.[0] || `HTTP ${response.status}`) };
    } catch (err) {
      return { ok: false, status: 500, errorReason: err instanceof Error ? err.message : "Failed to connect to ChakraHQ API" };
    }
  }

  // ─── BotSailor Provider ─────────────────────────────────────────────────────
  if (provider === "botsailor") {
    const apiToken = config.botSailorApiToken || "";
    const phoneNumberId = config.botSailorPhoneNumberId || "";
    if (!apiToken || !phoneNumberId) {
      return { ok: false, status: 500, errorReason: "BotSailor API token and phone number ID are required." };
    }
    if (phone.endsWith("@g.us")) {
      return { ok: false, status: 400, errorReason: "BotSailor Cloud API does not support WhatsApp group recipients." };
    }

    // Get template ID based on message type
    const messageType = options?.messageType;
    let templateId = "";
    if (messageType === "reminder") templateId = config.botSailorTemplateReminder || "";
    else if (messageType === "confirmation") templateId = config.botSailorTemplateConfirmation || "";
    else if (messageType === "followup") templateId = config.botSailorTemplateFollowup || "";
    else if (messageType === "cancellation") templateId = config.botSailorTemplateCancellation || "";
    else if (messageType === "birthday") templateId = config.botSailorTemplateBirthday || "";
    else if (messageType === "winback") templateId = config.botSailorTemplateWinback || "";

    // Build request body
    const bodyParams: Record<string, string> = {
      apiToken,
      phone_number_id: phoneNumberId,
      phone_number: phone.replace(/\D/g, ""),
    };

    // If template ID is provided, use template-based message; otherwise send as regular message
    if (templateId) {
      bodyParams.template_name = templateId;
      bodyParams.language_code = "en"; // or make this configurable
      // For template messages, Meta requires variables in a specific format
      // If your templates have variables, you'd need to parse the text and extract them
      // For now, we'll send the message as-is
    } else {
      // Fallback to regular message if no template ID
      bodyParams.message = text;
    }

    const body = new URLSearchParams(bodyParams);
    const response = await fetch("https://botsailor.com/api/v1/whatsapp/send", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await response.json().catch(() => ({})) as { status?: string | number | boolean; message?: string };
    const ok = response.ok && (data.status === "1" || data.status === 1 || data.status === true);
    return { ok, status: response.status, data, errorReason: ok ? undefined : (data.message || `HTTP ${response.status}`) };
  }

  // ─── WaSender Provider ──────────────────────────────────────────────────────
  const apiKey = config.apiKey || "";
  if (!apiKey) return { ok: false, status: 500, errorReason: "WaSender API key not configured." };
  const to = phone.endsWith("@g.us") || phone.startsWith("+") ? phone : `+${phone}`;
  const response = await fetch("https://www.wasenderapi.com/api/send-message", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ to, text }),
  });
  const data = await response.json().catch(() => ({})) as { success?: boolean; message?: string; error?: string };
  const ok = response.ok && data.success === true;
  const errorReason = ok ? undefined : (data.message || data.error || `HTTP ${response.status}`);
  if (isNonWhatsAppRecipientError(errorReason)) {
    return { ok: false, skipped: true, status: response.status, data, errorReason };
  }
  return { ok, status: response.status, data, errorReason };
}

export async function checkWhatsAppProvider(config: WhatsAppProviderConfig) {
  const provider = config.provider ?? "wasender";
  
  // ─── Zaptick Provider Status ────────────────────────────────────────────────
  if (provider === "zaptick") {
    const apiKey = config.zaptickApiKey || "";
    if (!apiKey) return { connected: false, status: "NOT_CONFIGURED", message: "Zaptick API key is required." };
    
    try {
      const response = await fetch("https://api.zaptick.io/api/v1/status", {
        headers: { 
          "Authorization": `Bearer ${apiKey}`,
          "Accept": "application/json" 
        },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      
      const data = await response.json().catch(() => ({})) as {
        success?: boolean;
        status?: string;
        connected?: boolean;
        message?: string;
      };
      
      const connected = response.ok && (data.success === true || data.connected === true || data.status === "connected");
      return {
        connected,
        status: connected ? "CONNECTED" : "DISCONNECTED",
        message: data.message || (connected ? "Zaptick account active." : "Zaptick session disconnected."),
      };
    } catch (err) {
      return {
        connected: false,
        status: "ERROR",
        message: err instanceof Error ? err.message : "Failed to check Zaptick status.",
      };
    }
  }
  
  // ─── YCloud Provider Status ─────────────────────────────────────────────────
  // Lists the account's WhatsApp numbers: proves the key works and that the
  // salon's sending number is registered and connected.
  if (provider === "ycloud") {
    const apiKey = config.ycloudApiKey || "";
    if (!apiKey) return { connected: false, status: "NOT_CONFIGURED", message: "YCloud API key is required." };
    const fromDigits = (config.ycloudFromNumber || "").replace(/\D/g, "");
    if (!fromDigits) return { connected: false, status: "NOT_CONFIGURED", message: "The salon's WhatsApp business number is required." };
    try {
      const response = await fetch("https://api.ycloud.com/v2/whatsapp/phoneNumbers?limit=100", {
        headers: { "X-API-Key": apiKey, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        return { connected: false, status: "DISCONNECTED", message: response.status === 401 || response.status === 403 ? "YCloud API key was rejected." : `YCloud check failed (HTTP ${response.status}).` };
      }
      const data = await response.json().catch(() => ({})) as { items?: { phoneNumber?: string; status?: string; qualityRating?: string; verifiedName?: string }[] };
      const match = (data.items ?? []).find((p) => (p.phoneNumber || "").replace(/\D/g, "") === fromDigits);
      if (!match) return { connected: false, status: "DISCONNECTED", message: "That WhatsApp number isn't in this YCloud account." };
      const connected = (match.status || "").toUpperCase() === "CONNECTED";
      return {
        connected,
        status: (match.status || "UNKNOWN").toUpperCase(),
        message: connected
          ? `YCloud number active${match.verifiedName ? ` (${match.verifiedName})` : ""}${match.qualityRating ? `, quality ${match.qualityRating}` : ""}.`
          : `YCloud number status: ${match.status || "unknown"}.`,
      };
    } catch (err) {
      return { connected: false, status: "ERROR", message: err instanceof Error ? err.message : "Failed to check YCloud status." };
    }
  }

  // ─── ChakraHQ Provider Status ───────────────────────────────────────────────
  if (provider === "chakra") {
    const accessToken = config.chakraAccessToken || "";
    if (!accessToken) return { connected: false, status: "NOT_CONFIGURED", message: "Chakra access token is required." };
    if (!config.chakraPluginId || !config.chakraWhatsappPhoneNumberId) {
      return { connected: false, status: "NOT_CONFIGURED", message: "Chakra Plugin ID and WhatsApp Phone Number ID are required." };
    }

    try {
      // No dedicated health-check endpoint is documented — validate the
      // access token itself against the account-level config endpoint.
      const response = await fetch("https://api.chakrahq.com/v1/ext/config", {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      return {
        connected: response.ok,
        status: response.ok ? "CONNECTED" : "DISCONNECTED",
        message: response.ok ? "Chakra access token is valid." : `Chakra authentication failed (HTTP ${response.status}).`,
      };
    } catch (err) {
      return {
        connected: false,
        status: "ERROR",
        message: err instanceof Error ? err.message : "Failed to check Chakra status.",
      };
    }
  }

  // ─── BotSailor Provider Status ──────────────────────────────────────────────
  if (provider === "botsailor") {
    const apiToken = config.botSailorApiToken || "";
    if (!apiToken) return { connected: false, status: "NOT_CONFIGURED", message: "BotSailor API token is required." };
    const response = await fetch(`https://botsailor.com/api/v1/user/myInfo?apiToken=${encodeURIComponent(apiToken)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json().catch(() => ({})) as {
      status?: string | number | boolean;
      message?: { whatsapp_bots_details?: Array<{ phone_number_id?: string }> } | string;
    };
    const authenticated = response.ok && (data.status === "1" || data.status === 1 || data.status === true);
    const accounts = typeof data.message === "object" ? data.message.whatsapp_bots_details ?? [] : [];
    const phoneMatches = !config.botSailorPhoneNumberId || accounts.some((account) => account.phone_number_id === config.botSailorPhoneNumberId);
    return {
      connected: authenticated && phoneMatches,
      status: authenticated && phoneMatches ? "CONNECTED" : "DISCONNECTED",
      message: !authenticated
        ? (typeof data.message === "string" ? data.message : "BotSailor authentication failed.")
        : phoneMatches ? "BotSailor account active." : "Phone number ID was not found in this BotSailor account.",
    };
  }

  // ─── WaSender Provider Status ───────────────────────────────────────────────
  const apiKey = config.apiKey || "";
  if (!apiKey) return { connected: false, status: "NOT_CONFIGURED", message: "WaSender API key is required." };
  const response = await fetch("https://www.wasenderapi.com/api/status", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json().catch(() => ({})) as { status?: string; message?: string; data?: { status?: string } };
  const status = (data.data?.status ?? data.status ?? "").toUpperCase();
  const connected = response.ok && status === "CONNECTED";
  return { connected, status: status || "DISCONNECTED", message: data.message || (connected ? "Session active." : "WaSender session disconnected.") };
}
