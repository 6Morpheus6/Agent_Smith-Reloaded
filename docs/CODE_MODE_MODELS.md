# Code Mode — choosing and loading a model

Code Mode (the autonomous build loop) is far more demanding than Chat: it must emit
**tool calls** (e.g. `write_file`) and whole source files, turn after turn. Model choice
is the single biggest factor in whether a run succeeds or appears to "freeze."

## Recommended models

- **Prefer a coder, non-reasoning model.** Coder models emit file contents / tool calls
  directly instead of spending the reply budget "thinking." Good local picks:
  - `Qwen2.5-Coder-7B-Instruct` (small, fast, strong at this) or `-14B`
  - `DeepSeek-Coder-V2-Lite`, `GLM-4` coder variants
- **Avoid pure reasoning models for builds** (anything that streams `reasoning_content`,
  e.g. some Gemma/Qwen3/R1 variants). They can spend an entire turn reasoning and emit
  **empty content**, which reads as a frozen run. Code Mode now detects this and retries
  with a larger budget + a "stop reasoning, act now" nudge — but a coder model is faster
  and more reliable.
- **General instruct models work but are weaker** — expect more reflection turns.

## VRAM: why a model "fails to load"

LM Studio JIT-loads a model on first request. If the GPU is already full, the load fails
with `Failed to load model` after a long pause — which looks like a hang. Symptoms:

```
$ nvidia-smi --query-gpu=memory.total,memory.used,memory.free --format=csv,noheader
24576 MiB, 19276 MiB, 4815 MiB      # only ~4.8 GB free → a 18 GB model can't load
```

A 24 GB GPU typically holds **one** large model (+ its KV cache, which grows with context)
plus a small embedding model. Loading a second large model will fail until you free VRAM.

### Switch models with the `lms` CLI

```bash
export PATH="$HOME/.lmstudio/bin:$PATH"
lms ps                                   # what's loaded (and its context/VRAM)
lms ls                                   # what's downloaded
lms unload <big-model-id>                # free VRAM
lms load <coder-model-id> --context-length 16384 -y   # load with a sane context
```

Keep the embedding model (`text-embedding-*`, tiny) loaded for memory features — see
[LM Studio embeddings](../README.md). Then pick the coder model in the app's model dropdown.

## Tuning the run watchdog and timeouts

Code Mode emits periodic `heartbeat` events and aborts a genuinely stalled run instead of
hanging silently. Defaults can be overridden with env vars:

| Env var | Default | Meaning |
|---|---|---|
| `XK_CODE_HEARTBEAT_MS` | `20000` | liveness/heartbeat interval |
| `XK_CODE_INACTIVITY_MS` | `1200000` | abort if no progress for this long (20 min) |
| `XK_CODE_MAX_RUNTIME_MS` | `7200000` | hard wall-clock cap for a run (120 min) |
| `XK_CODE_STREAM_IDLE_MS` | `600000` | idle window between tokens (10 min) |
| `XK_CODE_STREAM_FIRST_TOKEN_MS` | `900000` | window for first token/prompt processing (15 min) |
| `XK_EMBED_MODEL` | _(auto)_ | force a specific LM Studio embedding model id |
| `XK_SMOKE_JSDOM` | _(off)_ | opt into jsdom smoke verification (default: VM engine) |

## Quick sanity check

A model is Code-Mode-ready if a tiny request returns **non-empty `content`** quickly:

```bash
curl -s http://127.0.0.1:1234/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"<id>","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":40}' \
  | python3 -c "import sys,json;m=json.load(sys.stdin)['choices'][0]['message'];print('content:',repr(m.get('content')),'reasoning:',len(m.get('reasoning_content') or ''))"
```

If `content` is empty and `reasoning` is large, it's a reasoning model — prefer a coder model.
