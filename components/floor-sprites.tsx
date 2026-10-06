/**
 * Isometric drawing pieces for the Salon Floor page — plain SVG, no 3D library,
 * so the board stays smooth on the cheap tablets salons keep at reception.
 */

export const U = 34; // pixels per floor unit
const COS = 0.866;

export function iso(x: number, y: number, z = 0): [number, number] {
  return [(x - y) * U * COS, (x + y) * U * 0.5 - z * U];
}
export const pts = (list: [number, number, number][]) => list.map(([x, y, z]) => iso(x, y, z).join(",")).join(" ");

export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const f = (c: number) => Math.round(c * (1 - amount));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** A solid box: top plus the two faces turned towards the viewer. */
export function Box({ x, y, z = 0, w, d, h, color }: { x: number; y: number; z?: number; w: number; d: number; h: number; color: string }) {
  const t = z + h;
  return (
    <g>
      <polygon points={pts([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, t], [x + w, y, t]])} fill={shade(color, 0.14)} />
      <polygon points={pts([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, t], [x, y + d, t]])} fill={shade(color, 0.28)} />
      <polygon points={pts([[x, y, t], [x + w, y, t], [x + w, y + d, t], [x, y + d, t]])} fill={color} />
    </g>
  );
}

const HAIR = ["#3b2f2f", "#1f1a17", "#6b4226", "#a0522d", "#2d2420"];
const SKIN = ["#f2c9a5", "#e0ac83", "#c68863", "#f5d0b5"];

/** Stable per-person look so the same client always appears the same. */
export function lookFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return { hair: HAIR[h % HAIR.length], skin: SKIN[(h >> 3) % SKIN.length] };
}

/**
 * A figure. `walk` and `work` are animation phases in seconds; while walking
 * the legs swing and the body bobs, while working the arm snips.
 */
export function Person({ x, y, z, color, id, tall = false, walking = false, working = false, seated = false, t, selected = false }: {
  x: number; y: number; z: number; color: string; id: string; tall?: boolean;
  walking?: boolean; working?: boolean; seated?: boolean; t: number; selected?: boolean;
}) {
  const [cx, base] = iso(x, y, z);
  const { hair, skin } = lookFor(id);
  const phase = t * 11 + id.length;
  const bob = walking ? Math.abs(Math.sin(phase)) * 2.5 : Math.sin(t * 2 + id.length) * 0.6;
  const cy = base - bob;
  const body = seated ? 16 : tall ? 26 : 22;
  const legs = seated ? 0 : 9;
  const swing = walking ? Math.sin(phase) * 4 : 0;
  const top = cy - legs - body;
  const arm = working ? Math.sin(t * 9) * 25 - 35 : walking ? -Math.sin(phase) * 20 : 0;
  return (
    <g>
      <ellipse cx={cx} cy={base} rx={10} ry={4.5} fill="rgba(30,27,75,0.14)" />
      {selected && <ellipse cx={cx} cy={base} rx={15} ry={7} fill="none" stroke="#7C3AED" strokeWidth={2} />}
      {legs > 0 && <>
        <rect x={cx - 5 + swing} y={cy - legs} width={4} height={legs} rx={2} fill={shade(color, 0.45)} />
        <rect x={cx + 1 - swing} y={cy - legs} width={4} height={legs} rx={2} fill={shade(color, 0.45)} />
      </>}
      <rect x={cx - 8} y={top} width={16} height={body} rx={7} fill={color} />
      <g transform={`rotate(${arm} ${cx + 7} ${top + 4})`}>
        <rect x={cx + 5} y={top + 3} width={4} height={13} rx={2} fill={shade(color, 0.12)} />
        {working && <text x={cx + 7} y={top + 22} fontSize={9} textAnchor="middle">✂️</text>}
      </g>
      <circle cx={cx} cy={top - 7} r={7.5} fill={skin} />
      <path d={`M${cx - 7.8} ${top - 7} a7.8 7.8 0 0 1 15.6 0 q-7.8 -3 -15.6 0 z`} fill={hair} />
    </g>
  );
}

export function Tag({ x, y, z, text, tone }: { x: number; y: number; z: number; text: string; tone: "busy" | "free" | "info" | "warn" }) {
  const [cx, cy] = iso(x, y, z);
  const width = Math.max(44, text.length * 6.4 + 16);
  const bg = tone === "busy" ? "#7C3AED" : tone === "free" ? "#ffffff" : tone === "warn" ? "#f59e0b" : "#1e1b4b";
  const fg = tone === "free" ? "#059669" : "#ffffff";
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect x={cx - width / 2} y={cy - 11} width={width} height={20} rx={10} fill={bg} stroke={tone === "free" ? "#d1fae5" : "none"} />
      <text x={cx} y={cy + 3} textAnchor="middle" fontSize={10.5} fontWeight={700} fill={fg}>{text}</text>
    </g>
  );
}

/** Circular progress drawn flat on the floor under a busy chair. */
export function FloorRing({ x, y, pct }: { x: number; y: number; pct: number }) {
  const [cx, cy] = iso(x, y);
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <g transform={`translate(${cx} ${cy}) scale(1 0.5)`} style={{ pointerEvents: "none" }}>
      <circle r={r} fill="rgba(124,58,237,0.08)" stroke="#ede9fe" strokeWidth={5} />
      <circle r={r} fill="none" stroke="#7C3AED" strokeWidth={5} strokeLinecap="round"
        strokeDasharray={`${(c * Math.min(100, Math.max(0, pct))) / 100} ${c}`} transform="rotate(-90)" />
    </g>
  );
}
