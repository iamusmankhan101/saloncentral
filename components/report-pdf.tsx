"use client";

import { APPOINTMENTS, REVENUE_LAST_7_DAYS, STAFF } from "@/lib/mock-data";

import { fmtCurrency as fmt } from "@/lib/format";

const TODAY = new Date().toISOString().slice(0, 10);

const STATUS_COLORS: Record<string, string> = {
  completed:     "#16a34a",
  "in-progress": "#d97706",
  arrived:       "#9333EA",
  confirmed:     "#059669",
  booked:        "#6366f1",
  "no-show":     "#dc2626",
  cancelled:     "#6b7280",
};

export function downloadPDF() {
  const todayAppts = APPOINTMENTS.filter((a) => a.date === TODAY);
  const todayRevenue = REVENUE_LAST_7_DAYS.find((r) => r.date === TODAY);
  const completedAppts = todayAppts.filter((a) => a.status === "completed");
  const totalRevenue = todayRevenue?.total ?? 0;
  const totalTips = todayRevenue?.tips ?? 0;

  const staffSummary = STAFF.map((s) => {
    const appts = todayAppts.filter((a) => a.staffId === s.id);
    const revenue = appts.reduce((sum, a) => sum + a.totalAmount, 0);
    return { name: s.name, role: s.role, appts: appts.length, revenue };
  });

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Salon Central Daily Report — ${TODAY}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Montserrat', sans-serif; background: #fff; color: #1a1a2e; font-size: 13px; }

    .page { max-width: 800px; margin: 0 auto; padding: 40px 48px; }

    /* Header */
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 2px solid #f0f0f8; }
    .logo { display: flex; align-items: center; gap: 12px; }
    .logo-icon { width: 44px; height: 44px; border-radius: 12px; background: linear-gradient(135deg, #5B21B6, #9333EA); display: flex; align-items: center; justify-content: center; color: #fff; font-size: 20px; font-weight: 800; }
    .logo-text { font-size: 22px; font-weight: 800; color: #1a1a2e; }
    .logo-sub { font-size: 12px; color: #a0a0b8; margin-top: 2px; }
    .report-meta { text-align: right; }
    .report-title { font-size: 14px; font-weight: 700; color: #7C3AED; }
    .report-date { font-size: 12px; color: #a0a0b8; margin-top: 4px; }
    .report-generated { font-size: 11px; color: #c0c0d0; margin-top: 2px; }

    /* Stat cards */
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 28px; }
    .stat-card { background: #F5F3FF; border-radius: 12px; padding: 16px; border: 1px solid #EDE9FE; }
    .stat-label { font-size: 10px; font-weight: 700; color: #a0a0b8; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px; }
    .stat-value { font-size: 18px; font-weight: 800; color: #7C3AED; }
    .stat-sub { font-size: 10px; color: #a0a0b8; margin-top: 4px; }

    /* Section */
    .section { margin-bottom: 28px; }
    .section-title { font-size: 14px; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; }
    .section-sub { font-size: 11px; color: #a0a0b8; margin-bottom: 14px; }

    /* Table */
    table { width: 100%; border-collapse: collapse; }
    thead tr { background: #F5F3FF; }
    th { font-size: 10px; font-weight: 700; color: #a0a0b8; letter-spacing: 0.07em; text-transform: uppercase; padding: 10px 14px; text-align: left; border-bottom: 1px solid #f0f0f8; }
    td { padding: 11px 14px; font-size: 12px; color: #1a1a2e; border-bottom: 1px solid #f8f8fc; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    .badge { display: inline-block; padding: 3px 9px; border-radius: 20px; font-size: 10px; font-weight: 700; }
    .amount { font-weight: 700; color: #7C3AED; }
    .staff-name { font-weight: 600; }
    .service-name { font-weight: 600; }
    .time { color: #a0a0b8; font-size: 11px; }

    /* Staff table */
    .staff-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .staff-card { border: 1px solid #f0f0f8; border-radius: 10px; padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; }
    .staff-info .name { font-weight: 700; font-size: 13px; }
    .staff-info .role { font-size: 11px; color: #a0a0b8; margin-top: 2px; text-transform: capitalize; }
    .staff-stats { text-align: right; }
    .staff-stats .rev { font-weight: 700; color: #7C3AED; font-size: 13px; }
    .staff-stats .appts { font-size: 11px; color: #a0a0b8; margin-top: 2px; }

    /* Footer */
    .footer { margin-top: 36px; padding-top: 20px; border-top: 1px solid #f0f0f8; display: flex; justify-content: space-between; align-items: center; }
    .footer-left { font-size: 11px; color: #c0c0d0; }
    .footer-right { font-size: 11px; color: #c0c0d0; }
    .total-row td { font-weight: 700; background: #F5F3FF; color: #7C3AED; }

    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .page { padding: 24px 32px; }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="logo">
      <div class="logo-icon">G</div>
      <div>
        <div class="logo-text">Salon Central</div>
        <div class="logo-sub">Amna's Salon · DHA Lahore</div>
      </div>
    </div>
    <div class="report-meta">
      <div class="report-title">Daily Performance Report</div>
      <div class="report-date">Saturday, March 21, 2026</div>
      <div class="report-generated">Generated: ${new Date().toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })}</div>
    </div>
  </div>

  <!-- Stats -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Total Revenue</div>
      <div class="stat-value">${fmt(totalRevenue)}</div>
      <div class="stat-sub">${todayAppts.length} appointments</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Completed</div>
      <div class="stat-value">${completedAppts.length}</div>
      <div class="stat-sub">of ${todayAppts.length} scheduled</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Tips Collected</div>
      <div class="stat-value">${fmt(totalTips)}</div>
      <div class="stat-sub">Today</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Avg Ticket</div>
      <div class="stat-value">${fmt(todayAppts.length ? Math.round(totalRevenue / todayAppts.length) : 0)}</div>
      <div class="stat-sub">Per appointment</div>
    </div>
  </div>

  <!-- Appointments Table -->
  <div class="section">
    <div class="section-title">Today's Appointments</div>
    <div class="section-sub">Full breakdown of all scheduled services</div>
    <table>
      <thead>
        <tr>
          <th>Client</th>
          <th>Service</th>
          <th>Stylist</th>
          <th>Time</th>
          <th>Status</th>
          <th style="text-align:right">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${todayAppts.map((a) => `
        <tr>
          <td class="staff-name">${a.clientName}</td>
          <td class="service-name">${a.serviceNames.join(", ")}</td>
          <td>${a.staffName.split(" ")[0]}</td>
          <td class="time">${a.startTime} – ${a.endTime}</td>
          <td>
            <span class="badge" style="color:${STATUS_COLORS[a.status] ?? "#6b7280"};background:${STATUS_COLORS[a.status] ?? "#6b7280"}18">
              ${a.status.charAt(0).toUpperCase() + a.status.slice(1).replace("-", " ")}
            </span>
          </td>
          <td class="amount" style="text-align:right">${fmt(a.totalAmount)}</td>
        </tr>`).join("")}
        <tr class="total-row">
          <td colspan="5">Total</td>
          <td style="text-align:right">${fmt(totalRevenue)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- Staff Summary -->
  <div class="section">
    <div class="section-title">Staff Performance</div>
    <div class="section-sub">Revenue and appointments per stylist today</div>
    <div class="staff-grid">
      ${staffSummary.map((s) => `
      <div class="staff-card">
        <div class="staff-info">
          <div class="name">${s.name}</div>
          <div class="role">${s.role.replace(/-/g, " ")}</div>
        </div>
        <div class="staff-stats">
          <div class="rev">${fmt(s.revenue)}</div>
          <div class="appts">${s.appts} appointment${s.appts !== 1 ? "s" : ""}</div>
        </div>
      </div>`).join("")}
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-left">Salon Central · Salon Management Platform</div>
    <div class="footer-right">Confidential · For internal use only</div>
  </div>

</div>
</body>
</html>`;

  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.onload = () => {
    win.focus();
    win.print();
  };
}
