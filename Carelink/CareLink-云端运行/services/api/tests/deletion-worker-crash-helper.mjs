import { openDatabase } from "../src/database.mjs";
import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";
import { dispatchDeletion } from "../../jobs/dispatch/deletion-worker.mjs";

const [database, mediaRoot, jobId, mode, now] = process.argv.slice(2);
const db = openDatabase(database);
const mediaStore = new FilesystemMediaStore(mediaRoot);
await dispatchDeletion(db, mediaStore, jobId, { now, leaseMs: 1_000,
  afterClaim: mode === "after-claim" ? () => process.kill(process.pid, "SIGKILL") : null,
  afterObject: mode === "after-first-object" ? ({ index }) => {
    if (index === 0) process.kill(process.pid, "SIGKILL");
  } : null });
db.close();
