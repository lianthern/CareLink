import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DeterministicLocatorFixture,
  LOCAL_LOCATOR_FIXTURE_RELEASE_ID
} from "../../services/api/src/ports/locator/deterministic-locator-fixture.mjs";
import { dispatchOne } from "../../services/jobs/dispatch/index.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function invariant(condition, message) {
  if (!condition) throw new Error(`local_fixture_config_invalid:${message}`);
}

export async function readLocalOperableConfig(repositoryRoot, filename = "config/rc/local-operable.json") {
  const absolute = path.resolve(repositoryRoot, filename);
  const bytes = await readFile(absolute);
  const config = JSON.parse(bytes);
  invariant(config?.schema === "unseen-local-operable-config/1", "schema");
  invariant(config?.fixture?.mode === "deterministic_local_fixture" && config.fixture.isProduction === false, "mode");
  invariant(config.fixture.releaseId === LOCAL_LOCATOR_FIXTURE_RELEASE_ID, "release");
  invariant(Array.isArray(config.fixture.assets) && config.fixture.assets.length >= 3, "assets");
  invariant(new Set(config.fixture.assets.map((asset) => asset.sha256)).size === config.fixture.assets.length, "duplicate_hash");
  for (const asset of config.fixture.assets) {
    invariant(/^[a-f0-9]{64}$/.test(asset.sha256), "asset_hash");
    invariant(["same_scene_high", "uncertain", "failed"].includes(asset.classification), "classification");
    const actual = sha256(await readFile(path.resolve(repositoryRoot, asset.path)));
    invariant(actual === asset.sha256, `asset_drift:${asset.path}`);
  }
  invariant(sha256(await readFile(path.resolve(repositoryRoot, config.panorama.path))) === config.panorama.sha256,
    "panorama_drift");
  return { config, configPath: absolute, configSha256: sha256(bytes) };
}

export function createDeterministicLocator(config, { candidateDirections = false } = {}) {
  invariant(config?.fixture?.releaseId === LOCAL_LOCATOR_FIXTURE_RELEASE_ID, "release");
  const locator = new DeterministicLocatorFixture({ enabled: true, classification: config.fixture.unknownInputClassification });
  if (candidateDirections === true) {
    const outcome = locator.outcome.bind(locator);
    locator.outcome = (...args) => {
      const result = outcome(...args);
      return result?.classification === "uncertain" ? { ...result,
        candidates: [{ yaw: 25, pitch: 0, confidence: 0.5 }, { yaw: -65, pitch: 0, confidence: 0.4 }],
        locatorProvenance: { ...result.locatorProvenance, syntheticCandidateDirections: true }
      } : result;
    };
  }
  return locator;
}

export function projectLocalFixtureSceneContext(context) {
  if (!context?.placement || context.placement.pitchDeg != null) return context;
  return { ...context, placement: { ...context.placement, pitchDeg: 0 } };
}

export function createLocalFixtureWorker({ api, config, configSha256, locatorFixture, onDispatch = () => {},
  onError = () => {} }) {
  const fixtureByHash = new Map(config.fixture.assets.map((asset) => [asset.sha256, asset]));
  let timer = null;
  let draining = false;
  let stopped = false;

  function placementInput(job) {
    const refs = JSON.parse(job.input_refs_json);
    const asset = api.db.prepare(`SELECT a.raw_sha256 FROM photos p JOIN assets a ON a.id=p.asset_id
      WHERE p.id=?`).get(refs.photoId);
    const selected = fixtureByHash.get(asset?.raw_sha256) ?? {
      sha256: asset?.raw_sha256 ?? null,
      fixtureInput: config.fixture.unknownInputClassification,
      classification: config.fixture.unknownInputClassification,
      outputState: "needs_confirmation",
      displayState: "需要确认"
    };
    return { refs, selected };
  }

  async function drain() {
    if (draining || stopped) return [];
    draining = true;
    const dispatched = [];
    try {
      for (let count = 0; count < 100; count += 1) {
        const job = api.db.prepare(`SELECT * FROM jobs WHERE status='queued'
          AND type IN ('panorama_validation','photo_validation','photo_placement','export_generation')
          ORDER BY created_at,id LIMIT 1`).get();
        if (!job) break;
        const now = new Date().toISOString();
        let fixture = null;
        let result;
        if (job.type === "photo_placement") {
          fixture = placementInput(job);
          result = dispatchOne(api.db, job.id, { now, keyring: api.keyring, locatorFixture,
            fixtureClassification: fixture.selected.classification });
        } else {
          result = dispatchOne(api.db, job.id, { now, keyring: api.keyring, locatorFixture });
        }
        const record = {
          dispatchedAt: now,
          requestId: job.id,
          jobId: job.id,
          jobType: job.type,
          status: result.status
        };
        if (fixture) Object.assign(record, {
          photoId: fixture.refs.photoId,
          panoramaRevisionId: fixture.refs.panoramaRevisionId,
          photoRawSha256: fixture.selected.sha256,
          fixtureInput: fixture.selected.fixtureInput,
          fixtureClassification: fixture.selected.classification,
          displayState: fixture.selected.displayState,
          outputState: result.placementState ?? fixture.selected.outputState,
          fixtureReleaseId: LOCAL_LOCATOR_FIXTURE_RELEASE_ID,
          fixtureConfigSha256: configSha256,
          locatorMode: "deterministic_local_fixture",
          isProduction: false
        });
        dispatched.push(record);
        onDispatch(record);
      }
      return dispatched;
    } catch (error) {
      stopped = true;
      onError(error);
      throw error;
    } finally {
      draining = false;
    }
  }

  return {
    locatorFixture,
    drain,
    start() {
      invariant(!timer, "worker_already_started");
      stopped = false;
      timer = setInterval(() => { void drain().catch(() => {}); }, 150);
      timer.unref?.();
      void drain().catch(() => {});
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      while (draining) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
}
