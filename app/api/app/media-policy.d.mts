export type MediaAccess = "free" | "member";
export type MediaPolicyAsset = {
  id: string;
  status: string;
  contentType: string;
  accessLevel: MediaAccess;
};
export type AudioReferencePolicyResult =
  | { ok: true; assetId: string | null; promote: boolean }
  | { ok: false; code: "AUDIO_ASSET_REQUIRED" | "MANAGED_MEDIA_REQUIRED" | "MEDIA_ASSET_MISSING" | "AUDIO_ASSET_TYPE_INVALID" | "MEDIA_ACCESS_MISMATCH" };
export function mediaUrlForAsset(assetId: unknown): string;
export function managedMediaAssetId(value: unknown): string | null;
export function audioReferencePolicy(
  contentType: string,
  contentAccess: MediaAccess,
  payload: Record<string, unknown>,
  asset: MediaPolicyAsset | null,
): AudioReferencePolicyResult;
