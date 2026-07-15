const MEDIA_ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function mediaUrlForAsset(assetId) {
  return MEDIA_ASSET_ID.test(String(assetId ?? "")) ? `/api/app?media=${assetId}` : "";
}

export function managedMediaAssetId(value) {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("/")) return null;
  try {
    const url = new URL(raw, "https://gongkao-rilian.invalid");
    if (url.origin !== "https://gongkao-rilian.invalid" || url.pathname !== "/api/app" || url.hash) return null;
    const keys = Array.from(url.searchParams.keys());
    if (keys.length !== 1 || keys[0] !== "media") return null;
    const assetId = url.searchParams.get("media") ?? "";
    return MEDIA_ASSET_ID.test(assetId) ? assetId : null;
  } catch {
    return null;
  }
}

export function audioReferencePolicy(contentType, contentAccess, payload, asset) {
  const rawAudioUrl = String(payload?.audioUrl ?? "").trim();
  if (contentType !== "audio_track" && !rawAudioUrl) return { ok: true, assetId: null, promote: false };
  if (!rawAudioUrl) return { ok: false, code: "AUDIO_ASSET_REQUIRED" };
  const assetId = managedMediaAssetId(rawAudioUrl);
  if (!assetId) return { ok: false, code: "MANAGED_MEDIA_REQUIRED" };
  if (!asset || asset.id !== assetId || asset.status !== "active") return { ok: false, code: "MEDIA_ASSET_MISSING" };
  if (!String(asset.contentType ?? "").toLowerCase().startsWith("audio/")) return { ok: false, code: "AUDIO_ASSET_TYPE_INVALID" };
  if (asset.accessLevel === contentAccess) return { ok: true, assetId, promote: false };
  if (contentAccess === "free" && asset.accessLevel === "member") return { ok: true, assetId, promote: true };
  return { ok: false, code: "MEDIA_ACCESS_MISMATCH" };
}
