import { NextRequest } from "next/server";
import { resolveActor } from "@/lib/api-auth";
import { loadWhatsAppConfig } from "@/lib/whatsapp-config-server";

interface WaSenderGroup {
  jid?: unknown;
  id?: unknown;
  groupJid?: unknown;
  name?: unknown;
  subject?: unknown;
  title?: unknown;
}

export async function POST(request: NextRequest) {
  const actor = await resolveActor(request);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({})) as { apiKey?: string; inviteLink?: string };
  void body.apiKey; // ignored: the key is admin-managed and read from the server
  const apiKey = String((await loadWhatsAppConfig(actor.userId)).apiKey ?? "").trim();

  if (!apiKey) {
    return Response.json({ ok: false, error: "WhatsApp is not connected for this salon yet. Contact Salon Central support to set it up." }, { status: 400 });
  }

  try {
    if (body.inviteLink) {
      const match = body.inviteLink.trim().match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
      if (!match?.[1]) {
        return Response.json({ ok: false, error: "Enter a valid WhatsApp group invite link." }, { status: 400 });
      }
      const inviteResponse = await fetch(
        `https://www.wasenderapi.com/api/groups/invite/${encodeURIComponent(match[1])}`,
        { headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store" },
      );
      const invitePayload = await inviteResponse.json().catch(() => ({})) as {
        success?: boolean;
        data?: { id?: string; jid?: string; subject?: string; name?: string };
        message?: string;
        error?: string;
      };
      const jid = invitePayload.data?.jid || invitePayload.data?.id || "";
      if (!inviteResponse.ok || invitePayload.success === false || !jid.endsWith("@g.us")) {
        return Response.json({
          ok: false,
          error: invitePayload.message || invitePayload.error || "WaSender could not resolve this group invite link.",
        }, { status: inviteResponse.status || 502 });
      }
      return Response.json({
        ok: true,
        group: {
          jid,
          name: invitePayload.data?.subject || invitePayload.data?.name || "WhatsApp Group",
        },
      });
    }

    const response = await fetch("https://www.wasenderapi.com/api/groups?paginated=false", {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      data?: WaSenderGroup[] | { items?: WaSenderGroup[]; groups?: WaSenderGroup[] };
      message?: string;
      error?: string;
    };
    const rawGroups = Array.isArray(payload.data)
      ? payload.data
      : payload.data?.items ?? payload.data?.groups ?? [];
    const groups = rawGroups
      .map((group) => {
        const jid = [group.jid, group.groupJid, group.id].find(
          (value): value is string => typeof value === "string" && value.endsWith("@g.us"),
        );
        const name = [group.name, group.subject, group.title].find(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        );
        return jid ? { jid, name: name?.trim() || "Unnamed WhatsApp Group" } : null;
      })
      .filter((group): group is { jid: string; name: string } => group !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!response.ok || payload.success === false) {
      return Response.json({
        ok: false,
        error: payload.message || payload.error || `WaSender returned HTTP ${response.status}.`,
      }, { status: response.status || 502 });
    }

    let session: { id?: string; name?: string } | undefined;
    if (groups.length === 0) {
      const userResponse = await fetch("https://www.wasenderapi.com/api/user", {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: "no-store",
      });
      const userPayload = await userResponse.json().catch(() => ({})) as {
        data?: { id?: string; name?: string };
      };
      session = userPayload.data;
    }

    return Response.json({ ok: true, groups, session });
  } catch {
    return Response.json({ ok: false, error: "Unable to load WhatsApp groups." }, { status: 502 });
  }
}
