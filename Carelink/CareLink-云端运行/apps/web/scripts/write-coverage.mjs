import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actionApi, actionRegistry } from "../src/generated/contracts.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const surfaceByEntry = Object.freeze({
  P01: ["/", "/open", "/support", "/privacy", "/terms"],
  P02: ["/login"],
  P03: ["/spaces", "/account"],
  P04: ["/spaces/new", "/manage/:spaceId?tab=setup"],
  P05: ["/open/:publicCampaignId", "/open#invite=:secret"],
  P06: ["/s/:spaceId/album", "/s/:spaceId/scene", "/s/:spaceId/upload"],
  P07: ["/s/:spaceId/upload", "/notices/media"],
  P08: ["/uploads/:batchId", "/uploads/:batchId/items/:itemId", "/account/uploads"],
  P09: ["/uploads/:batchId/items/:itemId", "/placements/:photoId/edit"],
  P09B: ["/uploads/:batchId/items/:itemId#optional-scene-note"],
  P10: ["/placements/:photoId/edit"],
  P11: ["/manage/:spaceId"],
  P12: ["/manage/:spaceId?tab=placement", "/placements/:photoId/edit"],
  P13: ["/manage/:spaceId?tab=review"],
  P14: ["/s/:spaceId/photos/:photoId", "/s/:spaceId/scene"],
  P15: ["/manage/:spaceId?tab=scene"],
  P16: ["/manage/:spaceId?tab=invitations", "/manage/:spaceId?tab=members"],
  P17: ["/manage/:spaceId?tab=settings", "/exports/:id", "/deletions/:id"],
  P18: ["/account", "/account/uploads", "/exports/:id", "/deletions/:id", "/reports/:id", "/appeals/:id", "/support/cases/:id"]
});

const actions = actionRegistry.actions.map((action) => {
  const entries = action.entry.split(",");
  return {
    id: action.id,
    entries,
    actor: action.actor,
    contractRoute: action.route,
    returnTarget: action.returnTarget,
    surfaces: [...new Set(entries.flatMap((entry) => surfaceByEntry[entry] || []))],
    boundary: actionApi[action.id],
    phases: actionRegistry.phases
  };
});

const entries = Object.fromEntries(Object.entries(surfaceByEntry).map(([entry, surfaces]) => [entry, {
  surfaces,
  actions: actions.filter((action) => action.entries.includes(entry)).map((action) => action.id)
}]));

const evidence = {
  generatedFrom: ["ACTION-REGISTRY.json", "ACTION-API-COVERAGE.json"],
  actionCount: actions.length,
  phaseCount: actionRegistry.phases.length,
  entryCount: Object.keys(entries).length,
  phases: actionRegistry.phases,
  entries,
  actions
};

await mkdir(resolve(root, "evidence"), { recursive: true });
await writeFile(resolve(root, "evidence/action-coverage.json"), `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`Wrote ${actions.length} actions across ${Object.keys(entries).length} entries.\n`);
