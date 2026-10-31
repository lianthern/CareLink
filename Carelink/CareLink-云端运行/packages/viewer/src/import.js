import { validateDepthArtifact } from './depth.js';

const fail = code => { throw Object.assign(new Error(code), { code, status: 422 }); };
const basename = value => String(value || '').split(/[\\/]/).at(-1);
const dimensions = (value, maxWidth = 4096) => Number.isInteger(value?.width) && Number.isInteger(value?.height) &&
  value.width >= 16 && value.height >= 8 && value.width <= maxWidth && value.height * 2 === value.width;

// Pure contract shared byte-for-byte by App and canonical. No URL from an
// imported manifest is fetched: all descriptors are bound to selected bytes.
export function parseDepthImport(meta, { panorama, depth, panoramaName = '', panoramaSha256, depthSha256 } = {}) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail('depth_metadata_invalid');
  if (!dimensions(panorama, 8192) || !dimensions(depth)) fail('depth_dimensions_invalid');
  if (meta.schemaVersion === 'unseen-depth-import/1') {
    if (panoramaSha256 && meta.panoramaSha256 !== panoramaSha256 || depthSha256 && meta.depthSha256 !== depthSha256) fail('depth_source_mismatch');
    return parseDepthImport(meta.metadata, { panorama, depth, panoramaName, panoramaSha256, depthSha256 });
  }
  if (!meta.schemaVersion && meta.model === 'DAP' && meta.convention === 'near_small') {
    if (!Number.isFinite(meta.min) || !Number.isFinite(meta.max) || meta.min < 0 || meta.max <= meta.min || meta.max > 100 ||
        meta.width !== depth.width || meta.height !== depth.height) fail('depth_metadata_invalid');
    if (!Array.isArray(meta.source_resolution) || meta.source_resolution[0] !== panorama.width || meta.source_resolution[1] !== panorama.height ||
        basename(meta.source_image) !== basename(panoramaName)) fail('depth_source_mismatch');
    return { encoding: 'legacy-dap-minmax-v1', width: depth.width, height: depth.height,
      near: meta.min, far: meta.max, scale: 6 / (meta.min + meta.max), strength: .12, maxRadius: .22,
      metadata: { min: meta.min, max: meta.max, width: depth.width, height: depth.height, model: 'DAP', convention: 'near_small',
        source_image: basename(panoramaName), source_resolution: [panorama.width, panorama.height] } };
  }
  const precursor = meta.schemaVersion === 'unseen-depth-artifact-precursor/1';
  const artifact = precursor ? { schemaVersion: 'unseen-depth-artifact/1', artifactId: 'import', sourcePanoramaRevisionId: 'import',
    depthMap: { url: 'selected-depth', encoding: meta.encoding, sha256: meta.pngSha256 || meta.sha256, width: meta.width, height: meta.height,
      nearMeters: meta.nearMeters, farMeters: meta.farMeters }, quality: meta.quality, safetyEnvelope: meta.safetyEnvelope } : meta;
  const parsed = validateDepthArtifact(artifact, artifact.sourcePanoramaRevisionId);
  if (!parsed.ok) fail(parsed.code);
  const value = parsed.value, map = value.depthMap;
  if (map.width !== depth.width || map.height !== depth.height || depthSha256 && map.sha256 !== depthSha256) fail('depth_source_mismatch');
  // Precursors bind to their original panorama digest. Full canonical bundles
  // must export that digest as well; a revision ID alone cannot prove pairing.
  const sourceHash = meta.sourcePanoramaSha256 || meta.source?.sha256;
  if (panoramaSha256 && sourceHash !== panoramaSha256 && !(precursor && !sourceHash && basename(meta.sourceImage) === basename(panoramaName) &&
      meta.sourceResolution?.[0] === panorama.width && meta.sourceResolution?.[1] === panorama.height)) fail('depth_source_mismatch');
  return { encoding: 'linear-red-v1', width: map.width, height: map.height, near: map.nearMeters, far: map.farMeters,
    scale: 1, strength: .12, maxRadius: value.safetyEnvelope.absoluteMaxRadiusMeters, safetyEnvelope: value.safetyEnvelope,
    metadata: { ...value, depthMap: { ...map, url: 'selected-depth' }, sourcePanoramaSha256: panoramaSha256 || sourceHash } };
}
