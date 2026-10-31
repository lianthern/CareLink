import { solveLocalVisualChallenge } from "./local-client.js";
import { solveVerificationChallenge as solvePowChallenge } from "../otp-pow/client.js";

// Provider-neutral browser coordinator. The server decides which descriptor is returned;
// each client implementation returns only the proof fields allowlisted for AUTH.REQUEST_CODE.
export async function solveVerificationChallenge(challenge, options = {}) {
  if (challenge?.mode !== "pow" || !challenge.visual) return solvePowChallenge(challenge, options);
  const selection = await solveLocalVisualChallenge(challenge, options);
  return { ...await solvePowChallenge(challenge, options), verificationSelection: selection };
}
