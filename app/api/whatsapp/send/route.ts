import { NextRequest } from "next/server";
import { sendWhatsAppMessage, type WhatsAppProvider } from "@/lib/whatsapp-provider";
import { checkWhatsAppSafety, recordWhatsAppSafetySend, type WhatsAppMessageIntent, type WhatsAppSafetyConfig } from "@/lib/whatsapp-safety";
import { resolveActor } from "@/lib/api-auth";
import { loadWhatsAppConfig } from "@/lib/whatsapp-config-server";

/** The salon's stored provider fields, with blanks for unset ones so nothing from the request survives. */
async function providerSetup(userId: string): Promise<Record<string, unknown>> {
  const ws = await loadWhatsAppConfig(userId);
  const keys = [
    "provider", "apiKey", "botSailorApiToken", "botSailorPhoneNumberId", "zaptickApiKey",
    "chakraAccessToken", "chakraPluginId", "chakraWhatsappPhoneNumberId",
    "chakraTemplateReminder", "chakraTemplateConfirmation", "chakraTemplateFollowup", "chakraTemplateCancellation", "chakraTemplateBirthday",
  ];
  return Object.fromEntries(keys.map((k) => [k, typeof ws[k] === "string" && ws[k] ? ws[k] : undefined]));
}

export async function POST(request: NextRequest) {
  // Without this check, an unauthenticated caller who omits apiKey/botSailorApiToken
  // would ride on this platform's own env-configured WhatsApp credentials to send
  // arbitrary messages to any phone number.
  const actor = await resolveActor(request);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  // The provider setup is admin-managed: always the salon's stored one,
  // whatever the request carries.
  Object.assign(body, await providerSetup(actor.userId));
  const {
    provider, apiKey, botSailorApiToken, botSailorPhoneNumberId, zaptickApiKey,
    chakraAccessToken, chakraPluginId, chakraWhatsappPhoneNumberId,
    chakraTemplateReminder, chakraTemplateConfirmation, chakraTemplateFollowup, chakraTemplateCancellation, chakraTemplateBirthday,
    phone, text, messageIntent, messageType, recipientOptedIn, safety,
  } = body as {
    provider?: WhatsAppProvider;
    apiKey?: string;
    botSailorApiToken?: string;
    botSailorPhoneNumberId?: string;
    zaptickApiKey?: string;
    chakraAccessToken?: string;
    chakraPluginId?: string;
    chakraWhatsappPhoneNumberId?: string;
    chakraTemplateReminder?: string;
    chakraTemplateConfirmation?: string;
    chakraTemplateFollowup?: string;
    chakraTemplateCancellation?: string;
    chakraTemplateBirthday?: string;
    phone: string;
    text: string;
    messageIntent?: WhatsAppMessageIntent;
    messageType?: "reminder" | "confirmation" | "followup" | "cancellation" | "birthday" | "manual";
    recipientOptedIn?: boolean;
    safety?: WhatsAppSafetyConfig;
  };

  if (!phone || !text) {
    return Response.json({ ok: false, error: "Missing required fields: phone, text" }, { status: 400 });
  }

  try {
    const safetyConfig = safety ?? (body as WhatsAppSafetyConfig);
    const safetyCheck = checkWhatsAppSafety({ phone, intent: messageIntent, recipientOptedIn, config: safetyConfig });
    if (!safetyCheck.ok) {
      return Response.json(
        { ok: false, error: safetyCheck.error, errorReason: safetyCheck.error, retryAfter: safetyCheck.retryAfter },
        { status: safetyCheck.status },
      );
    }

    // Note: random pacing between messages is applied by the caller (the bulk
    // scheduler / campaign queues) between successive sends, not here — sleeping
    // inside this request would block the serverless function for minutes and
    // risk hitting the platform's execution timeout.
    const result = await sendWhatsAppMessage(
      {
        provider, apiKey, botSailorApiToken, botSailorPhoneNumberId, zaptickApiKey,
        chakraAccessToken, chakraPluginId, chakraWhatsappPhoneNumberId,
        chakraTemplateReminder, chakraTemplateConfirmation, chakraTemplateFollowup, chakraTemplateCancellation, chakraTemplateBirthday,
      },
      phone,
      text,
      messageType ? { messageType } : undefined
    );
    if (result.ok) recordWhatsAppSafetySend({ phone, config: safetyConfig });
    return Response.json(result, { status: result.status >= 500 ? 500 : 200 });
  } catch (err) {
    console.error("WhatsApp provider error:", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
