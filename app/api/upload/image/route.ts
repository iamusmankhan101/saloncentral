/**
 * POST /api/upload/image
 *
 * Uploads an image to Cloudinary and returns its hosted URL.
 *
 * The upload is signed here rather than done straight from the browser: a
 * browser-side unsigned preset is open to anyone who reads the page source, and
 * this app has public sign-up. Routing through the server keeps the API secret
 * out of the client, lets the folder be forced per salon, and means the browser
 * only ever talks to its own origin — so the CSP connect-src list is unchanged.
 *
 * Callers send an already-downscaled data URL (see lib/image.ts), so the payload
 * is tens of KB and stays well inside the serverless request body limit.
 */

import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { resolveActor } from "@/lib/api-auth";

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME ?? "";
const API_KEY    = process.env.CLOUDINARY_API_KEY ?? "";
const API_SECRET = process.env.CLOUDINARY_API_SECRET ?? "";

/** Refuse anything that isn't a small inline image, before it reaches Cloudinary. */
const MAX_DATA_URL_BYTES = 3 * 1024 * 1024;
const ALLOWED_FOLDERS = new Set(["clients", "staff", "salon", "patients"]);

/**
 * Cloudinary signs the alphabetically-sorted params that are actually sent,
 * excluding `file`, `api_key` and `resource_type`, with the secret appended.
 */
function sign(params: Record<string, string>): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(toSign + API_SECRET).digest("hex");
}

export async function POST(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    return Response.json(
      { ok: false, error: "Image hosting is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET." },
      { status: 503 },
    );
  }

  let body: { dataUrl?: string; folder?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const dataUrl = body.dataUrl ?? "";
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl)) {
    return Response.json({ ok: false, error: "Expected a JPEG, PNG or WebP data URL." }, { status: 400 });
  }
  if (dataUrl.length > MAX_DATA_URL_BYTES) {
    return Response.json({ ok: false, error: "Image is too large — it should be downscaled before upload." }, { status: 413 });
  }

  const sub = ALLOWED_FOLDERS.has(body.folder ?? "") ? body.folder! : "misc";
  // Scoped per salon so one account's uploads can never collide with another's.
  const folder = `salon-central/${actor.userId}/${sub}`;
  const timestamp = String(Math.floor(Date.now() / 1000));

  const signed = { folder, timestamp };
  const form = new FormData();
  form.set("file", dataUrl);
  form.set("api_key", API_KEY);
  form.set("folder", folder);
  form.set("timestamp", timestamp);
  form.set("signature", sign(signed));

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUD_NAME)}/image/upload`, {
      method: "POST",
      body: form,
    });
    const data = await res.json().catch(() => ({})) as {
      secure_url?: string; public_id?: string; error?: { message?: string };
    };
    if (!res.ok || !data.secure_url) {
      return Response.json(
        { ok: false, error: data.error?.message || `Cloudinary rejected the upload (HTTP ${res.status}).` },
        { status: 502 },
      );
    }
    return Response.json({ ok: true, url: data.secure_url, publicId: data.public_id });
  } catch (error) {
    console.error("[upload/image]", error);
    return Response.json({ ok: false, error: "Could not reach the image host." }, { status: 502 });
  }
}
