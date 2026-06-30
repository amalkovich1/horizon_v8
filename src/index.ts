import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccountConfig {
  token: string;
  cookie: string;
  hif_dliq?: string;
  hif_leim?: string;
  wasmUrl?: string;
}

interface SessionState {
  id: string | null;
  parentMessageId: string | null;
  createdAt: number | null;
  messageCount: number;
  accountId: string | null;
  history: Array<{ user: string; assistant: string }>;
}

interface Account {
  id: string;
  config: AccountConfig;
  headers: Record<string, string>;
  cooldownUntil: number;
  failures: number;
  lastUsedAt: number;
}

interface ModelConfig {
  model_type: string;
  thinking_enabled: boolean;
  search_enabled: boolean;
  real_model: string;
  capabilities: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Default models
// ---------------------------------------------------------------------------

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  "deepseek-chat":     { model_type: "default", thinking_enabled: false, search_enabled: false, real_model: "DeepSeek-V4-Flash non-thinking", capabilities: { reasoning: false, web_search: false, files: true } },
  "deepseek-default":  { model_type: "default", thinking_enabled: false, search_enabled: false, real_model: "DeepSeek-V4-Flash non-thinking", capabilities: { reasoning: false, web_search: false, files: true } },
  "deepseek-reasoner": { model_type: "default", thinking_enabled: true,  search_enabled: false, real_model: "DeepSeek-V4-Flash thinking",     capabilities: { reasoning: true, web_search: false, files: true } },
  "deepseek-expert":   { model_type: "expert",  thinking_enabled: false, search_enabled: false, real_model: "DeepSeek Web Эксперт",          capabilities: { reasoning: false, web_search: false, files: false } },
  "deepseek-v4-pro":   { model_type: "expert",  thinking_enabled: true,  search_enabled: false, real_model: "DeepSeek Web Эксперт + thinking", capabilities: { reasoning: true, web_search: false, files: false } },
};

const SUPPORTED_MODELS = Object.keys(MODEL_CONFIGS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeMessageContent(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") return part.text || "";
      if (part.type === "tool_result") return `[Tool Result ${part.tool_use_id || ""}]\n${normalizeMessageContent(part.content)}`;
      if (part.type === "image_url") return `[Image: ${part.image_url?.url || ""}]`;
      return part.text || part.content || JSON.stringify(part);
    }).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    try { return JSON.stringify(content); } catch {}
  }
  return String(content);
}

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

function buildUsage(prompt: string, content: string, reasoningContent = "") {
  const promptTokens = estimateTokens(prompt);
  const contentTokens = estimateTokens(content);
  const reasoningTokens = estimateTokens(reasoningContent);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: contentTokens + reasoningTokens,
    total_tokens: promptTokens + contentTokens + reasoningTokens,
    completion_tokens_details: { reasoning_tokens: reasoningTokens },
  };
}

// ---------------------------------------------------------------------------
// Auth loading
// ---------------------------------------------------------------------------

function discoverAuthPaths(): string[] {
  const authDir = process.env.DEEPSEEK_AUTH_DIR;
  const authPath = process.env.DEEPSEEK_AUTH_PATH;
  if (authDir) {
    try {
      return readdirSync(authDir).filter((f) => f.endsWith(".json")).sort().map((f) => join(authDir, f));
    } catch {}
  }
  if (authPath) {
    if (authPath.includes(",")) return authPath.split(",").map((s) => s.trim()).filter(Boolean);
    return [authPath];
  }
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  return [join(pluginDir, "deepseek-auth.json")];
}

function buildBaseHeaders(config: AccountConfig): Record<string, string> {
  return {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "x-client-platform": "web",
    "x-client-version": "2.0.0",
    "x-client-locale": "ru",
    "x-client-timezone-offset": "14400",
    "x-app-version": "2.0.0",
    Authorization: `Bearer ${config.token || ""}`,
    "x-hif-dliq": config.hif_dliq || "",
    "x-hif-leim": config.hif_leim || "",
    Origin: "https://chat.deepseek.com",
    Referer: "https://chat.deepseek.com/",
    Cookie: config.cookie || "",
    "Content-Type": "application/json",
  };
}

function loadAccounts(): Account[] {
  const accounts: Account[] = [];
  for (const file of discoverAuthPaths()) {
    try {
      const raw = readFileSync(file, "utf8");
      const config: AccountConfig = JSON.parse(raw);
      if (!config.token || !config.cookie) continue;
      accounts.push({
        id: `account_${accounts.length + 1}`,
        config,
        headers: buildBaseHeaders(config),
        cooldownUntil: 0,
        failures: 0,
        lastUsedAt: 0,
      });
    } catch {}
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// PoW
// ---------------------------------------------------------------------------

async function solvePOW(challenge: any, config: AccountConfig): Promise<number> {
  const resp = await fetch(config.wasmUrl || "https://chat.deepseek.com/chat-webserver/prover_wasm_bg.wasm");
  const wasmBytes = await resp.arrayBuffer();
  const mod = await WebAssembly.instantiate(wasmBytes, { wbg: {} });
  const e = mod.instance.exports as any;
  const encoder = new TextEncoder();
  const prefix = challenge.salt + "_" + challenge.expire_at + "_";
  const cBytes = encoder.encode(challenge.challenge);
  const pBytes = encoder.encode(prefix);

  const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
  const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
  new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
  new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);

  const sp = e.__wbindgen_add_to_stack_pointer(-16);
  e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty);
  const dv = new DataView(e.memory.buffer);
  const code = dv.getInt32(sp, true);
  const ans = dv.getFloat64(sp + 8, true);
  e.__wbindgen_add_to_stack_pointer(16);
  if (code === 0 || !Number.isFinite(ans) || ans <= 0) throw new Error("POW failed");
  return Math.floor(ans);
}

// ---------------------------------------------------------------------------
// Format messages → DeepSeek Web prompt text
// ---------------------------------------------------------------------------

function formatMessages(messages: Array<{ role: string; content: any }>, tools: any[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const anyMsg = msg as any;
    const role = anyMsg.role;
    const content = normalizeMessageContent(anyMsg.content);
    if (role === "system") { parts.push(`System: ${content}`); }
    else if (role === "user") { parts.push(`User: ${content}`); }
    else if (role === "assistant") {
      if (anyMsg.tool_calls && Array.isArray(anyMsg.tool_calls) && anyMsg.tool_calls.length > 0) {
        for (const tc of anyMsg.tool_calls) {
          if (tc.function) parts.push(`Assistant: TOOL_CALL: ${tc.function.name}\narguments: ${tc.function.arguments}`);
        }
      } else if (content) { parts.push(`Assistant: ${content}`); }
    } else if (role === "tool") {
      const tn = anyMsg.name || anyMsg.toolName || "unknown";
      parts.push(`Tool Result (${tn}): ${content}`);
    }
  }
  let base = parts.join("\n");
  if (tools && tools.length > 0) {
    let t = "\n\n--- TOOL REQUEST SYSTEM ---\n";
    t += 'Use: {"tool_call":{"name":"<f>","arguments":{...}}}\nAvailable functions:\n';
    for (const tool of tools) {
      if (tool.type === "function" && tool.function) {
        t += `\n## ${tool.function.name}\n${tool.function.description || ""}\n`;
        if (tool.function.parameters) t += `Params: ${JSON.stringify(tool.function.parameters)}\n`;
      }
    }
    t += "\n--- END TOOL REQUEST SYSTEM ---\n";
    base += t;
  }
  return base;
}

function parseToolCall(text: string): { name: string; arguments: string } | null {
  if (!text) return null;
  const jm = text.match(/\{\s*"tool_call"\s*:\s*\{/);
  if (jm) {
    const start = jm.index!;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\" && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (ch === "{") depth++;
        if (ch === "}") { depth--; if (depth === 0) {
          const raw = text.substring(start, i + 1);
          try {
            const p = JSON.parse(raw), tc = p.tool_call || p;
            if (tc.name) return { name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}) };
          } catch {}
          return null;
        }}
      }
    }
  }
  const lm = text.match(/TOOL_CALL:\s*(\S+)\s*\narguments:\s*(\{[\s\S]*?\})/);
  if (lm) return { name: lm[1], arguments: lm[2] };
  return null;
}

// ---------------------------------------------------------------------------
// DeepSeek Web API call
// ---------------------------------------------------------------------------

async function askDeepSeekStream(
  prompt: string,
  session: SessionState,
  account: Account,
  modelType: string,
  thinkingEnabled: boolean,
  searchEnabled: boolean,
): Promise<{ resp: Response }> {
  const dsHeaders = account.headers;

  // PoW challenge
  const cr = await fetch("https://chat.deepseek.com/api/v0/chat/create_pow_challenge", {
    method: "POST", headers: dsHeaders,
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
  });
  const chalText = await cr.text();
  if (!cr.ok) throw new Error(`PoW challenge failed: HTTP ${cr.status}`);
  let chalJson: any;
  try { chalJson = JSON.parse(chalText); } catch { throw new Error("PoW: non-JSON response"); }
  const challenge = chalJson?.data?.biz_data?.challenge;
  if (!challenge) throw new Error("PoW: no challenge in response");
  const answer = await solvePOW(challenge, account.config);

  // Create or reuse session
  if (!session.id) {
    const sr = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
      method: "POST", headers: dsHeaders, body: "{}",
    });
    const srText = await sr.text();
    let srJson: any;
    try { srJson = JSON.parse(srText); } catch {}
    const createdId = srJson?.data?.biz_data?.chat_session?.id || srJson?.data?.biz_data?.id;
    if (!sr.ok || !createdId) throw new Error(`Session create failed: HTTP ${sr.status}`);
    session.id = createdId;
    session.parentMessageId = null;
    session.createdAt = Date.now();
    session.messageCount = 0;
  }

  const powB64 = Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm, challenge: challenge.challenge,
    salt: challenge.salt, answer, signature: challenge.signature,
    target_path: "/api/v0/chat/completion",
  })).toString("base64");

  const resp = await fetch("https://chat.deepseek.com/api/v0/chat/completion", {
    method: "POST",
    headers: { ...dsHeaders, "X-DS-PoW-Response": powB64 },
    body: JSON.stringify({
      chat_session_id: session.id,
      parent_message_id: session.parentMessageId,
      model_type: modelType,
      prompt, ref_file_ids: [],
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
      action: null, preempt: false,
    }),
  });

  // Retry on expired session
  if (resp.status !== 200) {
    if (resp.status === 400 || resp.status === 404 || resp.status === 500) {
      session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0;
      const sr2 = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
        method: "POST", headers: dsHeaders, body: "{}",
      });
      const sr2Text = await sr2.text();
      let sr2Json: any;
      try { sr2Json = JSON.parse(sr2Text); } catch {}
      const createdId2 = sr2Json?.data?.biz_data?.chat_session?.id || sr2Json?.data?.biz_data?.id;
      if (!sr2.ok || !createdId2) throw new Error(`Session recreate failed: HTTP ${sr2.status}`);
      session.id = createdId2; session.parentMessageId = null; session.createdAt = Date.now(); session.messageCount = 0;
      const nB64 = Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer, signature: challenge.signature,
        target_path: "/api/v0/chat/completion",
      })).toString("base64");
      const resp2 = await fetch("https://chat.deepseek.com/api/v0/chat/completion", {
        method: "POST",
        headers: { ...dsHeaders, "X-DS-PoW-Response": nB64 },
        body: JSON.stringify({ chat_session_id: session.id, parent_message_id: null, model_type: modelType, prompt, ref_file_ids: [], thinking_enabled: thinkingEnabled, search_enabled: searchEnabled, action: null, preempt: false }),
      });
      return { resp: resp2 };
    }
  }
  return { resp };
}

// ---------------------------------------------------------------------------
// Local HTTP server (OpenAI-compatible → DeepSeek Web)
// ---------------------------------------------------------------------------

function startLocalServer(accounts: Account[], log: any, port = 0): Promise<number> {
  return new Promise((resolve) => {
    const sessions = new Map<string, SessionState>();
    const getOrCreateSession = (agentId: string): SessionState => {
      if (!sessions.has(agentId)) sessions.set(agentId, { id: null, parentMessageId: null, createdAt: null, messageCount: 0, accountId: null, history: [] });
      return sessions.get(agentId)!;
    };
    let rr = 0;
    const selectAccount = (session: SessionState): Account => {
      if (session.accountId) {
        const sticky = accounts.find((a) => a.id === session.accountId);
        if (sticky && sticky.cooldownUntil <= Date.now()) return sticky;
        session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0; session.accountId = null;
      }
      const ready = accounts.filter((a) => a.cooldownUntil <= Date.now());
      if (ready.length === 0) throw new Error("All DeepSeek accounts are cooling down");
      const a = ready[rr % ready.length];
      rr++;
      session.accountId = a.id;
      return a;
    };

    const server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: SUPPORTED_MODELS.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "deepseek-web", capabilities: MODEL_CONFIGS[id].capabilities })) }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        res.writeHead(404); res.end("Not found"); return;
      }

      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const params = JSON.parse(body);
          const messages: Array<{ role: string; content: any }> = params.messages || [];
          const tools: any[] = params.tools || [];
          const stream = params.stream === true;
          const model = String(params.model || "deepseek-default").toLowerCase();
          if (!MODEL_CONFIGS[model]) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: `Unknown model: ${model}` })); return; }

          const mc = MODEL_CONFIGS[model];
          const agentId = (params.user as string) || "default";
          const session = getOrCreateSession(agentId);
          const account = selectAccount(session);
          const prompt = formatMessages(messages, tools);

          const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
          session.history.push({ user: lastUserMsg ? normalizeMessageContent(lastUserMsg.content) : "", assistant: "" });
          if (session.history.length > 15) session.history.shift();
          let hc = session.history.reduce((s, e) => s + e.user.length + e.assistant.length, 0);
          while (hc > 10000 && session.history.length > 1) { const r = session.history.shift()!; hc -= r.user.length + r.assistant.length; }
          const historyText = session.history.length > 1 ? session.history.slice(0, -1).map((h) => `User: ${h.user}\nAssistant: ${h.assistant}`).join("\n") + "\n" : "";
          const fullPrompt = historyText + prompt;

          log.info(`[horizon_v8] ${agentId} → ${model} (${mc.model_type})`);
          const { resp: dsResp } = await askDeepSeekStream(fullPrompt, session, account, mc.model_type, mc.thinking_enabled, mc.search_enabled);

          let fullContent = "", reasoningContent = "";
          if (dsResp.body && dsResp.headers.get("content-type")?.includes("text/event-stream")) {
            const reader = dsResp.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const lines = buf.split("\n");
              buf = lines.pop() ?? "";
              for (const line of lines) {
                const t = line.trim();
                if (!t || !t.startsWith("data: ")) continue;
                const raw = t.slice(6);
                if (raw === "[DONE]") continue;
                try {
                  const ev = JSON.parse(raw);
                  if (ev.type === "RESPONSE" || ev.type === "SEARCH") fullContent += ev.content || "";
                  else if (ev.type === "THINK" || ev.type === "REASONING") reasoningContent += ev.content || "";
                } catch {}
              }
            }
          } else {
            fullContent = await dsResp.text();
          }

          session.parentMessageId = null;
          session.messageCount++;
          const toolCall = parseToolCall(fullContent);
          const finalContent = toolCall ? "" : fullContent;
          const t = Date.now();
          const rid = `chatcmpl-${t}`;
          const created = Math.floor(t / 1000);

          if (stream) {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            if (reasoningContent) {
              for (let i = 0; i < reasoningContent.length; i += 50) {
                res.write(`data: ${JSON.stringify({ id: rid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: reasoningContent.substring(i, i + 50) }, finish_reason: null }] })}\n\n`);
              }
            }
            if (toolCall) {
              res.write(`data: ${JSON.stringify({ id: rid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ id: `call_${t}_${Math.random().toString(36).substring(2, 8)}`, type: "function", function: { name: toolCall.name, arguments: toolCall.arguments } }] }, finish_reason: null }] })}\n\n`);
              const fc: any = { id: rid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
              fc.usage = buildUsage(fullPrompt, "", reasoningContent);
              res.write(`data: ${JSON.stringify(fc)}\n\n`);
            } else {
              for (let i = 0; i < fullContent.length; i += 50) {
                res.write(`data: ${JSON.stringify({ id: rid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: fullContent.substring(i, i + 50) }, finish_reason: null }] })}\n\n`);
              }
              const fc: any = { id: rid, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
              fc.usage = buildUsage(fullPrompt, finalContent, reasoningContent);
              res.write(`data: ${JSON.stringify(fc)}\n\n`);
            }
            res.write("data: [DONE]\n\n"); res.end();
          } else {
            if (toolCall) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ id: `ds-${t}`, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: `call_${t}_${Math.random().toString(36).substring(2, 8)}`, type: "function", function: { name: toolCall.name, arguments: toolCall.arguments } }] }, finish_reason: "tool_calls" }], usage: buildUsage(fullPrompt, "", reasoningContent) }));
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ id: `ds-${t}`, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: finalContent }, finish_reason: "stop" }], usage: buildUsage(fullPrompt, finalContent, reasoningContent) }));
            }
          }
          const he = session.history[session.history.length - 1];
          if (he) he.assistant = fullContent;
          log.info(`[horizon_v8] ${stream ? "Streamed" : "Responded"} ${fullContent.length} chars (tool=${!!toolCall})`);
        } catch (e: any) {
          log.error(`[horizon_v8] Error: ${e.message}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: e.message, type: "server_error" } }));
        }
      });
    });

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") { log.info(`[horizon_v8] Server on http://127.0.0.1:${addr.port}`); resolve(addr.port); }
    });
  });
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "horizon_v8",
  name: "Horizon V8",
  description: "DeepSeek Web API provider (PoW, sessions, streaming)",

  async register(api: any) {
    const log = api.logger ?? console;
    const accounts = loadAccounts();
    if (accounts.length === 0) {
      log.warn("[horizon_v8] No auth accounts — set DEEPSEEK_AUTH_PATH or place deepseek-auth.json in plugin dir");
      return;
    }
    log.info(`[horizon_v8] ${accounts.length} account(s) loaded`);

    const port = await startLocalServer(accounts, log, process.env.HORIZON_PORT ? parseInt(process.env.HORIZON_PORT) : 0);

    api.registerProvider({
      id: "horizon_v8",
      label: "Horizon V8 (DeepSeek Web)",
      docsPath: "/plugins/horizon_v8",
      envVars: ["DEEPSEEK_AUTH_PATH", "DEEPSEEK_AUTH_DIR"],
      auth: [],
      catalog: {
        order: "simple",
        run: async () => ({
          provider: {
            baseUrl: `http://127.0.0.1:${port}`,
            api: "openai-completions",
            models: SUPPORTED_MODELS.map((id) => {
              const c = MODEL_CONFIGS[id];
              return { id, name: c.real_model, contextWindow: 131072, maxTokens: 8192, reasoning: c.thinking_enabled, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
            }),
          },
        }),
        buildStaticProvider: () => ({ api: "openai-completions", baseUrl: `http://127.0.0.1:${port}`, models: SUPPORTED_MODELS.map((id) => ({ id, name: MODEL_CONFIGS[id].real_model })) }),
      },
    });

    api.registerModelCatalogProvider!({
      provider: "horizon_v8", kinds: ["text"],
      liveCatalog: async () => SUPPORTED_MODELS.map((id) => ({ kind: "text" as const, provider: "horizon_v8", model: `horizon_v8/${id}`, label: MODEL_CONFIGS[id].real_model, source: "static" as const })),
    });

    api.registerCommand({
      name: "horizon_status",
      description: "Show horizon_v8 status",
      handler: () => ({
        text: [
          "🌅 **Horizon V8**",
          `Port: ${port}`,
          `Accounts: ${accounts.length}`,
          ...accounts.map((a) => {
            const r = Math.max(0, Math.ceil((a.cooldownUntil - Date.now()) / 1000));
            return `  ${a.id}: ${a.cooldownUntil > Date.now() ? `⏳ cd ${r}s` : "✅"} (${a.failures} errors)`;
          }),
          "", `**Models (${SUPPORTED_MODELS.length})**`,
          ...SUPPORTED_MODELS.map((id) => `  \`${id}\`: ${MODEL_CONFIGS[id].real_model}`),
        ].join("\n"),
      }),
    });

    log.info(`[horizon_v8] Registered on ${port} with ${accounts.length} account(s)`);
  },
});
