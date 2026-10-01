"use client";

import { useEffect, useState } from "react";
import { MessageCircle, Star, ThumbsUp, Users } from "lucide-react";
import PageTitle from "@/components/page-title";

interface FeedbackItem {
  clientName: string;
  service: string | null;
  apptDate: string | null;
  rating: number | null;
  comment: string | null;
  requestedAt: string;
  submittedAt: string | null;
}

interface FeedbackSummary {
  requested: number;
  submitted: number;
  averageRating: number;
  responseRate: number;
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(226,223,235,0.8)", padding: "18px 20px", display: "flex", alignItems: "center", gap: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.02)", flex: 1, minWidth: 180 }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: color + "18", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color }}>{icon}</div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 850, color, lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#9898b0", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      </div>
    </div>
  );
}

function StarRow({ rating }: { rating: number | null }) {
  if (rating == null) {
    return <span style={{ fontSize: 12, fontWeight: 700, color: "#9898b0", background: "#f4f5f7", padding: "3px 10px", borderRadius: 20 }}>Awaiting response</span>;
  }
  return (
    <span style={{ display: "inline-flex", gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} size={15} fill={rating >= n ? "#f59e0b" : "none"} color={rating >= n ? "#f59e0b" : "#d0d0e0"} />
      ))}
    </span>
  );
}

export default function FeedbackPage() {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [summary, setSummary] = useState<FeedbackSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/feedback")
      .then((r) => r.json())
      .then((data: { ok: boolean; items?: FeedbackItem[]; summary?: FeedbackSummary }) => {
        if (data.ok) {
          setItems(data.items ?? []);
          setSummary(data.summary ?? null);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="dash-page dashboard-polish" style={{ minHeight: "100vh", background: "#ffffff", padding: "28px 32px 48px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageTitle icon={<Star size={24} />} title="Client Feedback" subtitle="Ratings and reviews collected after visits" />

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <StatCard icon={<Star size={20} />} label="Average Rating" value={summary && summary.submitted > 0 ? summary.averageRating.toFixed(1) : "—"} color="#f59e0b" />
        <StatCard icon={<ThumbsUp size={20} />} label="Reviews Collected" value={String(summary?.submitted ?? 0)} color="#059669" />
        <StatCard icon={<Users size={20} />} label="Requests Sent" value={String(summary?.requested ?? 0)} color="#7C3AED" />
        <StatCard icon={<MessageCircle size={20} />} label="Response Rate" value={`${summary?.responseRate ?? 0}%`} color="#0284c7" />
      </div>

      <div style={{ background: "#fff", border: "1px solid rgba(226,223,235,0.8)", borderRadius: 16, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "#9898b0", fontSize: 13 }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "#9898b0", fontSize: 13 }}>
            No feedback requests yet. Feedback links are sent automatically inside the follow-up WhatsApp message once an appointment is marked completed.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#9898b0", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th style={{ padding: "14px 20px" }}>Client</th>
                <th style={{ padding: "14px 20px" }}>Service</th>
                <th style={{ padding: "14px 20px" }}>Visit Date</th>
                <th style={{ padding: "14px 20px" }}>Rating</th>
                <th style={{ padding: "14px 20px" }}>Comment</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} style={{ borderTop: "1px solid #f0eff5" }}>
                  <td style={{ padding: "14px 20px", fontWeight: 700, color: "#1a1a2e" }}>{item.clientName || "—"}</td>
                  <td style={{ padding: "14px 20px", color: "#6b6b8a" }}>{item.service || "—"}</td>
                  <td style={{ padding: "14px 20px", color: "#6b6b8a" }}>{item.apptDate || "—"}</td>
                  <td style={{ padding: "14px 20px" }}><StarRow rating={item.rating} /></td>
                  <td style={{ padding: "14px 20px", color: "#6b6b8a", maxWidth: 320 }}>{item.comment || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
