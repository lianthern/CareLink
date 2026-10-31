import { assert, ApiError } from './errors.mjs';
import { sha256, stableJson } from './util.mjs';

// Audited local Bridge snapshot. These checks describe an incompatibility, not an enabled worker.
export const SCENE_BRIDGE_CONTRACT = Object.freeze({ revision: '89cd244',
  productionAdapterSha256: 'd2a3e87e913854998bae9f80d5a250ff9f64cb64541994a2041a6d567e443594',
  jobSchemaSha256: 'df90886eedf072050f7da72826fc990a68731d3cf47a7908a366d90a2ff22e0b',
  productionContractSha256: 'd87e7f3fff9f3fe957ad000113e09532bab7728b4a2a38bcfdf0ea38fc528168',
  productionConnected: false });

export function captureBridgeEnvelope(manifest, manifestSha256, current) {
  assert(manifest?.schema === 'unseen-capture-manifest/1' && sha256(stableJson(manifest)) === manifestSha256,
    'capture_manifest_invalid', 422);
  assert(manifest.accountId === current.accountId && manifest.spaceId === current.spaceId && manifest.jobId === current.jobId &&
    manifest.sceneRevisionId === current.sceneRevisionId, 'capture_binding_invalid', 422);
  assert(manifest.sourceSpaceVersion === current.spaceVersion && manifest.sourceSceneVersion === current.sceneVersion,
    'capture_target_stale', 409);
  return { schema: 'unseen-scene-bridge-envelope/1', ...SCENE_BRIDGE_CONTRACT, manifest, manifestSha256,
    status: 'contract_pending', processingAvailable: false, missingContracts: [
      'authenticated_account_space_revision_manifest_binding', 'three_input_mode_dispatch_and_probe',
      'private_chunk_download_and_workspace_materialization', 'renewable_multi_hour_lease_and_heartbeat',
      'resumable_artifact_commit_abort_and_sha256_binding', 'revocation_retention_and_deletion',
      'preview_acceptance_before_quality_training' ] };
}

export class DisabledSceneWorkerBridgeAdapter {
  registration(manifest, manifestSha256, current) {
    captureBridgeEnvelope(manifest, manifestSha256, current);
    throw new ApiError('scene_worker_contract_pending', 503);
  }
  acceptResult(manifest, manifestSha256, current, result) {
    captureBridgeEnvelope(manifest, manifestSha256, current);
    assert(result && result.accountId === manifest.accountId && result.spaceId === manifest.spaceId &&
      result.sceneRevisionId === manifest.sceneRevisionId && result.jobId === manifest.jobId &&
      result.manifestSha256 === manifestSha256 && stableJson(result.inputFiles) === stableJson(manifest.files.map(f => ({ fileId: f.fileId, sha256: f.sha256 }))),
    'scene_worker_result_binding_invalid', 422);
    // Even matching client JSON cannot establish a lease, artifact ownership, geometric quality or production authority.
    throw new ApiError('scene_worker_contract_pending', 503);
  }
}
