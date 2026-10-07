"use client";

/**
 * The 3D scene behind the Salon Floor page: the salon (roof cut away) on its
 * street, with stylists and clients walking between the door, the waiting
 * sofa and the chairs. The page decides *where* each person should be (the
 * roster); this component owns *how they get there* — paths, walking,
 * sitting — plus the camera, labels and ambient life (traffic).
 */

import { useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export const ACCENT = "#2f6bff";

/** chair = in the seat, station = standing beside that chair (stylists), sofa / spare = waiting spots. */
export type Spot = { type: "chair" | "station" | "sofa" | "spare"; index: number };
export interface RosterPerson {
  id: string;
  kind: "client" | "staff";
  color: string;
  spot: Spot;
  /** Stylist with a client in their chair — plays the cutting animation. */
  working?: boolean;
  /** Name tag floating over the head (stylists: "Saba · Idle" / "Saba · Working"). */
  label?: { text: string; busy: boolean };
  /** Emoji shown over the head until this time (ms). */
  bubble?: { text: string; until: number };
}
export interface ChairLabel { text: string; tone: "busy" | "free" | "warn"; progress: number | null }
export interface FloorApi {
  zoom(factor: number): void;
  rotate(dir: 1 | -1): void;
  home(): void;
  focusChair(index: number): void;
  focusPerson(id: string): void;
}

interface Props {
  chairCount: number;
  salonName: string;
  night: boolean;
  roster: RosterPerson[];
  chairLabels: ChairLabel[];
  receptionLabel: string;
  waitingLabel: string;
  selectedChair: number | null;
  onSelectChair: (index: number | null) => void;
  pops: { id: number; text: string }[];
  apiRef: MutableRefObject<FloorApi | null>;
}

// ── Layout (metres; x → right, z → towards the street, y up) ──────────────────

const PER_ROW = 6;
const COL = 2.4;
const ROW = 3.2;
const CORRIDOR_X = 0.9;
const WALK = 1.7; // m/s

function layoutFor(chairCount: number) {
  const rows = Math.ceil(chairCount / PER_ROW);
  const cols = Math.min(chairCount, PER_ROW);
  const W = Math.max(14, cols * COL + 6);
  const aisles = Array.from({ length: rows }, (_, r) => 0.35 + r * ROW + 2.6);
  const frontAisle = aisles[aisles.length - 1];
  const D = frontAisle + 4.8;
  const doorX = W / 2;
  const station = (i: number) => ({ x: 2.4 + (i % PER_ROW) * COL, z: 0.35 + Math.floor(i / PER_ROW) * ROW });
  const seat = (i: number) => { const s = station(i); return { x: s.x, z: s.z + 1.3, y: 0.56 }; };
  const stylist = (i: number) => { const s = station(i); return { x: s.x + 0.85, z: s.z + 1.75, y: 0 }; };
  const sofa = (k: number) => k < 4 ? { x: W - 5.1 + k * 0.95, z: D - 1.5, y: 0.46 } : { x: W - 5.3 + (k - 4) * 0.8, z: D - 2.9, y: 0 };
  const spare = (j: number) => ({ x: W - 1.5, z: 1.2 + (j % 6) * 0.8, y: 0 });
  return { rows, W, D, aisles, frontAisle, doorX, station, seat, stylist, sofa, spare, desk: { x: 1.0, z: D - 3.4 } };
}
type Layout = ReturnType<typeof layoutFor>;

function spotPos(spot: Spot, L: Layout) {
  return spot.type === "chair" ? L.seat(spot.index) : spot.type === "station" ? L.stylist(spot.index) : spot.type === "sofa" ? L.sofa(spot.index) : L.spare(spot.index);
}

type P = { x: number; z: number };
const aisleFor = (z: number, L: Layout) => L.aisles.find((a) => z <= a + 0.01) ?? L.frontAisle;

function insidePath(from: P, to: P, L: Layout): P[] {
  const a1 = aisleFor(from.z, L), a2 = aisleFor(to.z, L);
  return a1 === a2
    ? [{ x: from.x, z: a1 }, { x: to.x, z: a1 }, to]
    : [{ x: from.x, z: a1 }, { x: CORRIDOR_X, z: a1 }, { x: CORRIDOR_X, z: a2 }, { x: to.x, z: a2 }, to];
}

/** Through the front door whenever one end is out on the street. */
function route(from: P, to: P, L: Layout): P[] {
  const doorIn = { x: L.doorX, z: L.D - 0.6 }, doorOut = { x: L.doorX, z: L.D + 1.6 };
  const outside = (p: P) => p.z > L.D;
  let steps: P[];
  if (outside(from) && outside(to)) steps = [to];
  else if (outside(from)) steps = [doorOut, doorIn, ...insidePath(doorIn, to, L)];
  else if (outside(to)) steps = [...insidePath(from, doorIn, L), doorIn, doorOut, to];
  else steps = insidePath(from, to, L);
  return steps.filter((p, i) => i === steps.length - 1 || Math.hypot(p.x - from.x, p.z - from.z) > 0.05);
}

// ── Builders ──────────────────────────────────────────────────────────────────

const mat = (color: string, opts: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, ...opts });

function mesh(geo: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}
const rbox = (w: number, h: number, d: number, r = 0.04) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2));

function hashOf(id: string) { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h; }
const HAIR = ["#2b2220", "#1b1716", "#5b3a26", "#8a5a3c", "#3a2c28"];
const SKIN = ["#f1c7a3", "#ddb08a", "#c08765", "#f4d2b8"];

interface PersonRig { group: THREE.Group; legL: THREE.Object3D; legR: THREE.Object3D; arm: THREE.Object3D; bodyMat: THREE.MeshStandardMaterial }

function makePerson(id: string, color: string, tall: boolean): PersonRig {
  const h = hashOf(id);
  const group = new THREE.Group();
  const bodyMat = mat(color);
  const legMat = mat("#334155");
  const skin = mat(SKIN[(h >> 3) % SKIN.length]);
  const hipY = tall ? 0.82 : 0.76;
  const leg = () => {
    const pivot = new THREE.Group();
    pivot.position.y = hipY;
    pivot.add(mesh(new THREE.CapsuleGeometry(0.075, hipY - 0.15, 4, 8), legMat, 0, -hipY / 2, 0));
    return pivot;
  };
  const legL = leg(); legL.position.x = -0.1;
  const legR = leg(); legR.position.x = 0.1;
  const torso = mesh(new THREE.CapsuleGeometry(0.2, 0.42, 6, 12), bodyMat, 0, hipY + 0.3, 0);
  const head = mesh(new THREE.SphereGeometry(0.16, 20, 16), skin, 0, hipY + 0.78, 0);
  const hair = mesh(new THREE.SphereGeometry(0.17, 20, 12, 0, Math.PI * 2, 0, Math.PI / 1.9), mat(HAIR[h % HAIR.length]), 0, hipY + 0.8, -0.01);
  const arm = new THREE.Group();
  arm.position.set(0.24, hipY + 0.5, 0);
  arm.add(mesh(new THREE.CapsuleGeometry(0.06, 0.38, 4, 8), bodyMat, 0, -0.22, 0));
  const armL = mesh(new THREE.CapsuleGeometry(0.06, 0.38, 4, 8), bodyMat, -0.24, hipY + 0.28, 0);
  group.add(legL, legR, torso, head, hair, arm, armL);
  return { group, legL, legR, arm, bodyMat };
}

function makeChair(): { group: THREE.Group; seatMat: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const chrome = mat("#c3cad8", { metalness: 0.6, roughness: 0.3 });
  const seatMat = mat("#c9d2e8", { roughness: 0.5 });
  g.add(mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.05, 28), chrome, 0, 0.025, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.36, 12), chrome, 0, 0.23, 0));
  g.add(mesh(rbox(0.62, 0.16, 0.6, 0.06), seatMat, 0, 0.48, 0));
  g.add(mesh(rbox(0.62, 0.72, 0.14, 0.06), seatMat, 0, 0.92, 0.3));
  g.add(mesh(rbox(0.08, 0.08, 0.5, 0.03), seatMat, -0.33, 0.66, 0.02));
  g.add(mesh(rbox(0.08, 0.08, 0.5, 0.03), seatMat, 0.33, 0.66, 0.02));
  g.add(mesh(rbox(0.4, 0.04, 0.16, 0.02), chrome, 0, 0.2, -0.42));
  return { group: g, seatMat };
}

function makeCar(color: string) {
  const g = new THREE.Group();
  g.add(mesh(rbox(2.3, 0.55, 1.05, 0.18), mat(color, { roughness: 0.35 }), 0, 0.45, 0));
  g.add(mesh(rbox(1.25, 0.45, 0.95, 0.16), mat("#dbe4f5", { roughness: 0.15, metalness: 0.3 }), -0.1, 0.9, 0));
  const tyre = mat("#1f2937");
  for (const [x, z] of [[-0.75, 0.5], [0.75, 0.5], [-0.75, -0.5], [0.75, -0.5]]) {
    const w = mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 16), tyre, x, 0.22, z);
    w.rotation.x = Math.PI / 2;
    g.add(w);
  }
  return g;
}

function makeTree(scale = 1) {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.1, 8), mat("#a8a29e"), 0, 0.55, 0));
  g.add(mesh(new THREE.IcosahedronGeometry(0.75, 2), mat("#8fd3a0", { roughness: 0.9 }), 0, 1.6, 0));
  g.scale.setScalar(scale);
  return g;
}

function textTexture(text: string, color: string) {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 160;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = color;
  const label = text.toUpperCase().slice(0, 32);
  let size = 84;
  ctx.font = `800 ${size}px -apple-system, Segoe UI, Helvetica, Arial, sans-serif`;
  while (ctx.measureText(label).width > c.width - 60 && size > 30) ctx.font = `800 ${--size}px -apple-system, Segoe UI, Helvetica, Arial, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(label, c.width / 2, c.height / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function tileTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#f7f8fc"; ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = "#e6e9f3"; ctx.lineWidth = 2; ctx.strokeRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function chip(className: string) {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Ent {
  id: string;
  rig: PersonRig;
  kind: RosterPerson["kind"];
  x: number; z: number; heading: number;
  path: P[];
  goal: { x: number; z: number; y: number };
  spot: Spot | null;
  leaving: boolean;
  working: boolean;
  bubble?: CSS2DObject;
  tag?: HTMLDivElement;
}

export default function SalonFloor3D(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const syncRoster = useRef<() => void>(() => {});
  const syncPops = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current!;
    const L = layoutFor(props.chairCount);
    const { W, D } = L;
    const center = new THREE.Vector3(W / 2, 0, D / 2 + 1);

    // Renderer, scene, camera
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.style.position = "absolute";
    labels.domElement.style.inset = "0";
    labels.domElement.style.pointerEvents = "none";
    host.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    const night = props.night;
    const bg = new THREE.Color(night ? "#1c2340" : "#eef1f8");
    scene.background = bg;
    scene.fog = new THREE.Fog(bg, 70, 150);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);
    const HOME = { radius: Math.max(30, W * 1.85), theta: 0.62, phi: 0.88 };
    const spherical = new THREE.Spherical(HOME.radius, HOME.phi, HOME.theta);
    camera.position.copy(center).add(new THREE.Vector3().setFromSpherical(spherical));
    camera.lookAt(center);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;
    controls.minDistance = 10;
    controls.maxDistance = 90;
    controls.minPolarAngle = 0.35;
    controls.maxPolarAngle = 1.25;
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

    // Light
    scene.add(new THREE.HemisphereLight("#ffffff", night ? "#2a3156" : "#dfe4f2", night ? 0.55 : 1.25));
    const sun = new THREE.DirectionalLight(night ? "#9fb4ff" : "#ffffff", night ? 0.6 : 2.3);
    sun.position.set(W / 2 + 18, 32, D / 2 + 14);
    sun.target.position.copy(center);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 100 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    if (night) {
      for (const x of [W * 0.3, W * 0.7]) {
        const lamp = new THREE.PointLight("#ffd9a8", 18, 16, 1.6);
        lamp.position.set(x, 2.8, D / 2);
        scene.add(lamp);
      }
    }

    // ── City around the salon ──
    const ground = mesh(new THREE.PlaneGeometry(400, 400), mat(night ? "#283050" : "#dde2ee"), W / 2, 0, D / 2, false);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);
    const flat = (w: number, d: number, color: string, x: number, z: number, y = 0) => {
      const m = mesh(new THREE.PlaneGeometry(w, d), mat(color), x, y, z, false);
      m.rotation.x = -Math.PI / 2;
      scene.add(m);
      return m;
    };
    const roadZ = D + 7.5;
    flat(400, 7.5, night ? "#3a4366" : "#d4dae7", W / 2, roadZ, 0.005);                 // main road
    flat(7, 400, night ? "#3a4366" : "#d4dae7", -9, D / 2, 0.006);                       // side road
    flat(400, 3.6, night ? "#323a5c" : "#f4f6fb", W / 2, D + 1.8, 0.01);                // sidewalk
    flat(400, 1.2, night ? "#2c4a3e" : "#d6eedc", W / 2, D + 3.2, 0.012);                // verge
    for (let x = -190; x < 200; x += 4) if (x < -12.5 || x > -5.5) flat(2, 0.15, "#ffffff", x, roadZ, 0.015);
    for (let z = -190; z < 200; z += 4) if (z < roadZ - 4 || z > roadZ + 4) flat(0.15, 2, "#ffffff", -9, z, 0.016);
    for (let i = 0; i < 6; i++) flat(0.5, 3, "#ffffff", -11.6 + i * 1.05, D + 1.8, 0.017);   // crossing
    // Neighbouring buildings, kept low so they never hide the salon
    const block = (x: number, z: number, w: number, d: number, h: number) => {
      const b = mesh(rbox(w, h, d, 0.15), mat(night ? "#3b4470" : "#ffffff"), x, h / 2, z);
      scene.add(b);
      for (let y = 1.4; y < h - 0.6; y += 1.5) scene.add(mesh(new THREE.BoxGeometry(w * 0.86, 0.5, 0.04), mat(night ? "#ffe8b0" : "#b9c6e2", night ? { emissive: "#ffcf7a", emissiveIntensity: 0.6 } : {}), x, y, z + d / 2 + 0.01, false));
      return b;
    };
    block(W + 7, D / 2 - 1, 7, D - 2, 5.5);
    block(W + 16, D / 2 - 2, 8, D - 4, 8);
    block(W / 2 - 4, -9, 12, 6, 7);
    block(W / 2 + 9, -10, 9, 7, 5);
    block(-20, D / 2, 9, 10, 6);
    block(W / 2 - 10, roadZ + 12, 10, 8, 5);
    block(W / 2 + 6, roadZ + 12, 12, 8, 6.5);
    for (let x = -30; x < W + 30; x += 6) if (Math.abs(x - L.doorX) > 3 && (x < -12 || x > -6)) {
      const t = makeTree(0.9 + ((x * 7) % 3) * 0.08);
      t.position.set(x, 0, D + 3.2);
      scene.add(t);
    }
    for (const [x, z] of [[-4, 2], [-4, D - 4], [W + 2.5, -2], [W + 2.5, D - 2], [-14, roadZ + 6], [W + 10, roadZ + 6]]) {
      const t = makeTree(1.1); t.position.set(x, 0, z); scene.add(t);
    }
    const parked = makeCar("#ffffff"); parked.position.set(W - 2, 0, D + 4.6); scene.add(parked);
    const parked2 = makeCar(ACCENT); parked2.position.set(-1, 0, D + 4.6); scene.add(parked2);
    const traffic = [
      { car: makeCar("#ffffff"), x: -40, dir: 1, speed: 7, lane: roadZ - 1.8 },
      { car: makeCar(ACCENT), x: 30, dir: 1, speed: 5.5, lane: roadZ - 1.8 },
      { car: makeCar("#e2e8f0"), x: 60, dir: -1, speed: 6.5, lane: roadZ + 1.8 },
      { car: makeCar("#ffffff"), x: -10, dir: -1, speed: 8, lane: roadZ + 1.8 },
    ];
    for (const t of traffic) { t.car.rotation.y = t.dir > 0 ? 0 : Math.PI; scene.add(t.car); }

    // ── The salon ──
    const tiles = tileTexture();
    tiles.repeat.set(W / 1.2, D / 1.2);
    scene.add(mesh(new THREE.BoxGeometry(W, 0.14, D), mat("#ffffff", { map: tiles }), W / 2, 0.0, D / 2, false));
    const wallMat = mat(night ? "#e7e9f4" : "#ffffff");
    scene.add(mesh(new THREE.BoxGeometry(W + 0.4, 3, 0.2), wallMat, W / 2, 1.5, -0.1));
    scene.add(mesh(new THREE.BoxGeometry(0.2, 3, D), wallMat, -0.1, 1.5, D / 2));
    const glass = new THREE.MeshStandardMaterial({ color: "#cfe0ff", transparent: true, opacity: 0.14, roughness: 0.05, metalness: 0.2, depthWrite: false });
    const frame = mat("#ffffff");
    const glassRun = (x0: number, x1: number, z: number, alongZ = false) => {
      const len = x1 - x0, mid = (x0 + x1) / 2;
      const base = alongZ ? mesh(new THREE.BoxGeometry(0.2, 0.45, len), frame, z, 0.22, mid) : mesh(new THREE.BoxGeometry(len, 0.45, 0.2), frame, mid, 0.22, z);
      const pane = alongZ ? mesh(new THREE.BoxGeometry(0.04, 2.1, len), glass, z, 1.5, mid, false) : mesh(new THREE.BoxGeometry(len, 2.1, 0.04), glass, mid, 1.5, z, false);
      scene.add(base, pane);
      for (let p = x0; p <= x1 + 0.01; p += Math.max(1, len / Math.ceil(len / 3))) scene.add(alongZ ? mesh(new THREE.BoxGeometry(0.1, 2.6, 0.1), frame, z, 1.3, p) : mesh(new THREE.BoxGeometry(0.1, 2.6, 0.1), frame, p, 1.3, z));
    };
    glassRun(0, L.doorX - 1, D);
    glassRun(L.doorX + 1, W, D);
    glassRun(0, D, W, true);
    // Fascia and name over the door
    const sign = mesh(new THREE.BoxGeometry(6.4, 0.7, 0.22), [frame, frame, frame, frame, new THREE.MeshStandardMaterial({ map: textTexture(props.salonName || "Salon", ACCENT) }), frame], L.doorX, 2.95, D);
    scene.add(sign);
    flat(2, 1.2, ACCENT, L.doorX, D + 0.7, 0.02); // doormat

    // Stations
    const chairs: { group: THREE.Group; seatMat: THREE.MeshStandardMaterial; mirror: THREE.MeshStandardMaterial }[] = [];
    const clickables: THREE.Object3D[] = [];
    const productColors = ["#f472b6", "#60a5fa", "#fbbf24", "#a78bfa", "#34d399"];
    for (let i = 0; i < props.chairCount; i++) {
      const s = L.station(i);
      const g = new THREE.Group();
      g.userData.chair = i;
      if (Math.floor(i / PER_ROW) > 0) g.add(mesh(rbox(1.7, 2.5, 0.14, 0.05), frame, 0, 1.25, -0.02));
      g.add(mesh(rbox(1.6, 0.85, 0.5, 0.05), mat("#ffffff"), 0, 0.425, 0.3));
      const mirror = new THREE.MeshStandardMaterial({ color: "#d9e6ff", roughness: 0.08, metalness: 0.55, emissive: "#9fbaff", emissiveIntensity: night ? 0.35 : 0.05 });
      g.add(mesh(rbox(1.25, 1.45, 0.06, 0.04), mirror, 0, 1.65, 0.1, false));
      g.add(mesh(rbox(1.35, 0.06, 0.12, 0.02), frame, 0, 2.42, 0.12));
      for (let k = 0; k < 3; k++) g.add(mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.18, 10), mat(productColors[(i + k) % 5]), -0.55 + k * 0.14, 0.94, 0.25));
      const { group: chair, seatMat } = makeChair();
      chair.position.set(0, 0, 1.3);
      chair.rotation.y = 0; // seat faces the mirror (-z), backrest towards the room
      g.add(chair);
      g.position.set(s.x, 0.07, s.z);
      scene.add(g);
      clickables.push(g);
      chairs.push({ group: g, seatMat, mirror });
    }

    // Reception, waiting area, shelf, plants
    const desk = new THREE.Group();
    desk.add(mesh(rbox(3.2, 1.05, 0.9, 0.06), mat("#ffffff"), 1.6, 0.525, 0.45));
    desk.add(mesh(rbox(3.3, 0.06, 1.0, 0.03), mat(ACCENT), 1.6, 1.08, 0.45));
    desk.add(mesh(rbox(0.6, 0.38, 0.05, 0.02), mat("#1f2937"), 1.1, 1.35, 0.2));
    desk.position.set(L.desk.x, 0.07, L.desk.z);
    scene.add(desk);
    const receptionist = makePerson("reception", "#1e3a8a", true);
    receptionist.group.position.set(L.desk.x + 1.6, 0.07, L.desk.z - 0.45);
    receptionist.group.rotation.y = 0;
    scene.add(receptionist.group);
    const sofaMat = mat("#cdd9ff", { roughness: 0.85 });
    scene.add(mesh(rbox(4.2, 0.42, 0.9, 0.12), sofaMat, W - 3.65, 0.28, D - 1.4));
    scene.add(mesh(rbox(4.2, 0.75, 0.26, 0.1), sofaMat, W - 3.65, 0.6, D - 0.9));
    for (const x of [W - 6.1, W - 1.2]) scene.add(mesh(rbox(0.5, 0.5, 0.5, 0.06), mat("#ffffff"), x, 0.32, D - 1.4));
    const shelf = new THREE.Group();
    shelf.add(mesh(rbox(0.4, 2, 1.6, 0.03), mat("#ffffff"), 0, 1, 0));
    for (let r = 0; r < 3; r++) for (let k = 0; k < 6; k++) shelf.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.22, 10), mat(productColors[(r + k) % 5]), 0.08, 0.55 + r * 0.55, -0.6 + k * 0.24));
    shelf.position.set(0.25, 0.07, Math.min(D - 5, L.frontAisle + 0.6) - 1.6);
    scene.add(shelf);
    for (const [x, z] of [[W - 0.6, 0.6], [0.6, D - 0.7], [W - 0.6, D - 2.4]]) {
      const pot = new THREE.Group();
      pot.add(mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.42, 16), mat("#ffffff"), 0, 0.21, 0));
      pot.add(mesh(new THREE.IcosahedronGeometry(0.42, 2), mat("#7ccc93"), 0, 0.75, 0));
      pot.position.set(x, 0.07, z);
      scene.add(pot);
    }

    // Floor rings: progress under busy chairs, and the selection marker
    const ringMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    const rings = chairs.map((_, i) => {
      const s = L.seat(i);
      const m = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.72, 48, 1, 0, 0.001), ringMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(s.x, 0.09, s.z);
      scene.add(m);
      return { mesh: m, pct: -1 };
    });
    const select = new THREE.Mesh(new THREE.RingGeometry(0.8, 0.92, 48), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
    select.rotation.x = -Math.PI / 2;
    select.visible = false;
    scene.add(select);
    const pin = new THREE.Group();
    pin.add(mesh(new THREE.SphereGeometry(0.22, 20, 16), mat(ACCENT, { roughness: 0.3 }), 0, 0.45, 0, false));
    const cone = mesh(new THREE.ConeGeometry(0.15, 0.4, 16), mat(ACCENT, { roughness: 0.3 }), 0, 0.15, 0, false);
    cone.rotation.x = Math.PI;
    pin.add(cone);
    pin.visible = false;
    scene.add(pin);

    // Labels
    const chairTags = chairs.map((_, i) => {
      const s = L.station(i);
      const el = chip("sf-chip");
      const o = new CSS2DObject(el);
      o.position.set(s.x, 3.05, s.z + 0.2);
      scene.add(o);
      return { el, text: "", tone: "" };
    });
    const place = (text: string, x: number, y: number, z: number) => {
      const el = chip("sf-chip sf-chip-dark");
      const o = new CSS2DObject(el);
      o.position.set(x, y, z);
      scene.add(o);
      return el;
    };
    const receptionTag = place("", L.desk.x + 1.6, 2.4, L.desk.z + 0.4);
    const waitingTag = place("", W - 3.65, 2, D - 1.3);

    // ── People ──
    const ents = new Map<string, Ent>();
    let first = true;
    const streetPoint = (id: string) => ({ x: hashOf(id) % 2 ? W + 26 : -26, z: D + 1.2 + (hashOf(id) % 5) * 0.25 });
    syncRoster.current = () => {
      const roster = live.current.roster;
      const seen = new Set<string>();
      for (const p of roster) {
        seen.add(p.id);
        const goal = spotPos(p.spot, L);
        let e = ents.get(p.id);
        if (!e) {
          const start = first ? goal : streetPoint(p.id);
          const rig = makePerson(p.id, p.color, p.kind === "staff");
          scene.add(rig.group);
          rig.group.traverse((o) => { o.userData.person = p.id; });
          e = { id: p.id, rig, kind: p.kind, x: start.x, z: start.z, heading: Math.PI, path: first ? [] : route(start, goal, L), goal, spot: p.spot, leaving: false, working: false };
          ents.set(p.id, e);
        } else if (e.leaving || !e.spot || e.spot.type !== p.spot.type || e.spot.index !== p.spot.index) {
          e.path = route(e, goal, L);
          e.goal = goal;
          e.leaving = false;
        }
        e.spot = p.spot;
        e.working = !!p.working;
        if (p.label) {
          if (!e.tag) {
            e.tag = chip("sf-name");
            const o = new CSS2DObject(e.tag);
            o.position.set(0, 2.05, 0);
            e.rig.group.add(o);
          }
          if (e.tag.textContent !== p.label.text) e.tag.textContent = p.label.text;
          e.tag.dataset.busy = String(p.label.busy);
        }
        e.rig.bodyMat.color.set(p.color);
        if (p.bubble && p.bubble.until > Date.now() && !e.bubble) {
          const el = chip("sf-bubble");
          el.textContent = p.bubble.text;
          e.bubble = new CSS2DObject(el);
          e.bubble.position.set(0, 2.15, 0);
          e.rig.group.add(e.bubble);
          const ent = e;
          setTimeout(() => { if (ent.bubble) { ent.rig.group.remove(ent.bubble); ent.bubble.element.remove(); ent.bubble = undefined; } }, p.bubble.until - Date.now());
        }
      }
      for (const e of ents.values()) {
        if (seen.has(e.id) || e.leaving) continue;
        const out = streetPoint(e.id);
        e.leaving = true;
        e.spot = null;
        e.goal = { ...out, y: 0 };
        e.path = route(e, out, L);
      }
      first = false;
    };
    syncRoster.current();

    // Money popping up over reception
    const popsShown = new Set<number>();
    const floating: { obj: CSS2DObject; born: number }[] = [];
    syncPops.current = () => {
      for (const p of live.current.pops) {
        if (popsShown.has(p.id)) continue;
        popsShown.add(p.id);
        const el = chip("sf-pop");
        el.textContent = `💰 ${p.text}`;
        const obj = new CSS2DObject(el);
        obj.position.set(L.desk.x + 1.6, 2.2, L.desk.z + 0.4);
        scene.add(obj);
        floating.push({ obj, born: performance.now() });
      }
    };

    // ── Camera moves (buttons, search) ──
    let tween: { from: THREE.Spherical; to: THREE.Spherical; fromT: THREE.Vector3; toT: THREE.Vector3; t: number } | null = null;
    const currentSph = () => new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    const moveTo = (to: THREE.Spherical, target = controls.target.clone()) => {
      tween = { from: currentSph(), to, fromT: controls.target.clone(), toT: target, t: 0 };
    };
    live.current.apiRef.current = {
      zoom: (f) => { const s = currentSph(); s.radius = THREE.MathUtils.clamp(s.radius * f, controls.minDistance, controls.maxDistance); moveTo(s); },
      rotate: (dir) => { const s = currentSph(); s.theta += (dir * Math.PI) / 4; moveTo(s); },
      home: () => moveTo(new THREE.Spherical(HOME.radius, HOME.phi, HOME.theta), center.clone()),
      focusChair: (i) => { const s = L.seat(i); const sp = currentSph(); sp.radius = Math.min(sp.radius, 18); moveTo(sp, new THREE.Vector3(s.x, 0, s.z)); },
      focusPerson: (id) => { const e = ents.get(id); if (!e) return; const sp = currentSph(); sp.radius = Math.min(sp.radius, 16); moveTo(sp, new THREE.Vector3(e.x, 0, e.z)); },
    };

    // ── Picking chairs ──
    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const pick = (ev: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
      const people = [...ents.values()].filter((e) => e.spot?.type === "chair" || e.working).map((e) => e.rig.group);
      for (const hit of ray.intersectObjects([...clickables, ...people], true)) {
        let o: THREE.Object3D | null = hit.object;
        while (o) {
          if (o.userData.chair != null) return o.userData.chair as number;
          const personId = o.userData.person as string | undefined;
          if (personId) { const sp = ents.get(personId)?.spot; if (sp?.type === "chair" || sp?.type === "station") return sp.index; }
          o = o.parent;
        }
      }
      return null;
    };
    const onDown = (ev: PointerEvent) => { down = { x: ev.clientX, y: ev.clientY }; };
    const onUp = (ev: PointerEvent) => {
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) { down = null; return; }
      down = null;
      const i = pick(ev);
      const busy = i != null && live.current.chairLabels[i]?.tone !== "free";
      live.current.onSelectChair(busy ? (live.current.selectedChair === i ? null : i) : null);
    };
    let lastHover = 0;
    const onMove = (ev: PointerEvent) => {
      if (down || performance.now() - lastHover < 80) return;
      lastHover = performance.now();
      const i = pick(ev);
      renderer.domElement.style.cursor = i != null && live.current.chairLabels[i]?.tone !== "free" ? "pointer" : "grab";
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointermove", onMove);

    // ── Size ──
    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      renderer.setSize(w, h);
      labels.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      // On wide screens the right-hand panel covers ~400px, so centre the
      // salon in the open area to its left rather than in the whole canvas.
      if (w > 1180) camera.setViewOffset(w, h, 170, -60, w, h); else camera.clearViewOffset();
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // ── Frame loop ──
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      const p = live.current;

      for (const e of [...ents.values()]) {
        let budget = WALK * dt;
        let moving = false;
        while (budget > 0 && e.path.length) {
          const q = e.path[0];
          const dx = q.x - e.x, dz = q.z - e.z, dist = Math.hypot(dx, dz);
          if (dist > 0.001) { e.heading = Math.atan2(dx, dz); moving = true; }
          if (dist <= budget) { e.x = q.x; e.z = q.z; e.path.shift(); budget -= dist; }
          else { e.x += (dx / dist) * budget; e.z += (dz / dist) * budget; budget = 0; }
        }
        if (e.leaving && !e.path.length) {
          scene.remove(e.rig.group);
          if (e.bubble) e.bubble.element.remove();
          e.tag?.remove();
          ents.delete(e.id);
          continue;
        }
        const settled = !e.path.length && !e.leaving;
        const sitting = settled && e.kind === "client" && e.goal.y > 0;
        const working = settled && e.working && e.spot?.type === "station";
        const g = e.rig.group;
        let heading = e.heading;
        if (sitting) heading = Math.PI; // facing the mirror / into the salon
        if (working && e.spot) { const s = L.seat(e.spot.index); heading = Math.atan2(s.x - e.x, s.z - e.z); }
        if (settled && !sitting && !working) heading = e.kind === "staff" ? Math.PI * 0.85 : heading;
        g.rotation.y += Math.atan2(Math.sin(heading - g.rotation.y), Math.cos(heading - g.rotation.y)) * Math.min(1, dt * 10);
        const swing = moving ? Math.sin(t * 9 + e.x) * 0.55 : 0;
        e.rig.legL.rotation.x = sitting ? -1.45 : swing;
        e.rig.legR.rotation.x = sitting ? -1.45 : -swing;
        e.rig.arm.rotation.x = working ? -0.9 + Math.sin(t * 7) * 0.35 : moving ? -swing : 0;
        e.rig.arm.rotation.z = working ? -0.25 : 0;
        const bob = moving ? Math.abs(Math.sin(t * 9 + e.x)) * 0.04 : 0;
        g.position.set(e.x, 0.07 + (sitting ? e.goal.y - 0.42 : 0) + bob, e.z);
      }

      // Chairs, rings, labels
      p.chairLabels.forEach((c, i) => {
        const ch = chairs[i];
        if (!ch) return;
        ch.seatMat.color.set(c.tone === "free" ? "#c9d2e8" : c.tone === "warn" ? "#f59e0b" : ACCENT);
        const tag = chairTags[i];
        if (tag.text !== c.text || tag.tone !== c.tone) { tag.el.textContent = c.text; tag.el.dataset.tone = c.tone; tag.text = c.text; tag.tone = c.tone; }
        const pct = c.progress == null ? 0 : Math.round(Math.min(1, Math.max(0, c.progress)) * 100);
        const ring = rings[i];
        if (ring.pct !== pct) {
          ring.mesh.geometry.dispose();
          ring.mesh.geometry = new THREE.RingGeometry(0.62, 0.72, 48, 1, Math.PI / 2, Math.max(0.001, (pct / 100) * Math.PI * 2));
          ring.mesh.visible = pct > 0;
          ring.pct = pct;
        }
      });
      if (receptionTag.textContent !== p.receptionLabel) receptionTag.textContent = p.receptionLabel;
      if (waitingTag.textContent !== p.waitingLabel) waitingTag.textContent = p.waitingLabel;
      if (p.selectedChair != null && chairs[p.selectedChair]) {
        const s = L.seat(p.selectedChair);
        select.visible = true;
        select.position.set(s.x, 0.1, s.z);
        pin.visible = true;
        pin.position.set(s.x, 2.3 + Math.sin(t * 3) * 0.1, s.z);
      } else { select.visible = false; pin.visible = false; }

      for (let k = floating.length - 1; k >= 0; k--) {
        const f = floating[k];
        const age = (now - f.born) / 1000;
        f.obj.position.y = 2.2 + age * 0.9;
        f.obj.element.style.opacity = String(Math.max(0, 1 - age / 2.6));
        if (age > 2.6) { scene.remove(f.obj); f.obj.element.remove(); floating.splice(k, 1); }
      }

      for (const tr of traffic) {
        tr.x += tr.dir * tr.speed * dt;
        if (tr.x > 90) tr.x = -60; else if (tr.x < -60) tr.x = 90;
        tr.car.position.set(tr.x, 0, tr.lane);
      }

      if (tween) {
        tween.t = Math.min(1, tween.t + dt / 0.6);
        const k = 1 - Math.pow(1 - tween.t, 3);
        const s = new THREE.Spherical(
          THREE.MathUtils.lerp(tween.from.radius, tween.to.radius, k),
          THREE.MathUtils.lerp(tween.from.phi, tween.to.phi, k),
          THREE.MathUtils.lerp(tween.from.theta, tween.to.theta, k),
        );
        controls.target.lerpVectors(tween.fromT, tween.toT, k);
        camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(s));
        if (tween.t >= 1) tween = null;
      }
      controls.update();
      renderer.render(scene, camera);
      labels.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointermove", onMove);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const x of mats) { (x as THREE.MeshStandardMaterial).map?.dispose(); x.dispose(); }
      });
      renderer.dispose();
      renderer.domElement.remove();
      labels.domElement.remove();
      live.current.apiRef.current = null;
    };
    // The scene is rebuilt only when its shape changes; everything live is read from `live`.
  }, [props.chairCount, props.salonName, props.night]);

  useEffect(() => { syncRoster.current(); }, [props.roster]);
  useEffect(() => { syncPops.current(); }, [props.pops]);

  return (
    <>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      <style>{`
        .sf-chip{padding:4px 10px;border-radius:999px;font:700 11px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;white-space:nowrap;box-shadow:0 4px 12px rgba(15,23,42,.14);background:#fff;color:#16a34a;border:1px solid #dcfce7}
        .sf-chip[data-tone=busy]{background:${ACCENT};color:#fff;border-color:${ACCENT}}
        .sf-chip[data-tone=warn]{background:#f59e0b;color:#fff;border-color:#f59e0b}
        .sf-chip-dark{background:#0f172a;color:#fff;border-color:#0f172a}
        .sf-chip:empty{display:none}
        .sf-name{padding:2px 8px;border-radius:999px;font:700 10px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;white-space:nowrap;background:rgba(255,255,255,.95);color:#475569;border:1px solid #e2e8f0;box-shadow:0 2px 8px rgba(15,23,42,.12)}
        .sf-name::before{content:"";display:inline-block;width:6px;height:6px;border-radius:3px;background:#94a3b8;margin-right:5px;vertical-align:1px}
        .sf-name[data-busy=true]{background:#0f172a;color:#fff;border-color:#0f172a}
        .sf-name[data-busy=true]::before{background:#22c55e}
        .sf-bubble{font-size:20px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.2))}
        .sf-pop{font:900 17px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#16a34a;text-shadow:0 0 3px #fff,0 0 6px #fff}
      `}</style>
    </>
  );
}
