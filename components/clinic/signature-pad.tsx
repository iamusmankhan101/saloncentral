"use client";

import { useEffect, useRef } from "react";

/** Finger / stylus / mouse signature on a canvas. */
export default function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const drew = useRef(false);

  useEffect(() => {
    const canvas = ref.current!;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1a1a2e";
  }, []);

  const point = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const clear = () => {
    const c = ref.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    drew.current = false;
    onChange(null);
  };

  return (
    <div>
      <canvas ref={ref} aria-label="Signature pad"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const ctx = ref.current!.getContext("2d")!; ctx.beginPath(); ctx.moveTo(...point(e)); }}
        onPointerMove={(e) => { if (!drawing.current) return; const ctx = ref.current!.getContext("2d")!; ctx.lineTo(...point(e)); ctx.stroke(); drew.current = true; }}
        onPointerUp={() => { drawing.current = false; if (drew.current) onChange(ref.current!.toDataURL("image/png")); }}
        style={{ width: "100%", height: 160, border: "1.5px dashed #c4b5fd", borderRadius: 12, background: "#fcfbff", touchAction: "none", display: "block", cursor: "crosshair" }} />
      <button type="button" onClick={clear} style={{ border: "1px solid #e4e4ee", background: "#fff", color: "#6b6b8a", borderRadius: 9, cursor: "pointer", fontWeight: 800, padding: "5px 10px", fontSize: 11.5, marginTop: 6 }}>Clear signature</button>
    </div>
  );
}

