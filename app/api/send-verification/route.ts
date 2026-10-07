import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { randomBytes } from "crypto";
import { Resend } from "resend";
import { clientIp, rateLimit } from "@/lib/rate-limit";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function ensureTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);
}

export async function POST(req: NextRequest) {
  // No session exists yet at signup, so this stays public — cap how often one
  // IP can make us send mail.
  const limit = await rateLimit("send-verification", clientIp(req), { maxAttempts: 5, windowMs: 60 * 60 * 1000, blockMs: 60 * 60 * 1000 });
  if (limit.blocked) {
    return Response.json({ ok: false, error: "Too many requests. Please try again later." }, { status: 429 });
  }

  let email: string, name: string;
  try {
    const body = await req.json() as { email: string; name: string };
    email = body.email;
    name  = body.name;
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  if (!email) return Response.json({ ok: false, error: "Missing email." }, { status: 400 });

  // ── Store verification token in Turso ─────────────────────────────────────
  let token: string;
  let verifyUrl: string;
  try {
    await ensureTable();

    token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await db.execute({
      sql: "INSERT OR REPLACE INTO email_verification_tokens (token, email, expires_at) VALUES (?, ?, ?)",
      args: [token, email.trim().toLowerCase(), expiresAt],
    });

    // Use NEXT_PUBLIC_APP_URL if set (for production/deployed envs), else fall back
    // to the request origin (works in dev at localhost)
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
      req.nextUrl.origin;
    verifyUrl = `${baseUrl}/verify-email?token=${token}`;
  } catch (dbErr) {
    console.error("[send-verification] DB error:", dbErr);
    return Response.json({ ok: false, error: "Failed to create verification token. Please try again." }, { status: 500 });
  }

  // ── No API key → dev mode: return the URL for manual testing ──────────────
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Handing the link straight back would let anyone verify any address, so
    // this shortcut is local-development only.
    if (process.env.NODE_ENV === "production") {
      console.error("[send-verification] RESEND_API_KEY not set in production.");
      return Response.json({ ok: false, error: "Email is not configured." }, { status: 500 });
    }
    console.warn("[send-verification] RESEND_API_KEY not set. Returning dev URL.");
    return Response.json({ ok: true, devUrl: verifyUrl });
  }

  // ── Send email via Resend ─────────────────────────────────────────────────
  const resend = new Resend(apiKey);

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e8e8f0;box-shadow:0 4px 20px rgba(0,0,0,0.06)">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#5B21B6 0%,#9333EA 100%);padding:32px 36px">
      <div style="color:#ffffff;font-size:24px;font-weight:900;letter-spacing:-0.5px">Salon Central</div>
      <div style="color:rgba(255,255,255,0.75);font-size:12px;margin-top:4px">Salon Management Platform</div>
    </div>

    <!-- Body -->
    <div style="padding:36px">
      <div style="font-size:20px;font-weight:800;color:#1a1a2e;margin-bottom:10px">Verify your email address</div>
      <p style="color:#6b6b8a;font-size:14px;line-height:1.75;margin:0 0 28px">
        Hi ${escapeHtml(name || "there")},<br>
        Thanks for signing up for <strong style="color:#7C3AED">Salon Central</strong>!
        Click the button below to verify your email address and activate your account.
      </p>

      <!-- CTA button -->
      <table role="presentation" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <td style="border-radius:10px;background:linear-gradient(135deg,#5B21B6,#9333EA)">
            <a href="${verifyUrl}"
               target="_blank"
               style="display:inline-block;padding:15px 32px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:10px;letter-spacing:0.01em">
              ✓ Verify my email
            </a>
          </td>
        </tr>
      </table>

      <p style="color:#9898b0;font-size:12px;margin-top:28px;line-height:1.65">
        This link expires in <strong>24 hours</strong>.
        If you didn't create a Salon Central account, you can safely ignore this email.
      </p>

      <!-- Fallback URL -->
      <div style="margin-top:20px;padding:14px 16px;background:#f8f8fc;border-radius:9px;border:1px solid #ebebf0">
        <div style="font-size:10px;font-weight:700;color:#b0b0c8;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px">
          Button not working? Copy this link:
        </div>
        <div style="font-size:11px;color:#7C3AED;word-break:break-all">${verifyUrl}</div>
      </div>
    </div>

    <!-- Footer -->
    <div style="background:#f8f8fc;padding:16px 36px;border-top:1px solid #ebebf0;text-align:center;color:#b0b0c8;font-size:11px;line-height:1.6">
      Salon Central · Salon Management Platform<br>
      You're receiving this because you signed up at saloncentral.xyz
    </div>
  </div>
</body>
</html>`;

  try {
    const { data, error } = await resend.emails.send({
      from: "Salon Central <noreply@saloncentral.xyz>",
      replyTo: "support@saloncentral.xyz",
      to: [email],
      subject: "Verify your Salon Central account ✓",
      html,
      // Plain-text fallback for spam filters that inspect text/plain
      text: `Hi ${name || "there"},\n\nThanks for signing up for Salon Central!\n\nVerify your email by visiting this link:\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you didn't create a Salon Central account, ignore this email.\n\n— The Salon Central Team`,
    });

    if (error) {
      console.error("[send-verification] Resend error:", error);
      return Response.json({ ok: false, error: `Email delivery failed: ${error.message}` }, { status: 500 });
    }

    console.log(`[send-verification] ✓ Sent (id=${data?.id}) → ${email}`);
    return Response.json({ ok: true });
  } catch (sendErr) {
    console.error("[send-verification] Unexpected Resend error:", sendErr);
    return Response.json({
      ok: false,
      error: "Failed to send verification email. Please try again in a moment.",
    }, { status: 500 });
  }
}