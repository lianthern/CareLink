import { openDatabase } from "../../api/src/database.mjs";
import { FilesystemMediaStore } from "../../api/src/ports/media/filesystem-media-store.mjs";
import { DeterministicLocatorFixture } from "../../api/src/ports/locator/deterministic-locator-fixture.mjs";
import { dispatchDeletion } from "./deletion-worker.mjs";
import { dispatchOne } from "./index.mjs";

export async function dispatchLocalJobs({ databasePath, mediaRoot, keyring, limit = 100,
  deterministicLocator = false, locatorClassification = "uncertain", now = new Date().toISOString() }) {
  const db = openDatabase(databasePath);
  const mediaStore = new FilesystemMediaStore(mediaRoot);
  const locatorFixture = new DeterministicLocatorFixture({ enabled: deterministicLocator,
    classification: locatorClassification });
  try {
    const jobs = db.prepare("SELECT id,type FROM jobs WHERE status='queued' ORDER BY created_at,id LIMIT ?").all(limit);
    const results = [];
    for (const job of jobs) {
      results.push(job.type === "deletion_execution" ?
        await dispatchDeletion(db, mediaStore, job.id, { now }) :
        dispatchOne(db, job.id, { now, locatorFixture, keyring }));
    }
    return { results, runtime: { locatorMode: locatorFixture.enabled ? "deterministic_local_fixture" : "disabled",
      isProduction: false } };
  } finally {
    db.close();
  }
}
