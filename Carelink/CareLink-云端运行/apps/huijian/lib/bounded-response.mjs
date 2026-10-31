// Bound the bytes as they arrive, before allocating/parsing the complete JSON document.
export async function readBoundedJson(response, maximumBytes, { signal, onTooLarge } = {}) {
  const tooLarge = () => {
    onTooLarge?.();
    throw Object.assign(new Error("response_too_large"), { code: "response_too_large" });
  };
  if (Number(response.headers.get("content-length")) > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response_body_missing");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) tooLarge();
      chunks.push(value);
    }
    signal?.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
