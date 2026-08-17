import type { Env } from "./session";
import type { JoinPlayerInput, RollInput, SubmitActionInput } from "./types";

export { GameSession } from "./session";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

async function body<T>(request: Request): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json.");
  }

  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} must be a non-empty string.`);
  }
  return value;
}

function getSession(env: Env, sessionId: string) {
  return env.GAME_SESSIONS.getByName(sessionId);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (request.method === "GET" && path === "/health") {
        return json({ ok: true, service: "ootb-ai-game-runner-cfw", provider: "mock" });
      }

      if (request.method === "POST" && path === "/sessions") {
        const input = await body<{ title?: unknown; scenarioId?: unknown }>(request);
        const sessionId = crypto.randomUUID();
        const stub = getSession(env, sessionId);
        const state = await stub.initialize({
          sessionId,
          title: typeof input.title === "string" ? input.title : undefined,
          scenarioId: typeof input.scenarioId === "string" ? input.scenarioId : undefined,
        });
        return json(state, 201);
      }

      const match = /^\/sessions\/([^/]+)(?:\/(players|actions|rolls|run-turn|transcript))?$/.exec(path);
      if (!match) {
        throw new HttpError(404, "Route not found.");
      }

      const sessionId = decodeURIComponent(match[1]);
      const resource = match[2];
      const stub = getSession(env, sessionId);

      if (request.method === "GET" && !resource) {
        return json(await stub.getState());
      }

      if (request.method === "GET" && resource === "transcript") {
        const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
        return json({ messages: await stub.getPublicTranscript(limit) });
      }

      if (request.method === "POST" && resource === "players") {
        const input = await body<Partial<JoinPlayerInput>>(request);
        const name = requireString(input.name, "name");
        const kind = input.kind ?? "human";
        if (kind !== "human" && kind !== "ai") {
          throw new HttpError(400, "kind must be 'human' or 'ai'.");
        }

        const player = await stub.joinPlayer({
          id: typeof input.id === "string" && input.id.trim() ? input.id : crypto.randomUUID(),
          name,
          kind,
        });
        return json(player, 201);
      }

      if (request.method === "POST" && resource === "actions") {
        const input = await body<Partial<SubmitActionInput>>(request);
        const playerId = requireString(input.playerId, "playerId");
        const content = requireString(input.content, "content");
        if (input.visibility !== undefined && input.visibility !== "public" && input.visibility !== "gm") {
          throw new HttpError(400, "visibility must be 'public' or 'gm'.");
        }

        return json(
          await stub.submitAction({ playerId, content, visibility: input.visibility }),
          201,
        );
      }

      if (request.method === "POST" && resource === "rolls") {
        const input = await body<Partial<RollInput>>(request);
        const notation = requireString(input.notation, "notation");
        return json(
          await stub.recordRoll({
            notation,
            actorId: typeof input.actorId === "string" ? input.actorId : undefined,
            reason: typeof input.reason === "string" ? input.reason : undefined,
          }),
          201,
        );
      }

      if (request.method === "POST" && resource === "run-turn") {
        return json(await stub.runTurn());
      }

      throw new HttpError(405, "Method not allowed for this route.");
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }

      const message = error instanceof Error ? error.message : "Unexpected error.";
      const clientError = /must|invalid|unknown|already|not been initialized/i.test(message);
      return json({ error: message }, clientError ? 400 : 500);
    }
  },
} satisfies ExportedHandler<Env>;
