import { NextRequest, NextResponse } from "next/server";

const submittedEmails = new Set<string>();

export async function POST(req: NextRequest) {
  const body = await req.json();
  // Cap lengths: these go straight into a sheet and a WhatsApp message.
  const [name, email, phone] = [body.name, body.email, body.phone].map((v) => String(v ?? "").trim().slice(0, 200));
  const datetime = String(body.datetime || "Not specified").slice(0, 100);

  if (!name || !email || !phone) {
    return NextResponse.json({ error: "Name, email, and phone are required." }, { status: 400 });
  }

  const normalizedEmail = email.toLowerCase().trim();
  if (submittedEmails.has(normalizedEmail)) {
    return NextResponse.json(
      { error: "This email has already been registered. We'll be in touch soon!" },
      { status: 409 }
    );
  }

  const submittedAt = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });

  // ── 1. Save to Google Sheets via Apps Script ───────────────
  try {
    await fetch(process.env.GOOGLE_SCRIPT_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, phone, datetime, submittedAt }),
    });
  } catch (err) {
    console.error("Google Sheets error:", err);
  }

  // ── 2. Alert the team on WhatsApp (WaSender, same provider as the main app) ──
  try {
    const res = await fetch("https://www.wasenderapi.com/api/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WASENDER_API_KEY}` },
      body: JSON.stringify({
        to: process.env.DEMO_WHATSAPP_TO,
        text: [
          "🎉 *New Demo Request*",
          "",
          `*Name:* ${name}`,
          `*Phone:* ${phone}`,
          `*Email:* ${email}`,
          `*Preferred time:* ${datetime}`,
          `*Submitted:* ${submittedAt}`,
        ].join("\n"),
      }),
    });
    if (!res.ok) console.error("WhatsApp demo alert failed:", res.status, await res.text());
  } catch (err) {
    console.error("WhatsApp demo alert error:", err);
  }

  submittedEmails.add(normalizedEmail);
  return NextResponse.json({ success: true });
}
