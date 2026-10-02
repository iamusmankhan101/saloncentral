import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/api-auth";
import { loadWhatsAppConfig } from "@/lib/whatsapp-config-server";

interface WaSenderContact {
  jid?: unknown;
  id?: unknown;
  phone?: unknown;
  number?: unknown;
  name?: unknown;
  notify?: unknown;
  pushname?: unknown;
  verifiedName?: unknown;
}

export async function POST(request: NextRequest) {
  const actor = await resolveActor(request);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({})) as { apiKey?: string };
  void body.apiKey; // ignored: the key is admin-managed and read from the server
  const apiKey = String((await loadWhatsAppConfig(actor.userId)).apiKey ?? "").trim();

  if (!apiKey) {
    return Response.json({ ok: false, error: "WhatsApp is not connected for this salon yet. Contact Salon Central support to set it up." }, { status: 400 });
  }

  try {
    const response = await fetch("https://www.wasenderapi.com/api/contacts", {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      data?: WaSenderContact[] | { items?: WaSenderContact[]; contacts?: WaSenderContact[] };
      message?: string;
      error?: string;
    };

    if (!response.ok || payload.success === false) {
      return Response.json({
        ok: false,
        error: payload.message || payload.error || `WaSender returned HTTP ${response.status}.`,
      }, { status: response.status || 502 });
    }

    const rawContacts = Array.isArray(payload.data)
      ? payload.data
      : payload.data?.items ?? payload.data?.contacts ?? [];

    const contacts = rawContacts
      .map((contact) => {
        const jid = [contact.jid, contact.id].find(
          (value): value is string => typeof value === "string" && value.endsWith("@s.whatsapp.net"),
        );
        const phone = [contact.phone, contact.number].find(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        ) ?? jid?.split("@")[0];
        const name = [contact.name, contact.notify, contact.pushname, contact.verifiedName].find(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        );
        return phone ? { phone: phone.trim(), name: name?.trim() || phone.trim(), jid: jid ?? "" } : null;
      })
      .filter((contact): contact is { phone: string; name: string; jid: string } => contact !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    let session: { id?: string; name?: string } | undefined;
    if (contacts.length === 0) {
      const userResponse = await fetch("https://www.wasenderapi.com/api/user", {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: "no-store",
      });
      const userPayload = await userResponse.json().catch(() => ({})) as {
        data?: { id?: string; name?: string };
      };
      session = userPayload.data;
    }

    return Response.json({ ok: true, contacts, session });
  } catch {
    return Response.json({ ok: false, error: "Unable to load WhatsApp contacts." }, { status: 502 });
  }
}
