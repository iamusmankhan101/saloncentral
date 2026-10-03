"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, Wand2, RefreshCw, Download, ChevronRight, Sparkles, ImagePlus, CheckCircle, AlertCircle, Clock } from "lucide-react";
import { generateHairMask, compositeWithMask } from "@/lib/hair-mask";
import { getCurrentPlan } from "@/lib/plan-limits";
import PageTitle from "@/components/page-title";

// ── Service catalogue ────────────────────────────────────────────────────────

type Preset = { label: string; color: string; prompt: string };
type Category = { label: string; icon: string; presets: Preset[] };

const CATEGORIES: Category[] = [
  {
    label: "Hair Color",
    icon: "💇‍♀️",
    presets: [
      { label: "Jet Black",     color: "#1a1a1a", prompt: "Apply jet black shiny glossy hair color to the woman in the uploaded image, keeping natural hair texture and realistic lighting, rich deep black salon-finish hair, seamless virtual try-on" },
      { label: "Golden Blonde", color: "#f0c060", prompt: "Apply vibrant golden blonde hair color to the woman in the uploaded image, warm bright blonde tones with natural shine, realistic salon-quality virtual hair color try-on" },
      { label: "Vibrant Red",   color: "#c0202a", prompt: "Apply fiery vibrant red hair color to the woman in the uploaded image, bold salon-style red tones with glossy realistic texture, seamless virtual try-on effect" },
      { label: "Dark Brown",    color: "#4a2a10", prompt: "Apply rich dark chocolate brown hair color to the woman in the uploaded image, glossy brunette salon finish with realistic highlights and shadows, natural virtual try-on" },
      { label: "Platinum",      color: "#e8e8e0", prompt: "Apply icy platinum silver blonde hair color to the woman in the uploaded image, cool platinum tones with smooth salon-quality shine, ultra-realistic virtual try-on" },
      { label: "Rose Gold",     color: "#e8a0a0", prompt: "Apply trendy rose gold pink hair color to the woman in the uploaded image, soft metallic pink tones with glossy realistic hair texture, salon-style virtual try-on" },
      { label: "Balayage",      color: "#c8904a", prompt: "Apply sun-kissed balayage hair color to the woman in the uploaded image, dark roots blending naturally into warm caramel ends, realistic salon balayage virtual try-on" },
      { label: "Purple Ombre",  color: "#7040b0", prompt: "Apply dark-to-bold purple ombre hair color to the woman in the uploaded image, vibrant purple gradient with smooth realistic blending and salon-quality finish, virtual try-on effect" },
    ],
  },
  {
    label: "Hairstyle",
    icon: "✂️",
    presets: [
      { label: "Short Pixie",      color: "#7C3AED", prompt: "Apply short pixie cut hairstyle to the woman in the uploaded image, stylish short cropped hair with natural texture, realistic salon-quality virtual haircut try-on" },
      { label: "Chin Bob",         color: "#0369a1", prompt: "Apply sleek chin-length bob haircut to the woman in the uploaded image, sharp polished bob with realistic hair movement, professional virtual hairstyle try-on" },
      { label: "Long Straight",    color: "#059669", prompt: "Apply long straight silky smooth flowing hair to the woman in the uploaded image, sleek straight hairstyle with natural shine, realistic virtual try-on" },
      { label: "Beach Waves",      color: "#d97706", prompt: "Apply loose effortless beach waves to the woman in the uploaded image, tousled wavy hairstyle with natural texture, salon-quality virtual try-on" },
      { label: "Tight Curls",      color: "#dc2626", prompt: "Apply tight bouncy natural curls to the woman in the uploaded image, defined curly hairstyle with realistic volume, seamless virtual try-on" },
      { label: "Side Swept Bangs", color: "#7C3AED", prompt: "Apply side swept bangs fringe to the woman in the uploaded image, stylish side fringe with natural hair flow, realistic virtual hairstyle try-on" },
    ],
  },
  {
    label: "Makeup",
    icon: "💄",
    presets: [
      { label: "Natural Glow",  color: "#f9a8a8", prompt: "Apply natural glowing makeup to the woman in the uploaded image, dewy fresh skin with subtle blush and healthy glow, realistic virtual makeup try-on" },
      { label: "Smoky Eye",     color: "#2a2a3a", prompt: "Apply dramatic smoky eye makeup to the woman in the uploaded image, dark blended eyeshadow with bold eyes, professional virtual makeup try-on" },
      { label: "Bold Red Lip",  color: "#c0202a", prompt: "Apply bold classic red lipstick to the woman in the uploaded image, vibrant red lips with glossy finish, realistic virtual makeup try-on" },
      { label: "Bridal Glam",   color: "#f0d060", prompt: "Apply bridal glamour makeup to the woman in the uploaded image, flawless radiant skin with soft romantic glow, professional virtual makeup try-on" },
      { label: "Nude & Bronze", color: "#c89060", prompt: "Apply nude lips with warm bronze highlight glow to the woman in the uploaded image, soft glam makeup with natural contour, realistic virtual try-on" },
      { label: "Bold Eyeliner", color: "#1a1a2e", prompt: "Apply sharp bold black cat eye liner to the woman in the uploaded image, dramatic winged eyeliner with precise lines, professional virtual makeup try-on" },
    ],
  },
  {
    label: "Highlights",
    icon: "✨",
    presets: [
      { label: "Caramel Highlights", color: "#c08030", prompt: "Apply caramel highlights woven through hair to the woman in the uploaded image, warm caramel tones blended naturally into hair, realistic salon-quality virtual try-on" },
      { label: "Blonde Highlights",  color: "#e8c870", prompt: "Apply bright blonde highlights throughout hair to the woman in the uploaded image, sun-kissed blonde streaks with natural dimension, professional virtual try-on" },
      { label: "Red Highlights",     color: "#c03020", prompt: "Apply vibrant red highlights woven through hair to the woman in the uploaded image, bold red streaks with realistic blending, salon-style virtual try-on" },
      { label: "Frosted Tips",       color: "#d8d8e8", prompt: "Apply frosted platinum blonde tips to the woman in the uploaded image, icy frosted ends with smooth gradient dip-dye effect, realistic virtual try-on" },
    ],
  },
];

// ── Image resize helper ───────────────────────────────────────────────────────

function resizeImageToBase64(file: File, maxSize = 768): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
      canvas.width = Math.round(img.width * ratio);
      canvas.height = Math.round(img.height * ratio);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ── Main page ─────────────────────────────────────────────────────────────────

function UpgradeWall() {
  const plan = getCurrentPlan();
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f7f7fb", padding: 32 }}>
      <div style={{ textAlign: "center", maxWidth: 460 }}>
        <div style={{ width: 80, height: 80, borderRadius: 24, background: "linear-gradient(135deg,#5B21B6,#9333EA)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px", boxShadow: "0 8px 32px rgba(124,58,237,0.3)" }}>
          <Sparkles size={36} color="#fff" />
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 14px", borderRadius: 999, background: "#fff7ed", border: "1px solid #fed7aa", color: "#c2410c", fontSize: 11, fontWeight: 900, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 12 }}>
          Coming Soon
        </div>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#9333EA", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>Premium Feature</div>
        <h1 style={{ fontSize: 28, fontWeight: 900, color: "#1a1a2e", margin: "0 0 12px" }}>Virtual Try-On (AI)</h1>
        <p style={{ fontSize: 14, color: "#6b6b8a", lineHeight: 1.7, margin: "0 0 24px" }}>
          Let clients preview hair colors and styles before their appointment using AI. This feature is currently in development and will be available exclusively on <strong>Salon Central Premium</strong>.
        </p>
        <div style={{ background: "#fff", borderRadius: 16, border: "1px solid #ede9fe", padding: "18px 20px", marginBottom: 24, display: "flex", flexDirection: "column", gap: 10, textAlign: "left" }}>
          {["AI hair color preview (8 shades)", "Hairstyle simulation (6 styles)", "Nail & skin tone try-on", "Instant client-facing preview link"].map(f => (
            <div key={f} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#f5f3ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "#7C3AED" }}>✓</span>
              </div>
              <span style={{ fontSize: 13, color: "#374151", fontWeight: 500 }}>{f}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: "#9898b0" }}>Current plan:</span>
          <span style={{ fontSize: 13, fontWeight: 800, color: plan.color, background: plan.bg, borderRadius: 20, padding: "2px 12px", border: `1px solid ${plan.color}30` }}>{plan.label}</span>
        </div>
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: "10px 14px", color: "#92400e", fontSize: 12, fontWeight: 700, margin: "0 0 16px" }}>
          We’re polishing this AI experience now. Contact sales to join the early-access list.
        </div>
        <a href="/dashboard/billing" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "13px 32px", borderRadius: 12, background: "linear-gradient(135deg,#5B21B6,#9333EA)", color: "#fff", fontSize: 14, fontWeight: 800, textDecoration: "none", boxShadow: "0 4px 16px rgba(91,33,182,0.38)" }}>
          Contact Sales / Join Waitlist →
        </a>
      </div>
    </div>
  );
}

export default function TryOnPage() {
  // Feature isn't launched yet — show the Coming Soon screen to every user
  // regardless of plan, rather than only gating it behind plan.tryOn.
  return <UpgradeWall />;
}

function TryOnTool() {
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [hairMask, setHairMask] = useState<string | null>(null);
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState(0);
  const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [showOriginal, setShowOriginal] = useState(false);

  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [predictTime, setPredictTime] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const base64 = await resizeImageToBase64(file);
    setOriginalImage(base64);
    setHairMask(null);
    setResultImage(null);
    setStatus("idle");
    setSelectedPreset(null);
    // Generate hair mask in background after image loads
    generateHairMask(base64).then(setHairMask).catch(() => {});
  }

  async function generate() {
    if (!originalImage) return;
    if (!selectedPreset && !customPrompt.trim()) {
      setErrorMsg("Select a style or enter a custom prompt.");
      setStatus("error");
      return;
    }
    await generateWithAPI();
  }

  async function generateWithAPI() {
    const prompt = customPrompt.trim() || selectedPreset?.prompt || "";
    if (!prompt) { setErrorMsg("Select a style."); setStatus("error"); return; }

    const mask = hairMask ?? await generateHairMask(originalImage!);
    if (!hairMask) setHairMask(mask);

    setStatus("generating");
    setErrorMsg("");
    setResultImage(null);
    setPredictTime(null);
    setElapsed(0);

    const startAt = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startAt) / 1000)), 500);

    try {
      const createRes = await fetch("/api/try-on", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: originalImage, prompt }),
      });
      const createData = await createRes.json() as {
        predictionId?: string; output?: string; error?: string;
        isLoading?: boolean; estimatedTime?: number; predictTime?: number;
      };

      if (createData.isLoading) {
        setErrorMsg(createData.error || "Model is loading, please try again in a moment.");
        setStatus("error");
        clearInterval(timerRef.current!);
        return;
      }
      if (!createRes.ok || !createData.predictionId) throw new Error(createData.error ?? "Failed to start generation");

      async function applyResult(aiUrl: string) {
        const composited = await compositeWithMask(originalImage!, aiUrl, mask);
        clearInterval(timerRef.current!);
        setResultImage(composited);
        setStatus("done");
      }

      if (createData.output) {
        if (createData.predictTime) setPredictTime(createData.predictTime);
        await applyResult(createData.output);
        return;
      }

      pollRef.current = setInterval(async () => {
        const pollRes = await fetch(`/api/try-on?id=${createData.predictionId}`);
        const pollData = await pollRes.json() as { status: string; output: string | null; error: string | null; predictTime: number | null };
        if (pollData.status === "succeeded" && pollData.output) {
          clearInterval(pollRef.current!);
          setPredictTime(pollData.predictTime);
          await applyResult(pollData.output);
        } else if (pollData.status === "failed" || pollData.error) {
          clearInterval(pollRef.current!);
          clearInterval(timerRef.current!);
          setErrorMsg(pollData.error ?? "Generation failed");
          setStatus("error");
        }
      }, 2000);

    } catch (err) {
      clearInterval(timerRef.current!);
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      setStatus("error");
    }
  }

  async function downloadResult() {
    if (!resultImage) return;
    const a = document.createElement("a");
    a.href = resultImage;
    a.download = `tryon-result-${Date.now()}.jpg`;
    a.click();
  }

  const category = CATEGORIES[activeCategory];

  return (
    <div className="dash-page dashboard-polish" style={{ background: "#f4f5f7", minHeight: "100vh", padding: "28px 32px", display: "flex", flexDirection: "column", gap: 24 }}>

      {/* Header */}
      <PageTitle
        icon={<Wand2 size={24} />}
        title="Virtual Try-On"
        subtitle="Show clients how any service will look on them using AI"
      />

      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 20, alignItems: "start" }}>

        {/* ── Left panel ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Photo upload */}
          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid #f0f0f8", fontWeight: 800, fontSize: 13, color: "#1a1a2e", display: "flex", alignItems: "center", gap: 8 }}>
              <Upload size={14} color="#7C3AED" /> Client Photo
            </div>
            <div style={{ padding: 14 }}>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFileChange} />
              {originalImage ? (
                <div style={{ position: "relative", borderRadius: 10, overflow: "hidden" }}>
                  <img src={originalImage} alt="Client" style={{ width: "100%", height: 220, objectFit: "cover", display: "block" }} />
                  <button onClick={() => fileRef.current?.click()}
                    style={{ position: "absolute", bottom: 10, right: 10, background: "rgba(0,0,0,0.6)", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
                    <ImagePlus size={12} /> Change photo
                  </button>
                </div>
              ) : (
                <button onClick={() => fileRef.current?.click()}
                  style={{ width: "100%", padding: "32px 20px", borderRadius: 10, border: "2px dashed #e0e0f0", background: "#fafafa", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <div style={{ width: 48, height: 48, borderRadius: 14, background: "#EDE9FE", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <ImagePlus size={22} color="#7C3AED" />
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#6b6b8a" }}>Upload client photo</div>
                  <div style={{ fontSize: 11, color: "#b0b0c8" }}>JPG or PNG, max 10 MB</div>
                </button>
              )}
            </div>
          </div>

          {/* Service categories */}
          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid #f0f0f8", fontWeight: 800, fontSize: 13, color: "#1a1a2e" }}>
              Service &amp; Style
            </div>
            {/* Category tabs */}
            <div style={{ display: "flex", borderBottom: "1px solid #f0f0f8", overflowX: "auto" }}>
              {CATEGORIES.map((cat, i) => (
                <button key={cat.label} onClick={() => { setActiveCategory(i); setSelectedPreset(null); }}
                  style={{ flex: 1, minWidth: 70, padding: "10px 8px", border: "none", background: activeCategory === i ? "#faf8ff" : "#fff", borderBottom: activeCategory === i ? "2px solid #7C3AED" : "2px solid transparent", fontSize: 11, fontWeight: activeCategory === i ? 800 : 600, color: activeCategory === i ? "#7C3AED" : "#9898b0", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, transition: "all 0.15s" }}>
                  <span style={{ fontSize: 16 }}>{cat.icon}</span>
                  {cat.label}
                </button>
              ))}
            </div>
            {/* Preset grid */}
            <div style={{ padding: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {category.presets.map((preset) => {
                const active = selectedPreset?.label === preset.label;
                return (
                  <button key={preset.label} onClick={() => { setSelectedPreset(preset); setCustomPrompt(""); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 11px", borderRadius: 10, border: `1.5px solid ${active ? "#7C3AED" : "#e8e8f0"}`, background: active ? "#faf8ff" : "#fafafa", cursor: "pointer", textAlign: "left", transition: "all 0.15s" }}>
                    <div style={{ width: 22, height: 22, borderRadius: "50%", background: preset.color, border: `2px solid ${active ? "#7C3AED" : "#e8e8f0"}`, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: active ? 700 : 500, color: active ? "#7C3AED" : "#4a4a6a" }}>{preset.label}</span>
                    {active && <CheckCircle size={12} color="#7C3AED" style={{ marginLeft: "auto", flexShrink: 0 }} />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom prompt */}
          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", padding: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: "#9898b0", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Custom Instruction (optional)</div>
            <textarea
              value={customPrompt}
              onChange={(e) => { setCustomPrompt(e.target.value); if (e.target.value) setSelectedPreset(null); }}
              placeholder={`e.g. "same person with warm chestnut brown hair and soft waves"`}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 9, border: "1.5px solid #e8e8f0", fontSize: 12, color: "#1a1a2e", resize: "vertical", minHeight: 72, outline: "none", fontFamily: "inherit", boxSizing: "border-box", lineHeight: 1.5 }}
            />
          </div>

          {/* Generate button */}
          <button onClick={generate} disabled={!originalImage || (!selectedPreset && !customPrompt.trim()) || status === "generating"}
            style={{
              padding: "14px", borderRadius: 12, border: "none",
              background: status === "generating" ? "#e8e8f0" : (!originalImage || (!selectedPreset && !customPrompt.trim())) ? "#e8e8f0" : "linear-gradient(135deg,#5B21B6,#9333EA)",
              fontSize: 14, fontWeight: 800, color: status === "generating" || !originalImage || (!selectedPreset && !customPrompt.trim()) ? "#aaaabc" : "#fff",
              cursor: status === "generating" || !originalImage || (!selectedPreset && !customPrompt.trim()) ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10, boxShadow: status === "idle" && originalImage && (selectedPreset || customPrompt.trim()) ? "0 4px 16px rgba(91,33,182,0.4)" : "none",
              transition: "all 0.2s",
            }}>
            {status === "generating" ? (
              <><RefreshCw size={16} style={{ animation: "spin 1s linear infinite" }} /> Generating… {elapsed}s</>
            ) : (
              <><Wand2 size={16} /> Generate Try-On</>
            )}
          </button>

          {/* Cost estimate */}
          <div style={{ fontSize: 11, color: "#b0b0c8", textAlign: "center" }}>
            🎨 AI Generation · Powered by Gemini 2.0 Flash
            <br />
            <span style={{ fontSize: 10, color: "#d0d0d8" }}>Google Gemini · 1,500 free generations per day</span>
          </div>
        </div>

        {/* ── Right panel — result ── */}
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #ebebf0", overflow: "hidden", minHeight: 520 }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid #f0f0f8", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: "#1a1a2e", display: "flex", alignItems: "center", gap: 8 }}>
              <Sparkles size={14} color="#7C3AED" />
              {status === "done" ? "AI Result" : "Preview"}
            </div>
            {status === "done" && predictTime && (
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 11, color: "#9898b0", display: "flex", alignItems: "center", gap: 4 }}>
                  <Clock size={11} /> {predictTime.toFixed(1)}s
                </span>
                <button onClick={() => setShowOriginal((p) => !p)}
                  style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #e8e8f0", background: "#fafafa", fontSize: 11, fontWeight: 700, color: "#6b6b8a", cursor: "pointer" }}>
                  {showOriginal ? "Show Result" : "Show Original"}
                </button>
                <button onClick={downloadResult}
                  style={{ padding: "5px 12px", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#5B21B6,#9333EA)", fontSize: 11, fontWeight: 700, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
                  <Download size={11} /> Save
                </button>
              </div>
            )}
          </div>

          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            {status === "idle" && !resultImage && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 420, gap: 16 }}>
                <div style={{ width: 80, height: 80, borderRadius: 24, background: "linear-gradient(135deg,#EDE9FE,#DDD6FE)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Wand2 size={36} color="#7C3AED" />
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontWeight: 800, fontSize: 16, color: "#1a1a2e", marginBottom: 6 }}>Ready to transform</div>
                  <div style={{ fontSize: 13, color: "#9898b0", maxWidth: 300, lineHeight: 1.6 }}>
                    Upload a client photo, pick a style, and hit Generate to see the AI transformation.
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 8 }}>
                  {[
                    { step: "1", text: "Upload photo" },
                    { step: "2", text: "Pick a style" },
                    { step: "3", text: "Generate" },
                  ].map(({ step, text }) => (
                    <div key={step} style={{ padding: "12px 14px", borderRadius: 10, background: "#fafafa", border: "1px solid #ebebf0", textAlign: "center" }}>
                      <div style={{ width: 24, height: 24, borderRadius: "50%", background: "linear-gradient(135deg,#5B21B6,#9333EA)", color: "#fff", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 6px" }}>{step}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#6b6b8a" }}>{text}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {status === "generating" && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 420, gap: 20 }}>
                {originalImage && (
                  <div style={{ position: "relative", borderRadius: 16, overflow: "hidden", width: "100%", maxWidth: 400 }}>
                    <img src={originalImage} alt="Processing" style={{ width: "100%", height: 280, objectFit: "cover", display: "block", filter: "blur(4px) brightness(0.7)" }} />
                    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
                      <div style={{ width: 56, height: 56, borderRadius: 16, background: "rgba(255,255,255,0.9)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Wand2 size={26} color="#7C3AED" />
                      </div>
                      <div style={{ color: "#fff", fontWeight: 800, fontSize: 14, textShadow: "0 1px 4px rgba(0,0,0,0.5)" }}>AI is working… {elapsed}s</div>
                      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", textShadow: "0 1px 3px rgba(0,0,0,0.5)" }}>
                        {selectedPreset ? `Applying ${selectedPreset.label}` : "Applying custom style"}
                      </div>
                    </div>
                  </div>
                )}
                <div style={{ fontSize: 12, color: "#9898b0" }}>Usually takes 15–30 seconds</div>
              </div>
            )}

            {status === "error" && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 300, gap: 12 }}>
                <div style={{ width: 56, height: 56, borderRadius: 16, background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <AlertCircle size={26} color="#dc2626" />
                </div>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#dc2626" }}>Generation failed</div>
                <div style={{ fontSize: 12, color: "#6b6b8a", textAlign: "center", maxWidth: 320 }}>{errorMsg}</div>
                <button onClick={generate}
                  style={{ padding: "9px 20px", borderRadius: 9, border: "none", background: "linear-gradient(135deg,#5B21B6,#9333EA)", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                  <RefreshCw size={13} /> Try Again
                </button>
              </div>
            )}

            {status === "done" && resultImage && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Before / After */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid #ebebf0" }}>
                    <div style={{ padding: "8px 12px", background: "#f4f5f7", fontSize: 11, fontWeight: 700, color: "#9898b0", textTransform: "uppercase", letterSpacing: "0.06em" }}>Before</div>
                    <img src={originalImage!} alt="Before" style={{ width: "100%", height: 300, objectFit: "cover", display: "block" }} />
                  </div>
                  <div style={{ borderRadius: 12, overflow: "hidden", border: "2px solid #7C3AED" }}>
                    <div style={{ padding: "8px 12px", background: "#EDE9FE", fontSize: 11, fontWeight: 700, color: "#7C3AED", textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 5 }}>
                      <Sparkles size={11} /> After — AI
                    </div>
                    <img src={showOriginal ? originalImage! : resultImage} alt="After" style={{ width: "100%", height: 300, objectFit: "cover", display: "block" }} />
                  </div>
                </div>

                {/* Style applied */}
                {selectedPreset && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderRadius: 10, background: "#faf8ff", border: "1px solid #EDE9FE" }}>
                    <div style={{ width: 24, height: 24, borderRadius: "50%", background: selectedPreset.color, border: "2px solid #e8e8f0", flexShrink: 0 }} />
                    <div style={{ fontSize: 13, color: "#4a4a6a" }}>
                      <strong style={{ color: "#7C3AED" }}>{category.label}</strong> — {selectedPreset.label} applied successfully
                    </div>
                    <ChevronRight size={14} color="#9898b0" style={{ marginLeft: "auto" }} />
                  </div>
                )}

                {/* CTA */}
                <div style={{ padding: "16px", borderRadius: 12, background: "linear-gradient(135deg,#5B21B6,#9333EA)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Happy with the result? Book this service now!</div>
                  <button onClick={generate}
                    style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.3)", background: "rgba(255,255,255,0.2)", fontSize: 12, fontWeight: 700, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                    <Wand2 size={12} /> Try another
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Spin animation */}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
