// main.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 内存缓存，减少对 Supabase 数据库的查询压力
const secretsCache = new Map<string, { base_url: string; api_key: string }>();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-provider, x-path",
};

// Deno 标准服务启动
Deno.serve(async (req) => {
  // 1. 处理 CORS 预检请求
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    const provider = req.headers.get("x-provider"); 
    const targetPath = req.headers.get("x-path") || "/v1/chat/completions";
    
    if (!provider) throw new Error("Missing provider");

    // 获取环境变量 (这些需要在 Deno Deploy 的 Settings -> Environment Variables 中配置)
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // 🛡️ 2. 安全加固：验证请求者是否为合法的登录用户
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
    const token = authHeader?.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
    
    if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized access" }), { status: 401, headers: corsHeaders });
    }

    // 🚀 3. 获取 API 密钥 (缓存优先)
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

    // ⚡️ 4. 动态组装目标地址
    const baseUrl = secret.base_url.replace(/\/$/, "");
    const path = targetPath.replace(/^\/+/, "");
    const cleanBase = (path.startsWith("v2") && baseUrl.endsWith("/v1")) ? baseUrl.slice(0, -3) : baseUrl;
    let finalUrl = `${cleanBase}/${path}`;
    
    // 适配 Google Gemini 官方格式
    if (baseUrl.includes("googleapis.com") && !finalUrl.includes("key=")) {
         finalUrl += `${finalUrl.includes("?") ? "&" : "?"}key=${secret.api_key}`;
    }

    // ⚡️ 5. Headers 深度净化
    const proxyHeaders = new Headers();
    const whiteList = ["content-type", "accept", "user-agent", "x-goog-api-client"];
    for (const [key, value] of req.headers.entries()) {
      if (whiteList.includes(key.toLowerCase())) {
        proxyHeaders.set(key, value);
      }
    }

    proxyHeaders.delete("content-length"); 
    proxyHeaders.delete("accept-encoding");
    proxyHeaders.delete("host");

    // 注入后端真实的供应商 Key
    proxyHeaders.set("Authorization", `Bearer ${secret.api_key}`);
    proxyHeaders.set("x-goog-api-key", secret.api_key);

    // =================================================================
    // 🚦 核心策略：竞速模式 (Race Mode) 
    // =================================================================
    console.log(`[Gateway] Race Start: ${provider} -> ${finalUrl}`);

    const fetchOptions: any = {
        method: req.method,
        headers: proxyHeaders,
        redirect: "follow",
        body: req.body 
    };
    const aiFetchPromise = fetch(finalUrl, fetchOptions);

    const TIMEOUT_MS = 60000; // 60秒生死线
    let timeoutId: any;
    const timeoutPromise = new Promise<"TIMEOUT">((resolve) => {
        timeoutId = setTimeout(() => resolve("TIMEOUT"), TIMEOUT_MS);
    });

    const winner = await Promise.race([aiFetchPromise, timeoutPromise]);

    // =================================================================
    // 🏆 结局 A: AI 响应迅速 (60秒内返回)
    // =================================================================
    if (winner !== "TIMEOUT") {
        clearTimeout(timeoutId);
        const proxyRes = winner as Response;
        const responseHeaders = new Headers(corsHeaders);
        responseHeaders.set("Content-Type", proxyRes.headers.get("Content-Type") || "application/json");
        
        return new Response(proxyRes.body, {
            status: proxyRes.status,
            headers: responseHeaders
        });
    }

    // =================================================================
    // 🚨 结局 B: 进入“心跳模式” (超过60秒未响应)
    // =================================================================
    else {
        console.log("[Gateway] Switching to Heartbeat Mode for long task.");
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const responseHeaders = new Headers(corsHeaders);
        responseHeaders.set("Content-Type", "application/json");
        
        (async () => {
            // 每 30 秒发送一个空格，防止浏览器或平台断开连接
            const keepAliveInterval = setInterval(async () => {
                try { await writer.write(encoder.encode("   ")); } catch (e) { clearInterval(keepAliveInterval); }
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
                } else {
                    if (!proxyRes.body) {
                         await writer.write(encoder.encode(""));
                    } else {
                        const reader = proxyRes.body.getReader();
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            await writer.write(value);
                        }
                    }
                }
            } catch (error: any) {
                clearInterval(keepAliveInterval);
                const errJson = JSON.stringify({ error: { message: `Gateway Error: ${error.message}` } });
                try { await writer.write(encoder.encode(errJson)); } catch(e) {}
            } finally {
                try { await writer.close(); } catch(e) {}
            }
        })();

        return new Response(readable, { status: 200, headers: responseHeaders });
    }

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
