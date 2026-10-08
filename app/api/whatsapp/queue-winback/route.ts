/**
 * /api/whatsapp/queue-winback
 *
 * Manual "Queue Now" for win-back messages, fired from the WhatsApp Messaging
 * page. Queues the same rows the nightly /api/cron/winback scan would, for the
 * signed-in salon only, and bypasses the autoWinback toggle — the owner clicking
 * the button *is* the intent — but never the cooldown or the per-run cap.
 */

import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/api-auth";
import { activeWhatsAppCredential, type WhatsAppProviderConfig, ycloudConfigOf } from "@/lib/whatsapp-provider";
import { ensureWinbackTables, enqueueWinbackForUser, loadSalonSettings } from "@/lib/winback-queue";

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  // Optional { clientIds } from the "Choose clients" picker; no body = everyone eligible.
  const body = await req.json().catch(() => ({})) as { clientIds?: unknown };
  let clientIds: string[] | undefined;
  if (body.clientIds !== undefined) {
    if (!Array.isArray(body.clientIds) || body.clientIds.length === 0 || body.clientIds.length > 5000
      || !body.clientIds.every((id) => typeof id === "string" && id.length > 0 && id.length < 200)) {
      return Response.json({ ok: false, error: "Pick at least one client." }, { status: 400 });
    }
    clientIds = body.clientIds as string[];
  }

  try {
    await ensureWinbackTables();

    const settings = await loadSalonSettings(actor.userId);
    const wasender = settings?.wasender as Record<string, unknown> | undefined;
    const providerConfig: WhatsAppProviderConfig = {
      provider: (wasender?.provider as WhatsAppProviderConfig["provider"]) || "wasender",
      apiKey: wasender?.apiKey as string | undefined,
      botSailorApiToken: wasender?.botSailorApiToken as string | undefined,
      botSailorPhoneNumberId: wasender?.botSailorPhoneNumberId as string | undefined,
      zaptickApiKey: wasender?.zaptickApiKey as string | undefined,
      chakraAccessToken: wasender?.chakraAccessToken as string | undefined,
      ...ycloudConfigOf(wasender),
    };
    if (!activeWhatsAppCredential(providerConfig)) {
      return Response.json({ ok: false, error: "WhatsApp is not connected. Add your provider credentials in Account settings first." }, { status: 400 });
    }

    const result = await enqueueWinbackForUser(actor.userId, { force: true, clientIds });
    if (!result.ok) {
      const messages: Record<string, string> = {
        "no-settings": "Save your salon settings before queueing win-back messages.",
        "automation-disabled": "WhatsApp automation is paused in Account settings.",
        "no-template": "Add a win-back message template on the Templates tab first.",
      };
      return Response.json(
        { ok: false, error: messages[result.reason ?? ""] ?? "Could not queue win-back messages." },
        { status: 400 },
      );
    }

    return Response.json(result);
  } catch (error) {
    console.error("[whatsapp/queue-winback]", error);
    return Response.json({ ok: false, error: "Could not queue win-back messages." }, { status: 500 });
  }
}
