# Horizon V8 🌅

Кастомный model provider для OpenClaw. Замена внешнего HTTP-прокси (FreeDeepseekAPI).
Предоставляет несколько бэкендов через единый OpenAI-совместимый endpoint на localhost.

## Мотивация

- **FreeDeepseekAPI** — внешний процесс с открытым портом, нестабильный, требует фаервола
- **Мульти-модельность** — DeepSeek (Web + API), Qwen3, Gemini в одном месте
- **Фолбеки** — при ошибке одного бэкенда переключаться на другой
- **Одно конфигурирование** — все провайдеры в openclaw.json

## Структура

```
horizon_v8/
├── openclaw.plugin.json   # манифест плагина
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts           # основной код
└── dist/
    └── index.js           # скомпилированный (ESM)
```

## Архитектура

```
┌─────────────────────────────────────────┐
│              OpenClaw Gateway            │
│  ┌─────────────────────────────────┐   │
│  │         Horizon V8 Plugin        │   │
│  │  ┌───────────┐  ┌────────────┐ │   │
│  │  │  Router    │  │ Local HTTP │ │   │
│  │  │  Models    │◄─┤ Server     │ │   │
│  │  │  Fallbacks │  │ :random    │ │   │
│  │  └─────┬─────┘  └─────┬──────┘ │   │
│  │        │               │        │   │
│  │  ┌─────▼───────────────▼──┐    │   │
│  │  │     Provider Layer      │    │   │
│  │  │  deepseek-web │ qwen    │    │   │
│  │  │  deepseek-api │ gemini  │    │   │
│  │  └─────┬──────────┬───────┘    │   │
│  └────────┼──────────┼────────────┘   │
└───────────┼──────────┼────────────────┘
            │          │
   ┌────────▼──┐ ┌─────▼────────┐
   │  DeepSeek  │ │  Qwen/Gemini │
   │  Web API   │ │  API (future)│
   │ (PoW/WASM) │ │              │
   └────────────┘ └──────────────┘
```

## Установка

```bash
# 1. Клонировать
git clone git@github.com:amalkovich1/horizon_v8.git /srv/git/horizon_v8

# 2. Установить зависимости
cd /srv/git/horizon_v8
ln -sf /home/admin/.npm-global/lib/node_modules/openclaw node_modules/openclaw

# 3. Собрать
npx tsc

# 4. Скопировать в extensions
cp -a /srv/git/horizon_v8 /home/admin/.openclaw/extensions/horizon_v8

# 5. Добавить в openclaw.json
```

## Конфигурация

В `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "horizon_v8": {
        "enabled": true,
        "config": {
          "provider": "deepseek-web",
          "apiKey": "",
          "authDir": "/home/admin/.openclaw/horizon_v8/auth",
          "defaultModel": "deepseek-chat",
          "port": 0,
          "fallbacks": {
            "deepseek-reasoner": "deepseek-chat"
          }
        }
      }
    },
    "allow": ["horizon_v8"]
  }
}
```

## Модели

| Имя | Провайдер | Reasoning | Контекст |
|-----|-----------|-----------|----------|
| `deepseek-chat` | deepseek-web | ❌ | 128K |
| `deepseek-reasoner` | deepseek-web | ✅ | 128K |
| `deepseek-v4-flash` | deepseek-api | ✅ | 1M |

## Команды

- `/horizon_status` — статус: порт, активные провайдеры, список моделей

## Разработка

### Добавление нового провайдера

Создать класс, имплементирующий `ProviderHandler`:

```typescript
class MyProvider implements ProviderHandler {
  async *complete(messages, model, stream) {
    yield { type: "delta", content: "..." };
    yield { type: "done", finish: "stop" };
  }
}
```

Зарегистрировать в `register()`:

```typescript
providers.set("my-provider", new MyProvider(config));
```

Добавить модель в конфиг:

```json
{
  "models": {
    "my-model": { "id": "my-model", "name": "...", "provider": "my-provider" }
  }
}
```

## Лицензия

MIT
