import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
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
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

// ---------------------------------------------------------------------------
// Model configs
// ---------------------------------------------------------------------------

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  "deepseek-chat":     { model_type: "default", thinking_enabled: false, search_enabled: false, real_model: "DeepSeek V4 Flash",         contextWindow: 131072, maxTokens: 8192,  reasoning: false },
  "deepseek-default":  { model_type: "default", thinking_enabled: false, search_enabled: false, real_model: "DeepSeek V4 Flash",         contextWindow: 131072, maxTokens: 8192,  reasoning: false },
  "deepseek-reasoner": { model_type: "default", thinking_enabled: true,  search_enabled: false, real_model: "DeepSeek V4 Flash Thinking", contextWindow: 131072, maxTokens: 8192,  reasoning: true  },
  "deepseek-expert":   { model_type: "expert",  thinking_enabled: false, search_enabled: false, real_model: "DeepSeek Web Expert",       contextWindow: 131072, maxTokens: 8192,  reasoning: false },
  "deepseek-v4-pro":   { model_type: "expert",  thinking_enabled: true,  search_enabled: false, real_model: "DeepSeek Expert Thinking",  contextWindow: 131072, maxTokens: 8192,  reasoning: true  },
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
      if (part.type === "image_url") return "[Image]";
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

function makeEmptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function buildUsage(prompt: string, content: string, reasoningContent = "") {
  const pt = estimateTokens(prompt);
  const ct = estimateTokens(content);
  const rt = estimateTokens(reasoningContent);
  return {
    input: pt, output: ct + rt, cacheRead: 0, cacheWrite: 0, totalTokens: pt + ct + rt,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function makeEmptyPartial(role: string, model: string): any {
  return { role, content: [], api: "openai-completions", provider: "horizon_v8", model, usage: makeEmptyUsage(), stopReason: "stop", timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function discoverAuthPaths(): string[] {
  const authDir = process.env.DEEPSEEK_AUTH_DIR;
  const authPath = process.env.DEEPSEEK_AUTH_PATH;
  if (authDir) {
    try { return readdirSync(authDir).filter(f => f.endsWith(".json")).sort().map(f => join(authDir, f)); } catch {}
  }
  if (authPath) {
    if (authPath.includes(",")) return authPath.split(",").map(s => s.trim()).filter(Boolean);
    return [authPath];
  }
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  return [join(pluginDir, "deepseek-auth.json")];
}

function buildBaseHeaders(config: AccountConfig): Record<string, string> {
  return {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
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
    } catch { /* skip unreadable */ }
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// PoW
// ---------------------------------------------------------------------------

async function solvePOW(challenge: any, wasmUrl: string): Promise<number> {
  const resp = await fetch(wasmUrl || "https://chat.deepseek.com/chat-webserver/prover_wasm_bg.wasm");
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
  if (code === 0 || !Number.isFinite(ans) || ans <= 0) throw new Error("PoW failed");
  return Math.floor(ans);
}

// ---------------------------------------------------------------------------
// Format messages for DeepSeek Web
// ---------------------------------------------------------------------------

function formatMessages(messages: any[], systemPrompt: string | undefined, tools: any[]): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(`System: ${systemPrompt}`);
  for (const msg of messages) {
    const m = msg as any;
    const role = m.role;
    const content = normalizeMessageContent(m.content);
    if (role === "user") { parts.push(`User: ${content}`); }
    else if (role === "assistant") {
      if (m.content && Array.isArray(m.content)) {
        const toolCalls: any[] = [];
        const texts: string[] = [];
        for (const block of m.content) {
          if (block.type === "toolCall") { toolCalls.push(block); }
          else if (block.type === "text") { texts.push(block.text); }
          else if (block.type === "thinking") { texts.push(`[thinking: ${block.thinking}]`); }
        }
        if (texts.length > 0) parts.push(`Assistant: ${texts.join("\n")}`);
        for (const tc of toolCalls) {
          parts.push(`Assistant: TOOL_CALL: ${tc.name}\narguments: ${JSON.stringify(tc.arguments)}`);
        }
      } else if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc.function) parts.push(`Assistant: TOOL_CALL: ${tc.function.name}\narguments: ${tc.function.arguments}`);
        }
      } else if (content) {
        parts.push(`Assistant: ${content}`);
      }
    } else if (role === "toolResult") {
      parts.push(`Tool Result (${m.toolName || "unknown"}): ${content}`);
    } else if (role === "tool") {
      parts.push(`Tool Result (${m.name || m.toolName || "unknown"}): ${content}`);
    }
  }
  let base = parts.join("\n");
  if (tools && tools.length > 0) {
    let t = "\n\n--- TOOL REQUEST SYSTEM ---\n";
    t += 'When you need to call a tool, respond with:\n{"tool_call":{"name":"<function>","arguments":{...}}}\n\nAvailable tools:\n';
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

function parseToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  if (!text) return null;
  // Try JSON format first
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
          try {
            const p = JSON.parse(text.substring(start, i + 1));
            const tc = p.tool_call || p;
            if (tc.name) {
              const args = typeof tc.arguments === "string" ? (() => { try { return JSON.parse(tc.arguments); } catch { return {}; } })() : (tc.arguments || {});
              return { name: tc.name, args };
            }
          } catch {}
          return null;
        }}
      }
    }
  }
  // Try inline TOOL_CALL format
  const lm = text.match(/TOOL_CALL:\s*(\S+)\s*\narguments:\s*(\{[\s\S]*?\})/);
  if (lm) {
    try { return { name: lm[1], args: JSON.parse(lm[2]) }; } catch { return { name: lm[1], args: {} }; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DeepSeek Web API call
// ---------------------------------------------------------------------------

async function callDeepSeekWeb(
  prompt: string,
  session: SessionState,
  account: Account,
  modelType: string,
  thinkingEnabled: boolean,
  searchEnabled: boolean,
): Promise<Response> {
  const dsHeaders = account.headers;

  // 1. PoW challenge
  const cr = await fetch("https://chat.deepseek.com/api/v0/chat/create_pow_challenge", {
    method: "POST", headers: dsHeaders,
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
  });
  const chalText = await cr.text();
  let chalJson: any;
  try { chalJson = JSON.parse(chalText); } catch { throw new Error("PoW: non-JSON response"); }
  const challenge = chalJson?.data?.biz_data?.challenge;
  if (!challenge) throw new Error("PoW: no challenge in response");
  const answer = await solvePOW(challenge, account.config.wasmUrl || "");

  // 2. Create session if needed
  if (!session.id) {
    const sr = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
      method: "POST", headers: dsHeaders, body: "{}",
    });
    const srText = await sr.text();
    let srJson: any;
    try { srJson = JSON.parse(srText); } catch {}
    const createdId = srJson?.data?.biz_data?.chat_session?.id || srJson?.data?.biz_data?.id;
    if (!sr.ok || !createdId) throw new Error(`Session create: HTTP ${sr.status}`);
    session.id = createdId;
    session.parentMessageId = null;
    session.createdAt = Date.now();
    session.messageCount = 0;
  }

  // 3. Build PoW header
  const powB64 = Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm, challenge: challenge.challenge,
    salt: challenge.salt, answer, signature: challenge.signature,
    target_path: "/api/v0/chat/completion",
  })).toString("base64");

  // 4. Completion request
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

  // 5. Retry on expired session
  if (resp.status === 400 || resp.status === 404 || resp.status === 500) {
    session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0;
    const sr2 = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
      method: "POST", headers: dsHeaders, body: "{}",
    });
    const sr2Text = await sr2.text();
    let sr2Json: any;
    try { sr2Json = JSON.parse(sr2Text); } catch {}
    const createdId2 = sr2Json?.data?.biz_data?.chat_session?.id || sr2Json?.data?.biz_data?.id;
    if (!sr2.ok || !createdId2) throw new Error(`Session recreate: HTTP ${sr2.status}`);
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
    if (resp2.status !== 200) throw new Error(`DeepSeek: HTTP ${resp2.status}`);
    return resp2;
  }
  if (resp.status !== 200) throw new Error(`DeepSeek: HTTP ${resp.status}`);
  return resp;
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "horizon_v8",
  name: "Horizon V8",
  description: "DeepSeek Web API provider (PoW, sessions, streaming)",

  register(api: any) {
    const log = api.logger ?? console;
    const accounts = loadAccounts();
    if (accounts.length === 0) {
      log.warn("[horizon_v8] No auth accounts — set DEEPSEEK_AUTH_PATH or place deepseek-auth.json");
    } else {
      log.info(`[horizon_v8] ${accounts.length} account(s) loaded`);
    }

    let rr = 0;
    const sessions = new Map<string, SessionState>();

    function getSession(key: string): SessionState {
      let s = sessions.get(key);
      if (!s) { s = { id: null, parentMessageId: null, createdAt: null, messageCount: 0, accountId: null, history: [] }; sessions.set(key, s); }
      return s;
    }

    function selectAccount(session: SessionState): Account {
      if (session.accountId) {
        const sticky = accounts.find(a => a.id === session.accountId);
        if (sticky && sticky.cooldownUntil <= Date.now()) return sticky;
        session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0; session.accountId = null;
      }
      const ready = accounts.filter(a => a.cooldownUntil <= Date.now());
      if (ready.length === 0) throw new Error("All accounts cooling down");
      const a = ready[rr++ % ready.length];
      session.accountId = a.id;
      return a;
    }

    // -----------------------------------------------------------------------
    // Register provider
    // -----------------------------------------------------------------------
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
            api: "horizon-v8-raw" as const,
            baseUrl: "https://chat.deepseek.com",
            models: SUPPORTED_MODELS.map(id => {
              const mc = MODEL_CONFIGS[id];
              return {
                id,
                name: mc.real_model,
                contextWindow: mc.contextWindow,
                maxTokens: mc.maxTokens,
                reasoning: mc.reasoning,
                input: ["text"] as const,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              };
            }),
          },
        }),
      },

      // -----------------------------------------------------------------------
      // resolveSyntheticAuth — gateways doesn't need to check API key, we manage auth ourselves
      // -----------------------------------------------------------------------
      resolveSyntheticAuth: (_ctx: any) => ({
        apiKey: "plugin-managed",
        source: "horizon_v8 plugin (DeepSeek Web auth)",
        mode: "api-key" as const,
      }),

      // -----------------------------------------------------------------------
      // createStreamFn — replaces OpenClaw's HTTP transport entirely
      // -----------------------------------------------------------------------
      createStreamFn: (_ctx: any) => {
        return async (model: any, context: any, _options?: any) => {
          const stream = createAssistantMessageEventStream();
          const sid = model?.id || "deepseek-default";
          const mc = MODEL_CONFIGS[sid];
          if (!mc) {
            // Unknown model, return error
            const empty = makeEmptyUsage();
            const errMsg = `Unknown model: ${sid}`;
            stream.push({
              type: "error",
              reason: "error",
              error: {
                role: "assistant", content: [{ type: "text", text: "" }],
                api: "openai-completions", provider: "horizon_v8", model: sid,
                usage: empty, stopReason: "error", errorMessage: errMsg, timestamp: Date.now(),
              },
            });
            return stream;
          }

          (async () => {
            try {
              const systemPrompt = context.systemPrompt || "";
              const messages = context.messages || [];
              const tools = context.tools || [];
              const prompt = formatMessages(messages, systemPrompt, tools);

              const session = getSession(sid);
              const account = selectAccount(session);

              log.info(`[horizon_v8] ${sid} ${prompt.length}ch`);

              const resp = await callDeepSeekWeb(
                prompt, session, account,
                mc.model_type, mc.thinking_enabled, mc.search_enabled,
              );

              let fullContent = "";
              let reasoningContent = "";
              let contentIndex = 0;
              let thinkingIndex = -1;

              const emit = (event: any) => stream.push(event);

              if (resp.body && resp.headers.get("content-type")?.includes("text/event-stream")) {
                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buf = "";

                emit({ type: "start", partial: makeEmptyPartial("assistant", sid) });

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
                      if (ev.type === "THINK" || ev.type === "REASONING") {
                        if (thinkingIndex < 0) {
                          thinkingIndex = contentIndex;
                          emit({ type: "thinking_start", contentIndex: thinkingIndex, partial: makeEmptyPartial("assistant", sid) });
                        }
                        reasoningContent += ev.content || "";
                        emit({ type: "thinking_delta", contentIndex: thinkingIndex, delta: ev.content || "", partial: makeEmptyPartial("assistant", sid) });
                      } else if (ev.type === "RESPONSE" || ev.type === "SEARCH" || ev.type === "TEXT") {
                        const txt = ev.content || "";
                        if (fullContent.length === 0 && txt) {
                          emit({ type: "text_start", contentIndex, partial: makeEmptyPartial("assistant", sid) });
                        }
                        fullContent += txt;
                        if (txt) {
                          emit({ type: "text_delta", contentIndex, delta: txt, partial: makeEmptyPartial("assistant", sid) });
                        }
                      }
                    } catch {}
                  }
                }
              } else {
                fullContent = await resp.text();
                emit({ type: "start", partial: makeEmptyPartial("assistant", sid) });
                if (fullContent) {
                  emit({ type: "text_start", contentIndex, partial: makeEmptyPartial("assistant", sid) });
                  emit({ type: "text_delta", contentIndex, delta: fullContent, partial: makeEmptyPartial("assistant", sid) });
                }
              }

              // Close thinking block
              if (thinkingIndex >= 0) {
                emit({ type: "thinking_end", contentIndex: thinkingIndex, content: reasoningContent, partial: makeEmptyPartial("assistant", sid) });
              }

              const usage = buildUsage(prompt, fullContent, reasoningContent);
              const toolCall = parseToolCall(fullContent);

              if (toolCall) {
                const tcId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
                emit({
                  type: "text_end", contentIndex, content: "",
                  partial: { role: "assistant", content: [{ type: "toolCall" as const, id: tcId, name: toolCall.name, arguments: toolCall.args }], api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "toolUse" as const, timestamp: Date.now() },
                });
                emit({
                  type: "toolcall_start", contentIndex,
                  partial: { role: "assistant", content: [], api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "toolUse" as const, timestamp: Date.now() },
                });
                emit({
                  type: "toolcall_end", contentIndex,
                  toolCall: { type: "toolCall" as const, id: tcId, name: toolCall.name, arguments: toolCall.args },
                  partial: { role: "assistant", content: [], api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "toolUse" as const, timestamp: Date.now() },
                });
                emit({
                  type: "done", reason: "toolUse" as const,
                  message: { role: "assistant", content: [{ type: "toolCall" as const, id: tcId, name: toolCall.name, arguments: toolCall.args }], api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "toolUse", timestamp: Date.now() },
                });
              } else {
                const textContent = fullContent;
                emit({
                  type: "text_end", contentIndex, content: textContent,
                  partial: { role: "assistant", content: [{ type: "text", text: textContent }], api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "stop", timestamp: Date.now() },
                });
                stream.end({
                  role: "assistant", content: [{ type: "text", text: textContent }], api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "stop", timestamp: Date.now(),
                });
              }

              // Update session history
              const lastUser = [...(context.messages || [])].reverse().find((m: any) => m.role === "user");
              const sh = session.history;
              sh.push({ user: lastUser ? normalizeMessageContent((lastUser as any).content) : "", assistant: fullContent });
              if (sh.length > 15) sh.shift();
              let hc = sh.reduce((s: number, e: any) => s + e.user.length + e.assistant.length, 0);
              while (hc > 10000 && sh.length > 1) { const r = sh.shift()!; hc -= r.user.length + r.assistant.length; }
              session.parentMessageId = null;
              session.messageCount++;

              log.info(`[horizon_v8] Done ${fullContent.length}ch (tool=${!!toolCall})`);
            } catch (e: any) {
              log.error(`[horizon_v8] Stream error: ${e.message}`);
              const empty = makeEmptyUsage();
              stream.push({
                type: "error", reason: "error",
                error: { role: "assistant", content: [{ type: "text", text: "" }], api: "openai-completions", provider: "horizon_v8", model: model?.id || "unknown", usage: empty, stopReason: "error", errorMessage: e.message, timestamp: Date.now() },
              });
            }
          })();

          return stream;
        };
      },
    });

    // -----------------------------------------------------------------------
    // Model catalog
    // -----------------------------------------------------------------------
    api.registerModelCatalogProvider({
      provider: "horizon_v8",
      kinds: ["text"],
      liveCatalog: async () => SUPPORTED_MODELS.map(id => {
        const mc = MODEL_CONFIGS[id];
        return { kind: "text" as const, provider: "horizon_v8", model: `horizon_v8/${id}`, label: mc.real_model, source: "static" as const };
      }),
    });

    // -----------------------------------------------------------------------
    // Command
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "horizon_status",
      description: "Show horizon_v8 status",
      handler: () => ({
        text: [
          "🌅 **Horizon V8**",
          `Accounts: ${accounts.length}`,
          ...accounts.map(a => {
            const r = Math.max(0, Math.ceil((a.cooldownUntil - Date.now()) / 1000));
            return `  ${a.id}: ${a.cooldownUntil > Date.now() ? `⏳ cd ${r}s` : "✅"} (${a.failures} errors)`;
          }),
          `Sessions: ${sessions.size}`,
          "",
          `**Models (${SUPPORTED_MODELS.length})**`,
          ...SUPPORTED_MODELS.map(id => `  \`${id}\`: ${MODEL_CONFIGS[id].real_model}`),
        ].join("\n"),
      }),
    });

    log.info(`[horizon_v8] Registered with ${accounts.length} account(s)`);
  },
});
