/**
 * /api/billing/billed-from
 * The "Billed From" block printed on every salon's invoice. GET returns the
 * saved details (admin panel form); PUT replaces them. Admin-only — salons get
 * these alongside their own billing info from /api/billing/user.
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { getBilledFrom, setBilledFrom } from "@/lib/billing-db";
import type { BilledFrom } from "@/lib/billing-constants";

export async function GET(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 403 });
  }
  try {
    return Response.json({ ok: true, billedFrom: await getBilledFrom() });
  } catch (err) {
    console.error("[billing/billed-from] GET error:", err);
    return Response.json({ ok: false, error: "Failed to load invoice details." }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 403 });
  }
  let body: Partial<BilledFrom>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  if (!body.name?.trim()) {
    return Response.json({ ok: false, error: "Business name is required." }, { status: 400 });
  }
  try {
    const billedFrom = await setBilledFrom({
      name: body.name, tagline: body.tagline ?? "", phone: body.phone ?? "",
      email: body.email ?? "", address: body.address ?? "",
    });
    return Response.json({ ok: true, billedFrom });
  } catch (err) {
    console.error("[billing/billed-from] PUT error:", err);
    return Response.json({ ok: false, error: "Failed to save invoice details." }, { status: 500 });
  }
}
