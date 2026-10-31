import test from "node:test";
import assert from "node:assert/strict";
import { createWorldLabsClient, publicOperationView, WorldLabsApiError } from "../lib/worldlabs-client.mjs";

test("single-image generation uses the documented Marble request without exposing the API key", async () => {
  let captured;
  const client = createWorldLabsClient({
    apiKey: "not-a-real-server-secret",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        operation_id: "20bffbb1-4ba7-453f-a116-93eaw1a6843e",
        done: false,
        error: null,
        metadata: { progress: { status: "IN_PROGRESS", description: "World generation in progress" } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const operation = await client.generateImageWorld({
    imageBase64: "aGVsbG8=",
    textPrompt: "保留木窗",
    displayName: "旧客厅",
    model: "marble-1.0-draft"
  });

  assert.equal(captured.url, "https://api.worldlabs.ai/marble/v1/worlds:generate");
  assert.equal(captured.options.headers["WLT-Api-Key"], "not-a-real-server-secret");
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, "marble-1.0-draft");
  assert.deepEqual(body.permission, { public: true });
  assert.deepEqual(body.world_prompt, {
    type: "image",
    is_pano: false,
    image_prompt: { source: "data_base64", data_base64: "aGVsbG8=", extension: "jpg" },
    text_prompt: "保留木窗"
  });
  assert.doesNotMatch(captured.options.body, /not-a-real-server-secret/u);
  assert.equal(operation.id, "20bffbb1-4ba7-453f-a116-93eaw1a6843e");
  assert.equal(operation.done, false);
});

test("same-scene generation uses Marble reconstruction mode for two to eight images", async () => {
  let captured;
  const client = createWorldLabsClient({
    apiKey: "not-a-real-server-secret",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        operation_id: "multi-image-operation-01",
        done: false,
        error: null
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const operation = await client.generateMultiImageWorld({
    imagesBase64: ["Zmlyc3Q=", "c2Vjb25k", "dGhpcmQ="],
    textPrompt: "保留原来的窗和桌子",
    displayName: "同一个客厅",
    model: "marble-1.0-draft"
  });

  const body = JSON.parse(captured.options.body);
  assert.equal(captured.url, "https://api.worldlabs.ai/marble/v1/worlds:generate");
  assert.deepEqual(body.tags, ["huijian", "public-demo", "same-scene"]);
  assert.equal(body.world_prompt.type, "multi-image");
  assert.equal(body.world_prompt.reconstruct_images, true);
  assert.equal(body.world_prompt.multi_image_prompt.length, 3);
  assert.deepEqual(body.world_prompt.multi_image_prompt[0], {
    content: { source: "data_base64", data_base64: "Zmlyc3Q=", extension: "jpg" }
  });
  assert.equal("azimuth" in body.world_prompt.multi_image_prompt[0], false);
  assert.doesNotMatch(captured.options.body, /not-a-real-server-secret/u);
  assert.equal(operation.id, "multi-image-operation-01");
});

test("operation responses expose only the fields needed by the public viewer", () => {
  const operation = publicOperationView({
    operation_id: "20bffbb1-4ba7-453f-a116-93eaw1a6843e",
    done: true,
    metadata: { cost: { total_credits: 230 } },
    response: {
      world_id: "dc2c65e4-68d3-4210-a01e-7a54cc9ded2a",
      display_name: "旧客厅",
      world_marble_url: "https://marble.worldlabs.ai/world/dc2c65e4-68d3-4210-a01e-7a54cc9ded2a",
      assets: {
        thumbnail_url: "https://assets.example/thumb.jpg",
        splats: {
          spz_urls: { "100k": "https://assets.example/100k.spz", "500k": "https://assets.example/500k.spz" },
          semantics_metadata: { metric_scale_factor: 1.25, ground_plane_offset: .42 }
        },
        imagery: { pano_url: "https://assets.example/pano.jpg" },
        mesh: { collider_mesh_url: "https://assets.example/collider.glb" }
      }
    }
  });

  assert.equal(operation.costCredits, 230);
  assert.equal(operation.world.splats.standard, "https://assets.example/500k.spz");
  assert.equal(operation.world.colliderUrl, "https://assets.example/collider.glb");
  assert.deepEqual(operation.world.semantics, { metricScaleFactor: 1.25, groundPlaneOffset: .42 });
  assert.equal("permission" in operation.world, false);
});

test("provider credit failures become stable application errors", async () => {
  const client = createWorldLabsClient({
    apiKey: "not-a-real-server-secret",
    fetchImpl: async () => new Response(JSON.stringify({ detail: "payment required" }), {
      status: 402,
      headers: { "content-type": "application/json" }
    })
  });
  await assert.rejects(
    client.generateImageWorld({ imageBase64: "aGVsbG8=", displayName: "test" }),
    (error) => error instanceof WorldLabsApiError && error.code === "provider_credits_low" && error.status === 402
  );
});

test('a non-JSON credit rejection retains its authoritative provider status', async () => {
  for (const body of ['', 'Payment Required', '<html>Insufficient credits</html>']) {
    const client=createWorldLabsClient({apiKey:'fixture',fetchImpl:async()=>new Response(body,{status:402})});
    await assert.rejects(client.generateImageWorld({imageBase64:'aGVsbG8=',displayName:'fixture'}),
      error=>error.code==='provider_credits_low'&&error.status===402);
  }
});

test("a generation response without an operation id is rejected", async () => {
  const client = createWorldLabsClient({
    apiKey: "not-a-real-server-secret",
    fetchImpl: async () => new Response(JSON.stringify({ done: false }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });
  await assert.rejects(
    client.generateImageWorld({ imageBase64: "aGVsbG8=", displayName: "test" }),
    (error) => error instanceof WorldLabsApiError && error.code === "provider_invalid_response"
  );
});

test("a completed operation is hydrated from the canonical World endpoint", async () => {
  const requests = [];
  const client = createWorldLabsClient({
    apiKey: "not-a-real-server-secret",
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.endsWith("/operations/operation-01")) {
        return new Response(JSON.stringify({
          operation_id: "operation-01",
          done: true,
          response: {
            world_id: "world-01",
            display_name: "",
            world_marble_url: "https://marble.worldlabs.ai/world/world-01",
            assets: { imagery: { pano_url: null } }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        world_id: "world-01",
        display_name: "真实名称",
        world_marble_url: "https://marble.worldlabs.ai/world/world-01",
        assets: { imagery: { pano_url: "https://assets.example/pano.png" } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const operation = await client.getOperation("operation-01");

  assert.deepEqual(requests, [
    "https://api.worldlabs.ai/marble/v1/operations/operation-01",
    "https://api.worldlabs.ai/marble/v1/worlds/world-01"
  ]);
  assert.equal(operation.world.name, "真实名称");
  assert.equal(operation.world.panoramaUrl, "https://assets.example/pano.png");
});
