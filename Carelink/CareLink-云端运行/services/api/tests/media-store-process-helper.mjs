import { FilesystemMediaStore } from "../src/ports/media/filesystem-media-store.mjs";

const [root, operation, key, encoded = ""] = process.argv.slice(2);
const store = new FilesystemMediaStore(root);
if (operation === "put") {
  const body = Buffer.from(encoded, "base64url");
  process.stdout.write(`${JSON.stringify(await store.putIfAbsent(key, body, {
    contentType: "application/octet-stream", maxBytes: 1024 * 1024
  }))}\n`);
} else if (operation === "get") {
  const object = await store.get(key, { maxBytes: 1024 * 1024 });
  process.stdout.write(`${JSON.stringify({ body: object.body.toString("base64url"), etag: object.etag })}\n`);
} else if (operation === "head") {
  process.stdout.write(`${JSON.stringify(await store.head(key))}\n`);
} else if (operation === "delete") {
  await store.delete(key);
  process.stdout.write(`${JSON.stringify(await store.head(key))}\n`);
} else if (operation === "crash-temp") {
  process.stdout.write("started\n");
  process.kill(process.pid, "SIGKILL");
}
