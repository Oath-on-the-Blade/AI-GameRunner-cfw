# OOTB AI Game Runner — Cloudflare Workers

A serverless MVP for running **Oath on the Blade (OOTB)** game sessions with one Durable Object per table/session and SQLite-backed Durable Object storage.

The first version deliberately uses a **mock GM provider**, so it can run without OpenAI, Anthropic, Gemini, or any other API key.

## What is implemented

- Cloudflare Worker HTTP API.
- One `GameSession` Durable Object per OOTB session.
- SQLite-backed Durable Object storage for session metadata, players, actions, messages, dice rolls, and reserved secret state.
- Human and AI player records.
- Public or GM-only player actions.
- Server-side dice rolling (`NdM`, `NdM+K`, `NdM-K`).
- A mock GM turn processor for end-to-end testing.
- Public transcript endpoint that never returns GM-only rows.
- No API keys or credentials in source/configuration.

This is an infrastructure MVP, not yet an implementation of the OOTB Handbook rules engine.

## Architecture

```text
Client / AI player
       |
       v
Cloudflare Worker
       |
       | Durable Object RPC
       v
GameSession(session-id)
       |
       +-- SQLite: metadata
       +-- SQLite: players
       +-- SQLite: actions
       +-- SQLite: messages
       +-- SQLite: rolls
       +-- SQLite: secrets (not exposed over HTTP)
       |
       v
Mock GM provider
```

A session ID is mapped with `GAME_SESSIONS.getByName(sessionId)`, so requests for the same session are coordinated by the same Durable Object.

## Local setup

Requirements:

- Node.js 20+.
- A Cloudflare account for deployment. Local development does not require AI provider credentials.

```bash
npm install
npm run types
npm run check
npm run dev
```

Wrangler will print the local URL, normally `http://localhost:8787`.

## Try the MVP

Health check:

```bash
curl http://localhost:8787/health
```

Create a session:

```bash
curl -s -X POST http://localhost:8787/sessions \
  -H 'content-type: application/json' \
  -d '{"title":"Rain at the Riverside Inn","scenarioId":"dev-smoke-test"}'
```

Copy the returned `sessionId`, then add a player:

```bash
curl -s -X POST http://localhost:8787/sessions/SESSION_ID/players \
  -H 'content-type: application/json' \
  -d '{"id":"p1","name":"Shen Qingyi","kind":"human"}'
```

Submit an action:

```bash
curl -s -X POST http://localhost:8787/sessions/SESSION_ID/actions \
  -H 'content-type: application/json' \
  -d '{"playerId":"p1","content":"I examine the doorway for signs of an ambush."}'
```

Roll dice:

```bash
curl -s -X POST http://localhost:8787/sessions/SESSION_ID/rolls \
  -H 'content-type: application/json' \
  -d '{"actorId":"p1","notation":"2d6+1","reason":"smoke test"}'
```

Resolve the queued actions with the mock GM:

```bash
curl -s -X POST http://localhost:8787/sessions/SESSION_ID/run-turn
```

Read public state and transcript:

```bash
curl -s http://localhost:8787/sessions/SESSION_ID
curl -s 'http://localhost:8787/sessions/SESSION_ID/transcript?limit=100'
```

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `POST` | `/sessions` | Create a session |
| `GET` | `/sessions/:id` | Read public session state |
| `POST` | `/sessions/:id/players` | Join a human or AI player |
| `POST` | `/sessions/:id/actions` | Queue an action |
| `POST` | `/sessions/:id/rolls` | Record a server-side dice roll |
| `POST` | `/sessions/:id/run-turn` | Resolve pending actions with the mock GM |
| `GET` | `/sessions/:id/transcript` | Read public transcript only |

The MVP has no authentication yet, so it should not be exposed as a production public game service. Player-private delivery/authentication is a later milestone.

## Secret handling

**Never commit provider credentials.**

The repository ignores `.dev.vars`, `.env`, and their local variants. `.dev.vars.example` contains variable names only and no values.

For local development after real providers are added:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars locally. Do not commit it.
```

For deployed Workers, use Cloudflare secrets instead of `wrangler.jsonc`:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY
```

Only add the secret actually required by an enabled provider.

## Deploy

Authenticate Wrangler and deploy:

```bash
npx wrangler login
npm run deploy
```

`wrangler.jsonc` intentionally contains no account ID, token, API key, or provider credential.

## Next milestones

1. Add OOTB Handbook/scenario context loading.
2. Define canonical OOTB game state separately from transcript text.
3. Add provider adapters behind the `GameMasterProvider` interface.
4. Add player authentication and private player observations.
5. Add deterministic OOTB rules resolution and richer dice/check records.
6. Add automated AI playtest runs and post-run reports.
