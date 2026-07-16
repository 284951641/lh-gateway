// main.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const secretsCache = new Map<string, { base_url: string; api_key: string }>();
const videoStatusCache = new Map<string, { expiresAt: number; payload: unknown }>();
const VIDEO_STATUS_CACHE_TTL_MS = 10_000;
const VIDEO_STATUS_CACHE_MAX = 1000;

const getVideoStatusCacheKey = (apiKey: string, taskId: string) => `${apiKey}:${taskId}`;

const setVideoStatusCache = (key: string, payload: unknown) => {
  if (videoStatusCache.size >= VIDEO_STATUS_CACHE_MAX) {
    const firstKey = videoStatusCache.keys().next().value;
    if (firstKey) videoStatusCache.delete(firstKey);
  }

  videoStatusCache.set(key, {
    expiresAt: Date.now() + VIDEO_STATUS_CACHE_TTL_MS,
    payload,
  });
};

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
  sort_order?: number;
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
  const matched = models.find((model) =>
    model.model_id === modelName || getPublicApiModelName(model) === modelName
  );
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
const UPLOAD_WORKER_URL = Deno.env.get("UPLOAD_WORKER_URL") || "https://sedance.top";
const UPLOAD_PUBLIC_URL = Deno.env.get("UPLOAD_PUBLIC_URL") || "https://assets.sedance.top";

const uploadExtByType: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
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
  const contentType = String(body?.contentType || "").split(";")[0].toLowerCase();
  const size = Number(body?.size || 0);
  const ext = uploadExtByType[contentType];

  if (!ext) return jsonResponse({ error: "Unsupported file type" }, 415);
  if (!size || size > UPLOAD_MAX_BYTES) {
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

const toArray = (value: unknown) => Array.isArray(value) ? value : [];

const normalizeDuration = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return `${value}s`;
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return /\d\s*s$/i.test(text) ? text.toLowerCase() : `${text.replace(/s$/i, "")}s`;
};

const normalizeResolution = (value: unknown) => {
  const text = String(value ?? "").trim();
  return text ? text.toLowerCase() : undefined;
};

const toUrlItems = (value: unknown) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
};

const pickNestedUrl = (item: any, key: "image_url" | "video_url" | "audio_url") => {
  const value = item?.[key];
  if (typeof value === "string") return value;
  return typeof value?.url === "string" ? value.url : "";
};

const appendUrlAssets = (
  assets: Array<Record<string, unknown>>,
  urls: unknown,
  type: "image" | "video" | "audio",
  role: string,
) => {
  for (const item of toUrlItems(urls)) {
    const url = typeof item === "string" ? item : (item as any)?.url;
    if (typeof url === "string" && url.trim()) assets.push({ type, url: url.trim(), role });
  }
};

const appendContentAssets = (assets: Array<Record<string, unknown>>, content: unknown) => {
  for (const item of toArray(content)) {
    if (!item || typeof item !== "object") continue;
    const type = (item as any).type;
    if (type === "image_url") {
      const url = pickNestedUrl(item, "image_url");
      const itemRole = String((item as any).role || "");
      const role = itemRole.includes("last") ? "last_frame" : itemRole.includes("first") ? "first_frame" : "reference";
      if (url.trim()) assets.push({ type: "image", url: url.trim(), role });
    } else if (type === "video_url") {
      const url = pickNestedUrl(item, "video_url");
      if (url.trim()) assets.push({ type: "video", url: url.trim(), role: "reference" });
    } else if (type === "audio_url") {
      const url = pickNestedUrl(item, "audio_url");
      if (url.trim()) assets.push({ type: "audio", url: url.trim(), role: "audio" });
    }
  }
};

const hasInvalidAssetUrl = (assets: Array<Record<string, unknown>>) =>
  assets.some((asset) => {
    const url = typeof asset.url === "string" ? asset.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) return true;
    asset.url = url;
    return false;
  });

const normalizeVideoRequest = (body: any) => {
  const assets = toArray(body.assets).filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;
  const firstImage = body.first_image ?? body.first_frame_image;
  const lastImage = body.last_image ?? body.last_frame_image;
  const hasFirstImage = typeof firstImage === "string" && firstImage.trim();
  const hasLastImage = typeof lastImage === "string" && lastImage.trim();

  if (hasFirstImage) {
    assets.push({
      type: "image",
      url: firstImage.trim(),
      role: hasLastImage ? "first_frame" : "reference",
    });
  }

  if (hasLastImage) {
    assets.push({ type: "image", url: lastImage.trim(), role: "last_frame" });
  }

  appendUrlAssets(assets, body.reference_image_urls ?? body.reference_images, "image", "reference");
  appendUrlAssets(assets, body.imageUrls ?? body.images, "image", "reference");
  appendUrlAssets(assets, body.image_url, "image", "reference");
  appendUrlAssets(assets, body.reference_video_urls ?? body.reference_videos, "video", "reference");
  appendUrlAssets(assets, body.videoUrls ?? body.videos, "video", "reference");
  appendUrlAssets(assets, body.source_video, "video", "reference");
  appendUrlAssets(assets, body.reference_video, "video", "reference");
  appendUrlAssets(assets, body.reference_audio_urls ?? body.reference_audios, "audio", "audio");
  appendUrlAssets(assets, body.audioUrls ?? body.audios, "audio", "audio");
  appendUrlAssets(assets, body.audio_url, "audio", "audio");
  appendUrlAssets(assets, body.reference_audio, "audio", "audio");
  appendContentAssets(assets, body.content);

  const modeType = body.modeType
    || body.mode_type
    || (hasFirstImage && hasLastImage ? "frames2video" : assets.length > 0 ? "image2video" : "text2video");

  const referenceMode = body.referenceMode
    || body.reference_mode
    || (modeType === "frames2video" ? "first_last_frame" : "multimodal");

  const params = {
    aspectRatio: body.aspectRatio ?? body.aspect_ratio,
    ratio: body.ratio ?? body.aspectRatio ?? body.aspect_ratio,
    resolution: normalizeResolution(body.resolution),
    duration: normalizeDuration(body.duration),
    referenceMode,
    modeType,
    has_video: body.has_video,
    generateAudio: body.generateAudio ?? body.generate_audio,
    humanMode: body.humanMode ?? body.human_mode,
    watermark: body.watermark,
    webhookUrl: body.webhookUrl ?? body.webhook_url,
  };

  return { assets, params };
};

async function handleVideoApi(req: Request, url: URL) {
  const apiKey = readBearerToken(req);
  if (!apiKey) return jsonResponse({ error: "Missing API key" }, 401);

  const { supabaseUrl, supabaseServiceKey } = supabaseConfig();
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (req.method === "POST" && (url.pathname === "/v1/video/generations" || url.pathname === "/v1/videos")) {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const { assets, params } = normalizeVideoRequest(body);
    if (hasInvalidAssetUrl(assets)) {
      return jsonResponse({ error: "素材必须是 http/https 公网 URL，请勿直接传 base64、blob 或文件内容。" }, 400);
    }

    // 获取模型
const modelId = await resolvePublicApiModelId(
  supabaseAdmin,
  String(body.model || ""),
);

if (!modelId) {
  return jsonResponse({ error: "模型不存在或未开放 API 调用" }, 400);
}

// 获取模型允许的参数
const { data: modelData, error: modelError } = await supabaseAdmin
  .from("model_costs")
  .select("config")
  .eq("model_id", modelId)
  .single();

if (modelError || !modelData) {
  return jsonResponse({ error: "读取模型配置失败" }, 500);
}

const capabilities = modelData.config?.capabilities || {};

// 检查用户参数是否在模型允许范围内
const invalidParam = [
  ["duration", params.duration, capabilities.durations],
  ["resolution", params.resolution, capabilities.resolutions],
  ["ratio", params.ratio, capabilities.ratios],
].find(([, value, allowed]) =>
  value &&
  Array.isArray(allowed) &&
  !allowed.includes(value)
);

if (invalidParam) {
  const [name, value, allowed] = invalidParam;

  return jsonResponse({
    error: `参数 ${name}=${value} 不受支持，可选值：${allowed.join(", ")}`,
  }, 400);
}

// 参数合规后，才扣费并创建任务
const { data, error } = await supabaseAdmin.rpc("api_create_video_task", {
  p_api_key: apiKey,
  p_model_id: modelId,
  p_prompt: String(body.prompt || ""),
  p_assets: assets,
  p_params: params,
});

    if (error) return jsonResponse({ error: error.message }, statusFromRpcError(error.message));
    return jsonResponse(data, 200);
  }

  if (req.method === "GET") {
    const match = url.pathname.match(/^\/v1\/video\/generations\/([0-9a-f-]{36})$/i)
      || url.pathname.match(/^\/v1\/videos\/([0-9a-f-]{36})$/i);
    if (!match) return jsonResponse({ error: "Not found" }, 404);

    const taskId = match[1];
    const cacheKey = getVideoStatusCacheKey(apiKey, taskId);
    const cached = videoStatusCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return jsonResponse(cached.payload, 200);
    }

    if (cached) videoStatusCache.delete(cacheKey);

    const { data, error } = await supabaseAdmin.rpc("api_get_video_task", {
      p_api_key: apiKey,
      p_task_id: taskId,
    });

    if (error) return jsonResponse({ error: error.message }, statusFromRpcError(error.message));

    setVideoStatusCache(cacheKey, data);
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

  proxyHeaders.delete("content-length");
  proxyHeaders.delete("accept-encoding");
  proxyHeaders.delete("host");
  proxyHeaders.set("Authorization", `Bearer ${secret.api_key}`);
  proxyHeaders.set("x-goog-api-key", secret.api_key);

  console.log(`[Gateway] Race Start: ${provider} -> ${finalUrl}`);

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

  console.log("[Gateway] Switching to Heartbeat Mode for long task.");
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
      || url.pathname === "/v1/videos"
      || url.pathname.startsWith("/v1/videos/")
    ) {
      return await handleVideoApi(req, url);
    }

    return await handleProxyGateway(req);
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
});
