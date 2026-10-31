const DEFAULT_BASE_URL = "https://api.worldlabs.ai/marble/v1";

export class WorldLabsApiError extends Error {
  constructor(code, status, cause) {
    super(code, { cause });
    this.name = "WorldLabsApiError";
    this.code = code;
    this.status = status;
  }
}

function cleanHttpsUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function publicWorldView(world) {
  if (!world || typeof world !== "object") return null;
  const assets = world.assets && typeof world.assets === "object" ? world.assets : {};
  const splats = assets.splats && typeof assets.splats === "object" ? assets.splats : {};
  const urls = splats.spz_urls && typeof splats.spz_urls === "object" ? splats.spz_urls : {};
  const semantics = splats.semantics_metadata && typeof splats.semantics_metadata === "object"
    ? splats.semantics_metadata
    : {};
  const worldId = typeof world.world_id === "string" ? world.world_id : world.id;
  if (typeof worldId !== "string" || !worldId) return null;

  return {
    id: worldId,
    name: typeof world.display_name === "string" ? world.display_name : "照片生成的世界",
    marbleUrl: cleanHttpsUrl(world.world_marble_url),
    thumbnailUrl: cleanHttpsUrl(assets.thumbnail_url),
    panoramaUrl: cleanHttpsUrl(assets.imagery?.pano_url),
    colliderUrl: cleanHttpsUrl(assets.mesh?.collider_mesh_url),
    splats: {
      preview: cleanHttpsUrl(urls["100k"]),
      standard: cleanHttpsUrl(urls["500k"]),
      full: cleanHttpsUrl(urls.full_res)
    },
    semantics: {
      metricScaleFactor: finiteNumber(semantics.metric_scale_factor),
      groundPlaneOffset: finiteNumber(semantics.ground_plane_offset)
    }
  };
}

export function publicOperationView(operation) {
  if (!operation || typeof operation !== "object") throw new WorldLabsApiError("provider_invalid_response", 502);
  const progress = operation.metadata?.progress;
  return {
    id: typeof operation.operation_id === "string" ? operation.operation_id : null,
    done: operation.done === true,
    progress: {
      status: typeof progress?.status === "string" ? progress.status : null,
      description: typeof progress?.description === "string" ? progress.description : null
    },
    error: operation.error
      ? {
          code: typeof operation.error.code === "number" ? operation.error.code : null,
          message: typeof operation.error.message === "string" ? operation.error.message.slice(0, 240) : "生成没有完成"
        }
      : null,
    costCredits: finiteNumber(operation.metadata?.cost?.total_credits ?? operation.cost?.total_credits),
    world: publicWorldView(operation.response)
  };
}

function providerErrorCode(status) {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 402) return "provider_credits_low";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_rejected_request";
}

export function createWorldLabsClient({ apiKey, fetchImpl = fetch, baseUrl = DEFAULT_BASE_URL } = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw new Error("worldlabs_key_missing");

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/${path}`, {
        ...options,
        headers: {
          "content-type": "application/json",
          "WLT-Api-Key": apiKey,
          ...options.headers
        },
        signal: options.signal ?? AbortSignal.timeout(45_000)
      });
    } catch (error) {
      throw new WorldLabsApiError(error?.name === "TimeoutError" ? "provider_timeout" : "provider_unavailable", 502, error);
    }

    // Admission status is authoritative even if an error page is empty or not JSON.
    if (!response.ok) throw new WorldLabsApiError(providerErrorCode(response.status), response.status);
    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new WorldLabsApiError("provider_invalid_response", 502, error);
    }
    return body;
  }

  async function startGeneration({ worldPrompt, displayName, model, tags }) {
    const operation = await request("worlds:generate", {
      method: "POST",
      body: JSON.stringify({
        display_name: displayName,
        model,
        permission: { public: true },
        tags,
        world_prompt: worldPrompt
      }),
      signal: AbortSignal.timeout(90_000)
    });
    const view = publicOperationView(operation);
    if (!view.id) throw new WorldLabsApiError("provider_invalid_response", 502);
    return view;
  }

  return {
    async generateImageWorld({ imageBase64, isPano = false, textPrompt = null, displayName, model = "marble-1.0-draft" }) {
      return startGeneration({
        displayName,
        model,
        tags: ["huijian", "public-demo", "single-image"],
        worldPrompt: {
          type: "image",
          is_pano: isPano,
          image_prompt: { source: "data_base64", data_base64: imageBase64, extension: "jpg" },
          text_prompt: textPrompt || null
        }
      });
    },

    async generateMultiImageWorld({ imagesBase64, textPrompt = null, displayName, model = "marble-1.0-draft" }) {
      return startGeneration({
        displayName,
        model,
        tags: ["huijian", "public-demo", "same-scene"],
        worldPrompt: {
          type: "multi-image",
          multi_image_prompt: imagesBase64.map((dataBase64) => ({
            content: { source: "data_base64", data_base64: dataBase64, extension: "jpg" }
          })),
          reconstruct_images: true,
          text_prompt: textPrompt || null
        }
      });
    },

    async getWorld(worldId) {
      const world = publicWorldView(await request(`worlds/${encodeURIComponent(worldId)}`));
      if (!world) throw new WorldLabsApiError("provider_invalid_response", 502);
      return world;
    },

    async getOperation(operationId) {
      const operation = publicOperationView(await request(`operations/${encodeURIComponent(operationId)}`));
      // A completed Operation can be returned before imagery/collider metadata has propagated
      // into operation.response. The canonical World endpoint is hydrated at that point.
      if (operation.done && !operation.error && operation.world?.id) {
        operation.world = await this.getWorld(operation.world.id);
      }
      return operation;
    }
  };
}
