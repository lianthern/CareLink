import { validateSafetyEnvelope } from "./math.js";

export const DEPTH_ARTIFACT_VERSION = "unseen-depth-artifact/1";

const sha256Pattern = /^[a-f0-9]{64}$/;

export function validateDepthArtifact(artifact, panoramaRevisionId) {
  if (!artifact || artifact.schemaVersion !== DEPTH_ARTIFACT_VERSION) {
    return { ok: false, code: "depth_schema_unsupported" };
  }
  if (typeof artifact.artifactId !== "string" || !artifact.artifactId ||
      typeof artifact.sourcePanoramaRevisionId !== "string" ||
      artifact.sourcePanoramaRevisionId !== panoramaRevisionId) {
    return { ok: false, code: "depth_revision_mismatch" };
  }

  const map = artifact.depthMap;
  const width = Number(map?.width);
  const height = Number(map?.height);
  const nearMeters = Number(map?.nearMeters);
  const farMeters = Number(map?.farMeters);
  if (!map || typeof map.url !== "string" || !map.url ||
      map.encoding !== "linear-red-v1" || !sha256Pattern.test(map.sha256 || "") ||
      typeof map.width !== "number" || typeof map.height !== "number" ||
      typeof map.nearMeters !== "number" || typeof map.farMeters !== "number" ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 8 ||
      width > 4096 || height > 2048 || Math.abs(width / height - 2) > 0.01 ||
      !Number.isFinite(nearMeters) || !Number.isFinite(farMeters) ||
      nearMeters < 0.1 || farMeters <= nearMeters || farMeters > 100) {
    return { ok: false, code: "depth_map_invalid" };
  }

  const validFraction = Number(artifact.quality?.validFraction);
  if (typeof artifact.quality?.validFraction !== "number" || !Number.isFinite(validFraction) ||
      validFraction < 0.98 || validFraction > 1) {
    return { ok: false, code: "depth_quality_invalid" };
  }

  const safety = validateSafetyEnvelope(artifact.safetyEnvelope);
  if (!safety.ok) return { ok: false, code: safety.code };
  return {
    ok: true,
    value: {
      schemaVersion: DEPTH_ARTIFACT_VERSION,
      artifactId: artifact.artifactId,
      sourcePanoramaRevisionId: artifact.sourcePanoramaRevisionId,
      depthMap: {
        url: map.url,
        sha256: map.sha256,
        width,
        height,
        encoding: map.encoding,
        nearMeters,
        farMeters,
      },
      quality: { validFraction },
      safetyEnvelope: safety.value,
    },
  };
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
