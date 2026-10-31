// Read credentials only from the process environment. The value is never logged or written by this module.
export async function minimaxApiKey() {
  const value = process.env.MINIMAX_API_KEY;
  if (typeof value !== "string" || value.trim().length < 1) throw new Error("minimax_key_missing");
  return value;
}
