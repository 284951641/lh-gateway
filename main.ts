// main.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const secretsCache = new Map<string, { base_url: string; api_key: string }>();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-provider, x-path",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const supabaseConfig = () => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    throw new Error("Missing Supabase environment variables");
  }
  return { supabaseUrl, supabaseAnonKey, supabaseServiceKey };
};


type ApiVideoModel = {
  model_id: string;
  name?: string;
  cost?: number;
  config?: any;
};

const getApiAccessConfig = (model: ApiVideoModel) => model.config?.api_access || {};

const isPublicApiVideoModel = (model: ApiVideoModel) => getApiAccessConfig(model).enabled === true;

const getPublicApiModelName = (model: ApiVideoModel) =>
  String(getApiAccessConfig(model).display_name || model.name || model.model_id);

const getPublicApiModelDescription = (model: ApiVideoModel) =>
  String(getApiAccessConfig(model).description || "");

const formatVideoModelPriceLabel = (model: ApiVideoModel) => {
  const strategy = model.config?.pricing_strategy;
  const fallbackCost = Number(model.cost || 0) || 0;

  if (strategy?.type === "per_second") {
    const rates = strategy.rates && typeof strategy.rates === "object"
      ? Object.values(strategy.rates).map(Number).filter(Number.isFinite)
      : [];
    const rate = rates.length
      ? Math.min(...rates) === Math.max(...rates)
        ? `${Math.min(...rates)}`
        : `${Math.min(...rates)}-${Math.max(...rates)}`
      : String(Number(strategy.rate_per_second || strategy.rate || fallbackCost) || fallbackCost);
    return `${rate} 算力/秒`;
  }

  if (strategy?.type === "matrix" && strategy.matrix) {
    const costs = Object.values(strategy.matrix)
      .flatMap((durations: any) => Object.values(durations || {}).map(Number))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (costs.length > 0) {
      const min = costs[0];
      const max = costs[costs.length - 1];
      return min === max ? `${min} 算力/次` : `${min}-${max} 算力/次`;
    }
  }

  return `${fallbackCost} 算力/次`;
};

const fetchPublicApiVideoModels = async (supabaseAdmin: any) => {
  const { data, error } = await supabaseAdmin
    .from("model_costs")
    .select("model_id,name,cost,config,sort_order")
    .eq("category", "video")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) throw error;
  return ((data || []) as ApiVideoModel[]).filter(isPublicApiVideoModel);
};

async function resolvePublicApiModelId(supabaseAdmin: any, requestedModel: string) {
  const modelName = String(requestedModel || "").trim();
  if (!modelName) return "";

  const models = await fetchPublicApiVideoModels(supabaseAdmin);
  const matched = models.find((model) => getPublicApiModelName(model) === modelName);
  return matched?.model_id || "";
}

async function handleModelsApi(req: Request) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const { supabaseUrl, supabaseServiceKey } = supabaseConfig();
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const models = await fetchPublicApiVideoModels(supabaseAdmin);
  return jsonResponse({
    object: "list",
    data: models.map((model) => ({
      id: getPublicApiModelName(model),
      object: "model",
      created: 0,
      owned_by: "linghui",
      type: "video",
      description: getPublicApiModelDescription(model),
      price: formatVideoModelPriceLabel(model),
    })),
  });
}
const readBearerToken = (req: Request) => {
  const header = req.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
};


const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_SIGN_FIELDS = new Set(["contentType", "size"]);
const UPLOAD_WORKER_URL = Deno.env.get("UPLOAD_WORKER_URL") || "https://sedance.top";
const UPLOAD_PUBLIC_URL = Deno.env.get("UPLOAD_PUBLIC_URL") || "https://assets.sedance.top";

const uploadExtByType: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
};

const base64Url = (input: string | Uint8Array) => {
  const text = typeof input === "string" ? input : String.fromCharCode(...input);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const signUploadPayload = async (payload: string) => {
  const secret = Deno.env.get("UPLOAD_SIGNING_SECRET") || "";
  if (!secret) throw new Error("Missing UPLOAD_SIGNING_SECRET");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64Url(new Uint8Array(sig));
};

async function handleUploadSignApi(req: Request) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const apiKey = readBearerToken(req);
  if (!apiKey) return jsonResponse({ error: "Missing API key" }, 401);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const unknownFields = Object.keys(body).filter((field) => !UPLOAD_SIGN_FIELDS.has(field));
  if (unknownFields.length) {
    return jsonResponse({ error: `Unsupported request fields: ${unknownFields.join(", ")}` }, 400);
  }

  const contentType = typeof body.contentType === "string"
    ? body.contentType.split(";")[0].toLowerCase()
    : "";
  const size = body.size;
  const ext = uploadExtByType[contentType];

  if (!ext) return jsonResponse({ error: "Unsupported file type" }, 415);
  if (!Number.isSafeInteger(size) || size <= 0 || size > UPLOAD_MAX_BYTES) {
    return jsonResponse({ error: "单个文件最大支持 20MB" }, 413);
  }

  const { supabaseUrl, supabaseServiceKey } = supabaseConfig();
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabaseAdmin.rpc("api_validate_upload_key", {
    p_api_key: apiKey,
  });
  const userId = typeof data === "string" ? data : Array.isArray(data) ? data[0]?.user_id : data?.user_id;
  if (error || !userId) return jsonResponse({ error: "Invalid API key" }, 401);

  const key = `api-uploads/${userId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const payload = base64Url(JSON.stringify({
    key,
    contentType,
    maxSize: size,
    exp: Date.now() + 5 * 60 * 1000,
  }));
  const token = `${payload}.${await signUploadPayload(payload)}`;

  return jsonResponse({
    uploadUrl: `${UPLOAD_WORKER_URL}/upload?token=${token}`,
    publicUrl: `${UPLOAD_PUBLIC_URL}/${key}`,
    expiresIn: 300,
  });
}
const statusFromRpcError = (message = "") => {
  if (/invalid api key|unauthorized|权限|key/i.test(message)) return 401;
  if (/余额不足/i.test(message)) return 402;
  if (/不存在|停用|不能为空|仅支持|参数|prompt|model/i.test(message)) return 400;
  return 500;
};

const VIDEO_REQUEST_FIELDS = new Set([
  "model",
  "prompt",
  "aspectRatio",
  "aspect_ratio",
  "resolution",
  "duration",
  "modeType",
  "referenceMode",
  "assets",
  "webhookUrl",
  "webhook_url",
]);
const VIDEO_ASSET_FIELDS = new Set(["type", "url", "role"]);
const VIDEO_MODE_TYPES = new Set(["text2video", "image2video", "frames2video"]);
const VIDEO_REFERENCE_MODES = new Set(["multimodal", "first_last_frame"]);
const VIDEO_ASSET_ROLES = {
  image: new Set(["reference", "first_frame", "last_frame"]),
  video: new Set(["reference"]),
  audio: new Set(["audio"]),
} as const;

const isHttpsUrl = (value: string) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const parseVideoRequest = (body: unknown) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid JSON body" };
  }

  const request = body as Record<string, unknown>;
  const unknownFields = Object.keys(request).filter((field) => !VIDEO_REQUEST_FIELDS.has(field));
  if (unknownFields.length) {
    return { error: `Unsupported request fields: ${unknownFields.join(", ")}` };
  }

  if (typeof request.model !== "string" || !request.model.trim()) {
    return { error: "model must be a non-empty string" };
  }
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    return { error: "prompt must be a non-empty string" };
  }

  const aspectRatio = request.aspectRatio !== undefined
    ? request.aspectRatio
    : request.aspect_ratio;
  const webhookUrl = request.webhookUrl !== undefined
    ? request.webhookUrl
    : request.webhook_url;

  for (const [field, value] of [
    ["aspectRatio", aspectRatio],
    ["resolution", request.resolution],
    ["duration", request.duration],
    ["modeType", request.modeType],
    ["referenceMode", request.referenceMode],
    ["webhookUrl", webhookUrl],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      return { error: `${field} must be a non-empty string` };
    }
  }

  if (typeof webhookUrl === "string" && !isHttpsUrl(webhookUrl.trim())) {
    return { error: "webhookUrl must be a valid HTTPS URL" };
  }

  const rawAssets = request.assets ?? [];
  if (!Array.isArray(rawAssets)) return { error: "assets must be an array" };

  const assets: Array<{ type: "image" | "video" | "audio"; url: string; role: string }> = [];
  for (let index = 0; index < rawAssets.length; index += 1) {
    const asset = rawAssets[index];
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      return { error: `assets[${index}] must be an object` };
    }

    const item = asset as Record<string, unknown>;
    const unknownAssetFields = Object.keys(item).filter((field) => !VIDEO_ASSET_FIELDS.has(field));
    if (unknownAssetFields.length) {
      return { error: `Unsupported assets[${index}] fields: ${unknownAssetFields.join(", ")}` };
    }

    const type = item.type;
    const url = item.url;
    const role = item.role;
    if (type !== "image" && type !== "video" && type !== "audio") {
      return { error: `assets[${index}].type must be image, video, or audio` };
    }
    if (typeof url !== "string" || !isHttpsUrl(url.trim())) {
      return { error: `assets[${index}].url must be a valid HTTPS URL` };
    }
    if (typeof role !== "string" || !VIDEO_ASSET_ROLES[type].has(role as never)) {
      return { error: `assets[${index}].role is invalid for type ${type}` };
    }

    assets.push({ type, url: url.trim(), role });
  }

  const hasFirstFrame = assets.some((asset) => asset.role === "first_frame");
  const hasLastFrame = assets.some((asset) => asset.role === "last_frame");
  const modeType = String(
    request.modeType || (hasFirstFrame && hasLastFrame
      ? "frames2video"
      : assets.length > 0 ? "image2video" : "text2video"),
  ).trim();
  if (!VIDEO_MODE_TYPES.has(modeType)) {
    return { error: "modeType must be text2video, image2video, or frames2video" };
  }

  const referenceMode = String(
    request.referenceMode || (modeType === "frames2video" ? "first_last_frame" : "multimodal"),
  ).trim();
  if (!VIDEO_REFERENCE_MODES.has(referenceMode)) {
    return { error: "referenceMode must be multimodal or first_last_frame" };
  }

  const firstFrameCount = assets.filter((asset) => asset.role === "first_frame").length;
  const lastFrameCount = assets.filter((asset) => asset.role === "last_frame").length;
  if (modeType === "text2video" && assets.length > 0) {
    return { error: "text2video does not accept assets" };
  }
  if (modeType === "image2video" && assets.length === 0) {
    return { error: "image2video requires at least one asset" };
  }
  if (modeType === "frames2video" && (firstFrameCount !== 1 || lastFrameCount !== 1)) {
    return { error: "frames2video requires exactly one first_frame and one last_frame" };
  }
  if (modeType === "frames2video" && referenceMode !== "first_last_frame") {
    return { error: "frames2video requires referenceMode=first_last_frame" };
  }
  if (modeType !== "frames2video" && (firstFrameCount > 0 || lastFrameCount > 0)) {
    return { error: "first_frame and last_frame are only valid for frames2video" };
  }
  if (modeType !== "frames2video" && referenceMode !== "multimodal") {
    return { error: `${modeType} requires referenceMode=multimodal` };
  }

  return {
    value: {
      model: request.model.trim(),
      prompt: request.prompt.trim(),
      assets,
      params: {
        ratio: typeof aspectRatio === "string" ? aspectRatio.trim() : undefined,
        resolution: typeof request.resolution === "string" ? request.resolution.trim() : undefined,
        duration: typeof request.duration === "string" ? request.duration.trim() : undefined,
        modeType,
        referenceMode,
        has_video: assets.some((asset) => asset.type === "video"),
        webhookUrl: typeof webhookUrl === "string" ? webhookUrl.trim() : undefined,
      },
    },
  };
};

const validateModelCapabilities = (capabilities: any, params: any, assets: Array<{ type: string }>) => {
  const requiredLists = ["durations", "resolutions", "ratios"] as const;
  const requiredLimits = ["max_images", "max_videos", "max_audios"] as const;
  const invalidConfig = requiredLists.find((key) => !Array.isArray(capabilities?.[key]) || capabilities[key].length === 0)
    || requiredLimits.find((key) => !Number.isSafeInteger(capabilities?.[key]) || capabilities[key] < 0)
    || (typeof capabilities?.supports_first_last_frame !== "boolean" ? "supports_first_last_frame" : "");
  if (invalidConfig) {
    return { status: 500, error: `模型能力配置不完整：${invalidConfig}` };
  }

  const invalidParam = [
    ["duration", params.duration, capabilities.durations],
    ["resolution", params.resolution, capabilities.resolutions],
    ["aspectRatio", params.ratio, capabilities.ratios],
  ].find(([name, value, allowed]) =>
    value && !allowed.some((item: unknown) =>
      name === "duration"
        ? String(item).replace(/s$/i, "") === String(value).replace(/s$/i, "")
        : item === value
    )
  );
  if (invalidParam) {
    const [name, value, allowed] = invalidParam;
    return { status: 400, error: `参数 ${name}=${value} 不受支持，可选值：${allowed.join(", ")}` };
  }

  const counts = {
    image: assets.filter((asset) => asset.type === "image").length,
    video: assets.filter((asset) => asset.type === "video").length,
    audio: assets.filter((asset) => asset.type === "audio").length,
  };
  const limits = {
    image: capabilities.max_images,
    video: capabilities.max_videos,
    audio: capabilities.max_audios,
  };
  const exceededType = (Object.keys(counts) as Array<keyof typeof counts>)
    .find((type) => counts[type] > limits[type]);
  if (exceededType) {
    return {
      status: 400,
      error: `当前模型最多支持 ${limits[exceededType]} 个${exceededType}素材，实际提交 ${counts[exceededType]} 个`,
    };
  }
  if (params.modeType === "frames2video" && !capabilities.supports_first_last_frame) {
    return { status: 400, error: "当前模型不支持首尾帧生成" };
  }

  return null;
};

async function handleVideoApi(req: Request, url: URL) {
  const apiKey = readBearerToken(req);
  if (!apiKey) return jsonResponse({ error: "Missing API key" }, 401);

  const { supabaseUrl, supabaseServiceKey } = supabaseConfig();
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (req.method === "POST" && url.pathname === "/v1/video/generations") {
    const parsed = parseVideoRequest(await req.json().catch(() => null));
    if (!parsed.value) return jsonResponse({ error: parsed.error }, 400);

    const { model, prompt, assets, params } = parsed.value;

    // Resolve the documented public model name only.
    const modelId = await resolvePublicApiModelId(supabaseAdmin, model);
    if (!modelId) {
      return jsonResponse({ error: "模型不存在或未开放 API 调用" }, 400);
    }

    const { data: modelData, error: modelError } = await supabaseAdmin
      .from("model_costs")
      .select("config")
      .eq("model_id", modelId)
      .single();

    if (modelError || !modelData) {
      return jsonResponse({ error: "读取模型配置失败" }, 500);
    }

    const capabilityError = validateModelCapabilities(modelData.config?.capabilities, params, assets);
    if (capabilityError) return jsonResponse({ error: capabilityError.error }, capabilityError.status);

    const { data, error } = await supabaseAdmin.rpc("api_create_video_task", {
      p_api_key: apiKey,
      p_model_id: modelId,
      p_prompt: prompt,
      p_assets: assets,
      p_params: params,
    });

    if (error) return jsonResponse({ error: error.message }, statusFromRpcError(error.message));
    return jsonResponse(data, 200);
  }

  if (req.method === "GET") {
    const match = url.pathname.match(/^\/v1\/video\/generations\/([0-9a-f-]{36})$/i);
    if (!match) return jsonResponse({ error: "Not found" }, 404);

    const taskId = match[1];

    const { data, error } = await supabaseAdmin.rpc("api_get_video_task", {
      p_api_key: apiKey,
      p_task_id: taskId,
    });

    if (error) return jsonResponse({ error: error.message }, statusFromRpcError(error.message));

    return jsonResponse(data, 200);
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}

async function handleProxyGateway(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const provider = req.headers.get("x-provider");
  const targetPath = req.headers.get("x-path") || "/v1/chat/completions";

  if (!provider) throw new Error("Missing provider");

  const { supabaseUrl, supabaseAnonKey, supabaseServiceKey } = supabaseConfig();

  const supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
  const token = authHeader?.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);

  if (authError || !user) {
    return jsonResponse({ error: "Unauthorized access" }, 401);
  }

  let secret = secretsCache.get(provider);
  if (!secret) {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const { data, error } = await supabaseAdmin
      .from("api_secrets")
      .select("base_url, api_key")
      .eq("key_name", provider)
      .single();

    if (error || !data) throw new Error(`Config missing for ${provider}`);
    secret = data;
    secretsCache.set(provider, data);
  }

  const baseUrl = secret.base_url.replace(/\/$/, "");
  const path = targetPath.replace(/^\/+/, "");
  const cleanBase = (path.startsWith("v2") && baseUrl.endsWith("/v1")) ? baseUrl.slice(0, -3) : baseUrl;
  let finalUrl = `${cleanBase}/${path}`;

  if (baseUrl.includes("googleapis.com") && !finalUrl.includes("key=")) {
    finalUrl += `${finalUrl.includes("?") ? "&" : "?"}key=${secret.api_key}`;
  }

  const proxyHeaders = new Headers();
  const whiteList = ["content-type", "accept", "user-agent", "x-goog-api-client"];
  for (const [key, value] of req.headers.entries()) {
    if (whiteList.includes(key.toLowerCase())) proxyHeaders.set(key, value);
  }

  proxyHeaders.set("Authorization", `Bearer ${secret.api_key}`);
  proxyHeaders.set("x-goog-api-key", secret.api_key);


  const fetchOptions: RequestInit = {
    method: req.method,
    headers: proxyHeaders,
    redirect: "follow",
    body: req.body,
  };
  const aiFetchPromise = fetch(finalUrl, fetchOptions);

  const TIMEOUT_MS = 60000;
  let timeoutId: number;
  const timeoutPromise = new Promise<"TIMEOUT">((resolve) => {
    timeoutId = setTimeout(() => resolve("TIMEOUT"), TIMEOUT_MS);
  });

  const winner = await Promise.race([aiFetchPromise, timeoutPromise]);

  if (winner !== "TIMEOUT") {
    clearTimeout(timeoutId!);
    const proxyRes = winner as Response;
    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Content-Type", proxyRes.headers.get("Content-Type") || "application/json");

    return new Response(proxyRes.body, {
      status: proxyRes.status,
      headers: responseHeaders,
    });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const responseHeaders = new Headers(corsHeaders);
  responseHeaders.set("Content-Type", "application/json");

  (async () => {
    const keepAliveInterval = setInterval(async () => {
      try {
        await writer.write(encoder.encode("   "));
      } catch {
        clearInterval(keepAliveInterval);
      }
    }, 30000);

    try {
      const proxyRes = await aiFetchPromise;
      clearInterval(keepAliveInterval);

      if (!proxyRes.ok) {
        const errText = await proxyRes.text();
        try {
          JSON.parse(errText);
          await writer.write(encoder.encode(errText));
        } catch {
          await writer.write(encoder.encode(JSON.stringify({ error: `Upstream Error: ${errText}` })));
        }
      } else if (!proxyRes.body) {
        await writer.write(encoder.encode(""));
      } else {
        const reader = proxyRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      }
    } catch (error: any) {
      clearInterval(keepAliveInterval);
      const errJson = JSON.stringify({ error: { message: `Gateway Error: ${error.message}` } });
      try {
        await writer.write(encoder.encode(errJson));
      } catch {
        // Ignore closed client stream.
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // Ignore closed client stream.
      }
    }
  })();

  return new Response(readable, { status: 200, headers: responseHeaders });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return await handleModelsApi(req);
    }
    if (url.pathname === "/v1/uploads/sign") {
      return await handleUploadSignApi(req);
    }
    if (
      url.pathname === "/v1/video/generations"
      || url.pathname.startsWith("/v1/video/generations/")
    ) {
      return await handleVideoApi(req, url);
    }

    return await handleProxyGateway(req);
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
});
