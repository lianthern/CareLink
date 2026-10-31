import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RENDERER_APPARMOR_PROFILE = `abi <abi/4.0>,
include <tunables/global>

profile unseen-book-renderer flags=(unconfined) {
  userns,
}
`;

export function rendererAppArmorProfileHash() {
  return createHash("sha256").update(RENDERER_APPARMOR_PROFILE).digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(RENDERER_APPARMOR_PROFILE);
}
