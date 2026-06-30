import { definePluginEntry } from "openclaw/plugin-sdk/core";
import http from "node:http";
import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HorizonConfig {
  provider?: string;           // deepseek-web | deepseek-api | qwen | gemini
  apiKey?: string;
  authDir?: string;
  defaultModel?: string;
  port?: number;
  models?: Record<string, ModelConfig>;
  fallbacks?: Record<string, string>;
}

interface ModelConfig {
  id: string;
  name: string;
  provider: string;            // deepseek-web | deepseek-api | deepseek-official | qwen | gemini
  apiBase?: string;            // для deepseek-api (https://api.deepseek.com)
  apiKeyEnv?: string;          // переменная окружения для API ключа
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

interface SessionState {
  id: string | null;
  parentMessageId: string | null;
  createdAt: number | null;
  messageCount: number;
  accountId: string | null;
  history: Array<{ role: string; content: string }>;
}

// ---------------------------------------------------------------------------
// Default models
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: Record<string, ModelConfig> = {
  "deepseek-chat": {
    id: "deepseek-chat",
    name: "DeepSeek Chat (V4 Flash)",
    provider: "deepseek-web",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 8192,
  },
  "deepseek-reasoner": {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    provider: "deepseek-web",
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 65536,
  },
  "deepseek-v4-flash": {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "deepseek-api",
    apiBase: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 384000,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig(config: Record<string, any> | null): HorizonConfig {
  if (!config?.plugins?.entries?.horizon_v8?.config) return {};
  return config.plugins.entries.horizon_v8.config as HorizonConfig;
}

function loadOpenClawConfig(): Record<string, any> | null {
  const candidates = [
    join(homedir(), ".openclaw", "openclaw.json"),
    "/home/admin/.openclaw/openclaw.json",
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
  }
  return null;
}

function getLogger(api: any) {
  return api.logger ?? console;
}

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

class ModelRouter {
  private models: Record<string, ModelConfig>;
  private fallbacks: Record<string, string>;
  private log: any;

  constructor(config: HorizonConfig, log: any) {
    this.models = { ...DEFAULT_MODELS, ...(config.models ?? {}) };
    this.fallbacks = config.fallbacks ?? {};
    this.log = log;
  }

  getModel(modelId: string): ModelConfig | null {
    return this.models[modelId] ?? null;
  }

  getFallback(modelId: string): string | null {
    return this.fallbacks[modelId] ?? null;
  }

  listModels(): Array<{ id: string; name: string; provider: string }> {
    return Object.values(this.models).map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
    }));
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

interface ProviderHandler {
  complete(
    messages: Array<{ role: string; content: string }>,
    model: string,
    stream: boolean,
  ): AsyncGenerator<
    { type: "delta" | "done" | "error"; content?: string; finish?: string },
    void,
    unknown
  >;
}

/** Официальный DeepSeek API (api.deepseek.com) — OpenAI-compatible */
class DeepSeekOfficialAPI implements ProviderHandler {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.deepseek.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async *complete(
    messages: Array<{ role: string; content: string }>,
    model: string,
    stream: boolean,
  ) {
    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      yield { type: "error" as const, content: `DeepSeek API error: ${resp.status} ${err}` };
      return;
    }

    if (stream && resp.body) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            yield { type: "done" as const, finish: "stop" };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            const finish = parsed.choices?.[0]?.finish_reason;
            if (delta?.content) {
              yield { type: "delta" as const, content: delta.content };
            }
            if (finish) {
              yield { type: "done" as const, finish };
              return;
            }
          } catch {
            // skip parse errors
          }
        }
      }
      yield { type: "done" as const, finish: "stop" };
    } else if (!stream) {
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content ?? "";
      yield { type: "delta" as const, content };
      yield { type: "done" as const, finish: "stop" };
    }
  }
}

// ---------------------------------------------------------------------------
// Local HTTP Server for OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

function startLocalServer(router: ModelRouter, providers: Map<string, ProviderHandler>, port: number, log: any): number {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Models list
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: router.listModels().map((m) => ({
            id: m.id,
            object: "model",
            created: 1700000000,
            owned_by: m.provider,
          })),
        }),
      );
      return;
    }

    // Chat completions
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const params = JSON.parse(body);
          const model = params.model ?? "deepseek-chat";
          const stream = params.stream === true;
          const messages = params.messages ?? [];

          const modelCfg = router.getModel(model);
          if (!modelCfg) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Unknown model: ${model}` }));
            return;
          }

          const provider = providers.get(modelCfg.provider);
          if (!provider) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `No provider for model: ${model}` }));
            return;
          }

          if (stream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });

            for await (const chunk of provider.complete(messages, modelCfg.id, true)) {
              if (chunk.type === "delta") {
                res.write(
                  `data: ${JSON.stringify({
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000) as number,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: chunk.content },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                );
              } else if (chunk.type === "done") {
                res.write(
                  `data: ${JSON.stringify({
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000) as number,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: chunk.finish ?? "stop",
                      },
                    ],
                  })}\n\n`,
                );
                res.write("data: [DONE]\n\n");
                res.end();
              } else if (chunk.type === "error") {
                res.write(
                  `data: ${JSON.stringify({
                    error: { message: chunk.content },
                  })}\n\n`,
                );
                res.end();
              }
            }
          } else {
            let fullContent = "";
            for await (const chunk of provider.complete(messages, modelCfg.id, false)) {
              if (chunk.type === "delta" && chunk.content) {
                fullContent += chunk.content;
              } else if (chunk.type === "error") {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: chunk.content }));
                return;
              }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000) as number,
                model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: fullContent,
                    },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: estimateTokens(JSON.stringify(messages)),
                  completion_tokens: estimateTokens(fullContent),
                },
              }),
            );
          }
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Health
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", provider: "horizon_v8", models: router.listModels().length }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    if (addr && typeof addr === "object") {
      log.info(`[horizon_v8] Server started on http://127.0.0.1:${addr.port}`);
    }
  });

  const addr = server.address();
  return addr && typeof addr === "object" ? addr.port : 0;
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "horizon_v8",
  name: "Horizon V8",
  description: "Кастомный model provider с несколькими бэкендами (DeepSeek Web/API, Qwen3, Gemini)",

  register(api: any) {
    const log = getLogger(api);
    const config = loadOpenClawConfig();
    const hc = loadConfig(config);

    // Создаём роутер моделей и провайдеры
    const router = new ModelRouter(hc, log);

    // Инициализируем провайдеры
    const providers = new Map<string, ProviderHandler>();

    // Официальный DeepSeek API
    const apiKey = hc.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
    if (apiKey) {
      providers.set("deepseek-api", new DeepSeekOfficialAPI(apiKey));
      log.info("[horizon_v8] DeepSeek Official API initialized");
    }

    // Запускаем локальный HTTP-сервер
    const requestedPort = hc.port ?? 0;
    const actualPort = startLocalServer(router, providers, requestedPort, log);

    // Команда: статус horizon_v8
    api.registerCommand({
      name: "horizon_status",
      description: "Показать статус horizon_v8: модели, провайдеры, порт",
      handler: () => {
        const models = router.listModels();
        const providerStatus: string[] = [];
        for (const [p, _] of providers) {
          providerStatus.push(`  - ${p}: ✅`);
        }

        return {
          text: [
            "🌅 **Horizon V8**",
            `HTTP port: ${actualPort}`,
            `Providers: ${providers.size === 0 ? "⚠️ нет активных" : ""}`,
            ...providerStatus,
            "",
            `**Models (${models.length})**`,
            ...models.map(
              (m) => `  - \`${m.id}\` (${m.provider}): ${m.name}`,
            ),
          ].join("\n"),
        };
      },
    });

    log.info(`[horizon_v8] Plugin registered with ${providers.size} provider(s)`);
  },
});
