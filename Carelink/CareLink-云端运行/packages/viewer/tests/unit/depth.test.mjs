import test from "node:test";
import assert from "node:assert/strict";
import { validateDepthArtifact } from "../../src/public/index.js";

function artifact(overrides = {}) {
  return {
    schemaVersion: "unseen-depth-artifact/1",
    artifactId: "depth-a",
    sourcePanoramaRevisionId: "pano-a",
    depthMap: {
      url: "/depth.png",
      sha256: "a".repeat(64),
      width: 1024,
      height: 512,
      encoding: "linear-red-v1",
      nearMeters: 0.5,
      farMeters: 12,
    },
    quality: { validFraction: 0.99 },
    safetyEnvelope: {
      schemaVersion: "unseen-polar-safety-envelope/1",
      absoluteMaxRadiusMeters: 0.4,
      directions: Array.from({ length: 8 }, (_, index) => ({
        yawDeg: index * 45,
        allowedRadiusMeters: 0.1 + index * 0.01,
      })),
    },
    ...overrides,
  };
}

test("only a versioned, revision-bound, quality-gated artifact enables depth", () => {
  const valid = validateDepthArtifact(artifact(), "pano-a");
  assert.equal(valid.ok, true);
  assert.equal(valid.value.depthMap.encoding, "linear-red-v1");
  assert.equal(valid.value.safetyEnvelope.directions.length, 8);
});

test("bad revision, dimensions, quality and safety all fail closed", () => {
  assert.equal(validateDepthArtifact(artifact(), "pano-b").code, "depth_revision_mismatch");
  assert.equal(validateDepthArtifact(artifact({
    depthMap: { ...artifact().depthMap, width: 1000 },
  }), "pano-a").code, "depth_map_invalid");
  assert.equal(validateDepthArtifact(artifact({ quality: { validFraction: 0.5 } }), "pano-a").code, "depth_quality_invalid");
  assert.equal(validateDepthArtifact(artifact({ quality: { validFraction: "0.99" } }), "pano-a").code, "depth_quality_invalid");
  assert.equal(validateDepthArtifact(artifact({
    safetyEnvelope: { ...artifact().safetyEnvelope, absoluteMaxRadiusMeters: 0.9 },
  }), "pano-a").code, "safety_absolute_radius_invalid");
});
