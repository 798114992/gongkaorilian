import assert from "node:assert/strict";
import test from "node:test";

import { audioReferencePolicy, managedMediaAssetId, mediaUrlForAsset } from "../app/api/app/media-policy.mjs";

const assetId = "123e4567-e89b-42d3-a456-426614174000";

test("only a same-origin managed media route is accepted", () => {
  assert.equal(mediaUrlForAsset(assetId), `/api/app?media=${assetId}`);
  assert.equal(managedMediaAssetId(`/api/app?media=${assetId}`), assetId);
  assert.equal(managedMediaAssetId(`/audio/demo.wav`), null);
  assert.equal(managedMediaAssetId(`https://cdn.example.com/api/app?media=${assetId}`), null);
  assert.equal(managedMediaAssetId(`/api/app?media=${assetId}&download=1`), null);
  assert.equal(managedMediaAssetId(`/api/app?media=not-a-uuid`), null);
});

test("audio access must match content access and free promotion is explicit", () => {
  const memberAsset = { id: assetId, status: "active", contentType: "audio/mpeg", accessLevel: "member" };
  const freeAsset = { ...memberAsset, accessLevel: "free" };
  const payload = { audioUrl: `/api/app?media=${assetId}` };

  assert.deepEqual(audioReferencePolicy("audio_track", "member", payload, memberAsset), {
    ok: true, assetId, promote: false,
  });
  assert.deepEqual(audioReferencePolicy("audio_track", "free", payload, memberAsset), {
    ok: true, assetId, promote: true,
  });
  assert.deepEqual(audioReferencePolicy("audio_track", "member", payload, freeAsset), {
    ok: false, code: "MEDIA_ACCESS_MISMATCH",
  });
  assert.deepEqual(audioReferencePolicy("audio_track", "member", { audioUrl: "/audio/demo.wav" }, null), {
    ok: false, code: "MANAGED_MEDIA_REQUIRED",
  });
});
