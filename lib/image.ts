/**
 * Client-side image intake for profile photos.
 *
 * Photos are hosted on Cloudinary and the record stores only the resulting URL.
 * The browser still downscales first — a raw 3-8 MB phone photo would be a slow
 * upload on salon wifi and is far larger than any avatar needs — so what reaches
 * the server is a compact JPEG, comfortably inside the request body limit.
 *
 * Records written before this existed hold an inline `data:` URL instead. Both
 * render identically in an <img>, so nothing needs migrating; those simply stay
 * inline until the photo is next changed.
 */

/**
 * Longest edge, in pixels, of an uploaded photo. Cloudinary stores the result,
 * so this is about upload weight and the size these avatars actually render at,
 * not about a storage budget: 640 keeps a client photo usable on a detail page
 * while still being a ~60-90 KB upload from a phone camera.
 */
const MAX_EDGE_PX = 640;
const JPEG_QUALITY = 0.82;

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export class ImageTooLargeError extends Error {}
export class ImageDecodeError extends Error {}

/**
 * Reads an image file and returns a downscaled JPEG data URL.
 *
 * Rejects rather than silently storing anything it can't decode, so a PDF or a
 * corrupt file surfaces as an error in the form instead of a broken <img>.
 */
export class ImageUploadError extends Error {}

/**
 * Downscales `file` and uploads it, returning the hosted URL to store.
 *
 * Upload failures throw rather than falling back to an inline data URL: silently
 * storing the image locally would look identical in the UI while quietly
 * defeating the point of hosting it, and the misconfiguration would only surface
 * much later as bloated sync payloads.
 */
/** @param maxEdge clinical photos pass a larger size so before/after detail survives. */
export async function uploadImage(file: File, folder: "clients" | "staff" | "salon" | "patients", maxEdge = MAX_EDGE_PX): Promise<string> {
  const dataUrl = await fileToResizedDataUrl(file, maxEdge);
  let res: Response;
  try {
    res = await fetch("/api/upload/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl, folder }),
    });
  } catch {
    throw new ImageUploadError("Couldn't reach the server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({})) as { ok?: boolean; url?: string; error?: string };
  if (!data.ok || !data.url) {
    throw new ImageUploadError(data.error || "Upload failed. Please try again.");
  }
  return data.url;
}

/**
 * `maxEdge`/`quality` default to profile-photo sizing; a payment screenshot
 * passes larger values so its transaction ID stays legible.
 */
export async function fileToResizedDataUrl(file: File, maxEdge = MAX_EDGE_PX, quality = JPEG_QUALITY): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new ImageDecodeError("That file isn't an image. Pick a JPG or PNG.");
  }
  // Guard before decoding: a huge file would otherwise be fully read into
  // memory just to be rejected, and on a till PC that is a visible freeze.
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ImageTooLargeError("That image is over 15 MB. Pick a smaller one.");
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new ImageDecodeError("Could not read that file."));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new ImageDecodeError("That image could not be opened."));
    el.src = dataUrl;
  });

  const longest = Math.max(img.width, img.height);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImageDecodeError("This browser could not process the image.");
  // JPEG has no alpha, so a transparent PNG would otherwise composite onto black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  return canvas.toDataURL("image/jpeg", quality);
}
