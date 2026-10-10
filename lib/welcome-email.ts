/**
 * "Your Salon Central account is ready" email, sent to a salon owner once their
 * account exists. Same look as the daily report email (logo bar + purple band).
 * It never carries a password: the owner signs in with the one they chose (or Google).
 */

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://app.saloncentral.xyz").replace(/\/$/, "");
const SUPPORT_WHATSAPP = "923029646928";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Names are optional: without them it greets "Hi there" and leaves the salon name out. */
export function buildWelcomeEmail({ ownerName = "", salonName = "", email }: { ownerName?: string; salonName?: string; email: string }) {
  const h = { salon: escapeHtml(salonName.trim()), email: escapeHtml(email) };
  const signInUrl = `${APP_URL}/sign-in`;
  const firstName = escapeHtml(ownerName.trim().split(/\s+/)[0] || "there");

  const steps = [
    ["Add your services & prices", "Open Services in the sidebar. They show up in bookings and the POS."],
    ["Add your team", "Open Staff in the sidebar, so bookings and sales are tracked per person."],
    ["Ring up your first sale", "Open the POS — every sale lands in your revenue and ledger automatically."],
    ["Connect WhatsApp", "Open WhatsApp in the sidebar to send clients booking confirmations and reminders automatically."],
  ];

  const subject = salonName.trim()
    ? `Welcome to Salon Central — your account for ${salonName.trim()} is ready`
    : "Welcome to Salon Central — your account is ready";

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e8e8f0">

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #ece9f5">
      <tr>
        <td style="padding:20px 36px">
          <img src="${APP_URL}/report-logo.png" alt="Salon Central" width="74" height="36" style="display:block;border:0;color:#7C3AED;font-size:18px;font-weight:900">
        </td>
        <td style="padding:20px 36px;text-align:right">
          <span style="display:inline-block;background:#ECFDF5;color:#047857;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;padding:5px 10px;border-radius:999px">Account ready</span>
        </td>
      </tr>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#5B21B6;background-image:linear-gradient(135deg,#4C1D95,#8B5CF6)">
      <tr>
        <td style="padding:32px 36px">
          <div style="color:rgba(255,255,255,0.75);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em">Welcome to Salon Central</div>
          <div style="color:#fff;font-size:26px;font-weight:800;margin-top:6px;line-height:1.25">Hi ${firstName}, your salon is all set up 🎉</div>
          <div style="color:rgba(255,255,255,0.85);font-size:14px;margin-top:8px;line-height:1.5">${h.salon ? `Your account for <strong style="color:#fff">${h.salon}</strong> is` : "Your Salon Central account is"} created and ready to use.</div>
        </td>
      </tr>
    </table>

    <div style="padding:30px 36px">
      <div style="background:#F5F3FF;border:1px solid #EDE9FE;border-radius:12px;padding:18px 20px">
        <div style="font-size:11px;font-weight:700;color:#8e89a3;text-transform:uppercase;letter-spacing:0.08em">Sign in with</div>
        <div style="font-size:16px;font-weight:800;color:#1a1a2e;margin-top:6px">${h.email}</div>
        <div style="font-size:12.5px;color:#6b6b8a;margin-top:6px;line-height:1.55">Use the password you chose when you signed up, or <strong>Continue with Google</strong> if you joined with Google.</div>
      </div>

      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto 6px">
        <tr><td style="border-radius:12px;background:#7C3AED">
          <a href="${signInUrl}" style="display:inline-block;padding:14px 34px;color:#fff;font-size:15px;font-weight:800;text-decoration:none;border-radius:12px">Sign in to Salon Central →</a>
        </td></tr>
      </table>
      <div style="text-align:center;font-size:11.5px;color:#9898b0">${signInUrl.replace(/^https?:\/\//, "")}</div>

      <div style="font-size:15px;font-weight:800;color:#1a1a2e;margin:30px 0 12px">Get started in 4 steps</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${steps.map(([title, body], i) => `
        <tr>
          <td style="width:40px;vertical-align:top;padding:0 0 14px">
            <div style="width:28px;height:28px;border-radius:50%;background:#EDE9FE;color:#6D28D9;font-size:13px;font-weight:800;text-align:center;line-height:28px">${i + 1}</div>
          </td>
          <td style="vertical-align:top;padding:2px 0 14px">
            <div style="font-size:14px;font-weight:700;color:#1a1a2e">${title}</div>
            <div style="font-size:12.5px;color:#6b6b8a;margin-top:2px;line-height:1.5">${body}</div>
          </td>
        </tr>`).join("")}
      </table>

      <div style="margin-top:14px;padding:16px 18px;border-radius:12px;border:1px solid #e8e8f0;font-size:13px;color:#4a4a6a;line-height:1.6">
        Need a hand setting up? Message us on
        <a href="https://wa.me/${SUPPORT_WHATSAPP}" style="color:#059669;font-weight:700;text-decoration:none">WhatsApp</a>
        or reply to this email — we're happy to help.
      </div>
    </div>

    <div style="padding:18px 36px;background:#faf9fd;border-top:1px solid #f0f0f8;text-align:center;font-size:11px;color:#a0a0b8;line-height:1.6">
      Salon Central · Salon Management Platform · <a href="https://saloncentral.xyz" style="color:#7C3AED;text-decoration:none">saloncentral.xyz</a><br>
      You're receiving this because an account was created for ${h.email}.
    </div>
  </div>
</body>
</html>`;

  const text =
    `Hi ${ownerName.trim().split(/\s+/)[0] || "there"},\n\nYour Salon Central account${salonName.trim() ? ` for ${salonName.trim()}` : ""} is ready.\n\n` +
    `Sign in: ${signInUrl}\nEmail: ${email}\nUse the password you chose when you signed up, or Continue with Google.\n\n` +
    `Get started:\n${steps.map(([t, b], i) => `${i + 1}. ${t} — ${b}`).join("\n")}\n\n` +
    `Need help? WhatsApp us: https://wa.me/${SUPPORT_WHATSAPP} or reply to this email.\n\n— Salon Central`;

  return { subject, html, text };
}
