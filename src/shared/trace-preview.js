const CHUNK_SIZE = 16;

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function tracePreview(value) {
  const raw = String(value ?? "");
  return {
    chars: [...raw].length,
    sha256: await sha256(raw),
  };
}

export async function tracePreviewUnits(units) {
  return Promise.all(
    (Array.isArray(units) ? units : []).map(async (unit, index) => ({
      id: String(unit?.id ?? `P${index}`),
      ...(await tracePreview(unit?.text ?? "")),
    })),
  );
}

export function emitPreviewChunks(callback, event, items, extra = {}) {
  if (typeof callback !== "function") return;
  const values = Array.isArray(items) ? items : [];
  const chunks = Math.max(1, Math.ceil(values.length / CHUNK_SIZE));
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    callback(event, {
      ...extra,
      chunk: chunk + 1,
      chunks,
      items: values.slice(chunk * CHUNK_SIZE, (chunk + 1) * CHUNK_SIZE),
    });
  }
}
