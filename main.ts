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

const readBearerToken = (req: Request) => {
  const header = req.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
};

const statusFromRpcError = (message = "") => {
  if (/invalid api key|unauthorized|权限|key/i.test(message)) return 401;
  if (/余额不足/i.test(message)) return 402;
  if (/不存在|停用|不能为空|仅支持|参数|prompt|model/i.test(message)) return 400;
  return 500;
};

const formatApiPrice = (model: any) => {
  const strategy = model?.config?.pricing_strategy;

  if (strategy?.type === "per_second") {
    const rates = strategy.rates && typeof strategy.rates === "object"
      ? Object.values(strategy.rates).map(Number).filter(Number.isFinite)
      : [];

    const rate = rates.length
      ? Math.min(...rates) === Math.max(...rates)
        ? `${Math.min(...rates)}`
        : `${Math.min(...rates)}-${Math.max(...rates)}`
      : `${Number(strategy.rate_per_second || strategy.rate || model.cost || 0)}`;

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

  return `${model.cost || 0} 算力/次`;
};

async function assertValidApiKey(supabaseAdmin: any, apiKey: string) {
  const { data, error } = await supabaseAdmin.rpc("api_authenticate_key", {
    p_api_key: apiKey,
  });

  if (error) throw new Error(error.message);
  if (!data || (Array.isArray(data) && data.length === 0)) {
    throw new Error("Invalid API key");
  }
}

async function handleVideoApi(req: Request, url: URL) {
  const apiKey = readBearerToken(req);
  if (!apiKey) return jsonResponse({ error: "Missing API key" }, 401);

  const { supabaseUrl, supabaseServiceKey } = supabaseConfig();
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (req.method === "GET" && url.pathname === "/v1/video/models") {
    try {
      await assertValidApiKey(supabaseAdmin, apiKey);
    } catch (error: any) {
      return jsonResponse({ error: error.message }, statusFromRpcError(error.message));
    }

    const { data, error } = await supabaseAdmin
      .from("model_costs")
      .select("model_id, name, cost, config")
      .eq("category", "video")
      .eq("is_active", true);

    if (error) return jsonResponse({ error: error.message }, 500);

    const models = (data || [])
      .filter((item: any) => item.config?.api_access?.enabled === true)
      .map((item: any) => ({
        model: item.model_id,
        name: item.config?.api_access?.display_name || item.name || item.model_id,
        price: formatApiPrice(item),
        capabilities: item.config?.capabilities || {},
      }));

    return jsonResponse({ data: models }, 200);
  }

  if (req.method === "POST" && url.pathname === "/v1/video/generations") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const params = {
      aspectRatio: body.aspectRatio,
      ratio: body.ratio,
      resolution: body.resolution,
      duration: body.duration,
      referenceMode: body.referenceMode,
      modeType: body.modeType,
      has_video: body.has_video,
      webhookUrl: body.webhookUrl,
    };

    const { data, error } = await supabaseAdmin.rpc("api_create_video_task", {
      p_api_key: apiKey,
      p_model_id: String(body.model || ""),
      p_prompt: String(body.prompt || ""),
      p_assets: Array.isArray(body.assets) ? body.assets : [],
      p_params: params,
    });

    if (error) return jsonResponse({ error: error.message }, statusFromRpcError(error.message));
    return jsonResponse(data, 200);
  }

  if (req.method === "GET") {
    const match = url.pathname.match(/^\/v1\/video\/generations\/([0-9a-f-]{36})$/i);
    if (!match) return jsonResponse({ error: "Not found" }, 404);

    const { data, error } = await supabaseAdmin.rpc("api_get_video_task", {
      p_api_key: apiKey,
      p_task_id: match[1],
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
    if (url.pathname === "/v1/video/models" || url.pathname === "/v1/video/generations" || url.pathname.startsWith("/v1/video/generations/")) {
      return await handleVideoApi(req, url);
    }

    return await handleProxyGateway(req);
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
});
