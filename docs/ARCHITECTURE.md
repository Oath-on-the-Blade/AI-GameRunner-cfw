# Architecture notes

## Core rule

The model is not the source of truth for game state.

The Durable Object owns canonical session state. AI providers receive a projection of that state and return proposed narration/decisions; deterministic rules and state transitions should remain server-side wherever possible.

## Session isolation

Each OOTB table maps to one Durable Object name:

```text
session ID -> GAME_SESSIONS.getByName(session ID) -> GameSession -> private SQLite database
```

This keeps unrelated tables isolated while giving all requests for one table a single coordination point.

## Storage boundaries

Current tables:

- `metadata`: session lifecycle and turn number.
- `players`: human/AI seats.
- `actions`: queued player intents and whether they have been resolved.
- `messages`: transcript rows with `public` or `gm` visibility.
- `rolls`: server-generated dice results for auditability.
- `secrets`: reserved canonical private state; deliberately not exposed by the HTTP API.

Future OOTB-specific state should use explicit relational tables or versioned JSON records rather than asking an LLM to reconstruct state from transcript text.

## Provider boundary

`GameMasterProvider` is intentionally small. The mock implementation proves the session engine without credentials. Future providers should read keys only from Worker environment secrets.

Provider code must never:

- contain an API key literal;
- log an API key;
- return an API key to a client;
- persist an API key in Durable Object storage;
- accept an API key from a public game request.

## Security status

This MVP intentionally has no end-user authentication. The public HTTP API therefore exposes only public state/transcript. GM-only messages can be stored but are excluded from public transcript queries.

Before internet-facing multiplayer use, add authentication/authorization and bind player identity to a session seat.
