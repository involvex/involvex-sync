import {
  MAX_CLIPBOARD_IMAGE_BYTES,
  PREFERRED_CLIPBOARD_IMAGE_BYTES,
  fromBase64,
  toBase64,
} from "@involvex/protocol";

export type EncodedClipboardImage = {
  name: string;
  mimeType: string;
  data: Uint8Array;
};

/** Encode RGBA pixels to JPEG/PNG under the clipboard size cap. */
export async function encodeRgbaClipboardImage(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<EncodedClipboardImage> {
  if (width <= 0 || height <= 0) {
    throw new Error("invalid image size");
  }
  const canvas = document.createElement("canvas");
  let w = width;
  let h = height;
  const maxDim = 1920;
  if (w > maxDim || h > maxDim) {
    const scale = Math.min(maxDim / w, maxDim / h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");

  const src = document.createElement("canvas");
  src.width = width;
  src.height = height;
  const srcCtx = src.getContext("2d");
  if (!srcCtx) throw new Error("canvas unavailable");
  const needed = width * height * 4;
  const copy = new Uint8ClampedArray(needed);
  copy.set(rgba.byteLength >= needed ? rgba.subarray(0, needed) : rgba);
  srcCtx.putImageData(new ImageData(copy, width, height), 0, 0);
  ctx.drawImage(src, 0, 0, w, h);

  let quality = 0.85;
  for (let attempt = 0; attempt < 6; attempt++) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality),
    );
    if (!blob) throw new Error("jpeg encode failed");
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (
      buf.byteLength <= PREFERRED_CLIPBOARD_IMAGE_BYTES ||
      (buf.byteLength <= MAX_CLIPBOARD_IMAGE_BYTES && quality <= 0.45)
    ) {
      if (buf.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
        throw new Error("clipboard image too large after compress");
      }
      return {
        name: `clipboard-${Date.now()}.jpg`,
        mimeType: "image/jpeg",
        data: buf,
      };
    }
    quality -= 0.12;
    if (quality < 0.35) {
      // Shrink further and retry.
      w = Math.max(1, Math.round(w * 0.7));
      h = Math.max(1, Math.round(h * 0.7));
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(src, 0, 0, w, h);
      quality = 0.75;
    }
  }
  throw new Error("clipboard image too large after compress");
}

/** Re-encode an already-compressed image (PNG/JPEG bytes) under the size cap. */
export async function compressClipboardImageBytes(
  bytes: Uint8Array,
  mimeType: string,
): Promise<EncodedClipboardImage> {
  if (bytes.byteLength <= PREFERRED_CLIPBOARD_IMAGE_BYTES) {
    const ext = mimeType.includes("png") ? "png" : "jpg";
    return {
      name: `clipboard-${Date.now()}.${ext}`,
      mimeType: mimeType.includes("png") ? "image/png" : "image/jpeg",
      data: bytes,
    };
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mimeType || "image/png" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadHtmlImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(img, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return encodeRgbaClipboardImage(
      new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      canvas.width,
      canvas.height,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

export function clipboardImageFromBase64(
  dataBase64: string,
  mimeType: string,
): EncodedClipboardImage {
  const data = fromBase64(dataBase64);
  const ext = mimeType.includes("png") ? "png" : "jpg";
  return {
    name: `clipboard-${Date.now()}.${ext}`,
    mimeType,
    data,
  };
}

export { toBase64 };
