// Reads the MiniMax key from Max's existing openclaw secret store. The key never leaves this module's
// return value: it is not logged, not written to disk, and not echoed in any error message.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRETS = join(homedir(), ".config", "openclaw-secrets", "runtime-secrets.json");

export async function minimaxApiKey() {
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY;
  if (process.env.UNSEEN_PROVIDER_KEYS_ENV_ONLY === "true") throw new Error("minimax_key_missing");
  const store = JSON.parse(await readFile(SECRETS, "utf8"));
  const key = store?.authProfiles?.["minimax-cn"]?.apiKey;
  if (typeof key !== "string" || key.length < 1) throw new Error("minimax_key_missing");
  return key;
}

// World Labs is an optional experiment. A missing key must disable only /world, never the photo dialogue.
export async function worldLabsApiKey() {
  if (process.env.WORLDLABS_API_KEY) return process.env.WORLDLABS_API_KEY;
  if (process.env.WLT_API_KEY) return process.env.WLT_API_KEY;
  if (process.env.UNSEEN_PROVIDER_KEYS_ENV_ONLY === "true") return null;
  try {
    const store = JSON.parse(await readFile(SECRETS, "utf8"));
    const key = store?.authProfiles?.worldlabs?.apiKey ?? store?.authProfiles?.["world-labs"]?.apiKey;
    return typeof key === "string" && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}
