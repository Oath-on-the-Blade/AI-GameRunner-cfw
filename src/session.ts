import { DurableObject } from "cloudflare:workers";
import { rollDice } from "./dice";
import { MockGameMasterProvider } from "./providers/mock";
import type { ProviderAction } from "./providers/types";
import type {
  CreateSessionInput,
  JoinPlayerInput,
  PublicMessage,
  PublicPlayer,
  PublicSessionState,
  RollInput,
  RunTurnResult,
  SubmitActionInput,
} from "./types";

export interface Env {
  GAME_SESSIONS: DurableObjectNamespace<GameSession>;
}

type MetadataRow = {
  session_id: string;
  title: string;
  scenario_id: string | null;
  status: "lobby" | "running" | "completed";
  turn: number;
  created_at: string;
  updated_at: string;
};

type PlayerRow = {
  id: string;
  name: string;
  kind: "human" | "ai";
  created_at: string;
};

type ActionRow = {
  id: number;
  player_id: string;
  player_name: string;
  content: string;
  visibility: "public" | "gm";
};

type MessageRow = {
  id: number;
  turn: number;
  actor_id: string | null;
  actor_name: string;
  role: "player" | "gm" | "system";
  content: string;
  created_at: string;
};

function now(): string {
  return new Date().toISOString();
}

function rows<T>(cursor: Iterable<unknown>): T[] {
  return Array.from(cursor) as T[];
}

function one<T>(cursor: Iterable<unknown>): T | null {
  const result = rows<T>(cursor);
  return result[0] ?? null;
}

export class GameSession extends DurableObject<Env> {
  private readonly gm = new MockGameMasterProvider();
  private turnInProgress = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        session_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        scenario_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('lobby', 'running', 'completed')),
        turn INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('human', 'ai')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submitted_turn INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        content TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'gm')),
        created_at TEXT NOT NULL,
        resolved_turn INTEGER,
        FOREIGN KEY (player_id) REFERENCES players(id)
      );

      CREATE INDEX IF NOT EXISTS idx_actions_pending
        ON actions(resolved_turn, submitted_turn, id);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn INTEGER NOT NULL,
        actor_id TEXT,
        actor_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('player', 'gm', 'system')),
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'gm')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_turn
        ON messages(turn, id);

      CREATE TABLE IF NOT EXISTS rolls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn INTEGER NOT NULL,
        actor_id TEXT,
        notation TEXT NOT NULL,
        dice_json TEXT NOT NULL,
        modifier INTEGER NOT NULL,
        total INTEGER NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS secrets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('gm', 'player')),
        owner_id TEXT,
        secret_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_secret_owner_key
        ON secrets(owner_type, COALESCE(owner_id, ''), secret_key);
    `);
  }

  initialize(input: CreateSessionInput): PublicSessionState {
    const existing = this.getMetadata();
    if (existing) {
      if (existing.session_id !== input.sessionId) {
        throw new Error("Durable Object is already initialized for another session.");
      }
      return this.getState();
    }

    const timestamp = now();
    const title = cleanText(input.title ?? "Untitled OOTB Session", "title", 160);
    const scenarioId = input.scenarioId ? cleanText(input.scenarioId, "scenarioId", 200) : null;

    this.ctx.storage.sql.exec(
      `INSERT INTO metadata
       (singleton, session_id, title, scenario_id, status, turn, created_at, updated_at)
       VALUES (1, ?, ?, ?, 'lobby', 0, ?, ?)`,
      input.sessionId,
      title,
      scenarioId,
      timestamp,
      timestamp,
    );

    this.insertMessage(0, null, "System", "system", "public", `Session ${input.sessionId} created.`);
    return this.getState();
  }

  joinPlayer(input: JoinPlayerInput): PublicPlayer {
    this.requireMetadata();
    const id = cleanText(input.id, "player id", 120);
    const name = cleanText(input.name, "player name", 120);
    if (input.kind !== "human" && input.kind !== "ai") {
      throw new Error("Player kind must be 'human' or 'ai'.");
    }

    const existing = one<PlayerRow>(
      this.ctx.storage.sql.exec("SELECT id, name, kind, created_at FROM players WHERE id = ?", id),
    );
    if (existing) {
      if (existing.name !== name || existing.kind !== input.kind) {
        throw new Error("Player id already exists with different player data.");
      }
      return mapPlayer(existing);
    }

    const timestamp = now();
    this.ctx.storage.sql.exec(
      "INSERT INTO players (id, name, kind, created_at) VALUES (?, ?, ?, ?)",
      id,
      name,
      input.kind,
      timestamp,
    );
    this.touch();
    this.insertMessage(this.currentTurn(), id, name, "system", "public", `${name} joined the session.`);

    return { id, name, kind: input.kind, createdAt: timestamp };
  }

  submitAction(input: SubmitActionInput): { actionId: number; submittedTurn: number } {
    this.requireMetadata();
    const playerId = cleanText(input.playerId, "playerId", 120);
    const content = cleanText(input.content, "action content", 4000);
    const visibility = input.visibility ?? "public";
    if (visibility !== "public" && visibility !== "gm") {
      throw new Error("Action visibility must be 'public' or 'gm'.");
    }

    const player = one<PlayerRow>(
      this.ctx.storage.sql.exec("SELECT id, name, kind, created_at FROM players WHERE id = ?", playerId),
    );
    if (!player) {
      throw new Error("Unknown playerId.");
    }

    const submittedTurn = this.currentTurn() + 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO actions
       (submitted_turn, player_id, content, visibility, created_at, resolved_turn)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      submittedTurn,
      playerId,
      content,
      visibility,
      now(),
    );

    const actionId = this.lastInsertId();
    this.insertMessage(submittedTurn, playerId, player.name, "player", visibility, content);
    this.touch();

    return { actionId, submittedTurn };
  }

  recordRoll(input: RollInput): { rollId: number; result: ReturnType<typeof rollDice> } {
    this.requireMetadata();
    const notation = cleanText(input.notation, "notation", 40);
    const actorId = input.actorId ? cleanText(input.actorId, "actorId", 120) : null;
    const reason = input.reason ? cleanText(input.reason, "reason", 500) : null;

    if (actorId) {
      const player = one<PlayerRow>(this.ctx.storage.sql.exec("SELECT * FROM players WHERE id = ?", actorId));
      if (!player) {
        throw new Error("Unknown actorId.");
      }
    }

    const result = rollDice(notation);
    const turn = this.currentTurn();
    this.ctx.storage.sql.exec(
      `INSERT INTO rolls
       (turn, actor_id, notation, dice_json, modifier, total, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      turn,
      actorId,
      result.notation,
      JSON.stringify(result.dice),
      result.modifier,
      result.total,
      reason,
      now(),
    );
    const rollId = this.lastInsertId();
    this.touch();
    return { rollId, result };
  }

  async runTurn(): Promise<RunTurnResult> {
    if (this.turnInProgress) {
      throw new Error("A turn is already being resolved for this session.");
    }

    this.turnInProgress = true;
    try {
      const metadata = this.requireMetadata();
      const nextTurn = metadata.turn + 1;

      const pending = rows<ActionRow>(
        this.ctx.storage.sql.exec(
          `SELECT a.id, a.player_id, p.name AS player_name, a.content, a.visibility
           FROM actions a
           JOIN players p ON p.id = a.player_id
           WHERE a.resolved_turn IS NULL AND a.submitted_turn <= ?
           ORDER BY a.id`,
          nextTurn,
        ),
      );

      if (pending.length === 0) {
        return { turn: metadata.turn, processedActions: 0, gmMessage: null };
      }

      const actions: ProviderAction[] = pending.map((action) => ({
        playerId: action.player_id,
        playerName: action.player_name,
        content: action.content,
        visibility: action.visibility,
      }));

      const output = await this.gm.generateTurn({
        sessionId: metadata.session_id,
        turn: nextTurn,
        title: metadata.title,
        scenarioId: metadata.scenario_id,
        actions,
      });

      // Only resolve the exact action rows that were sent to the GM. Actions
      // submitted while a real provider call is in flight remain pending.
      const placeholders = pending.map(() => "?").join(", ");
      this.ctx.storage.sql.exec(
        `UPDATE actions SET resolved_turn = ? WHERE id IN (${placeholders})`,
        nextTurn,
        ...pending.map((action) => action.id),
      );
      this.ctx.storage.sql.exec(
        "UPDATE metadata SET status = 'running', turn = ?, updated_at = ? WHERE singleton = 1",
        nextTurn,
        now(),
      );

      const gmMessage = this.insertMessage(nextTurn, null, "GM", "gm", "public", output.content);
      return { turn: nextTurn, processedActions: pending.length, gmMessage };
    } finally {
      this.turnInProgress = false;
    }
  }

  getState(): PublicSessionState {
    const metadata = this.requireMetadata();
    const players = rows<PlayerRow>(
      this.ctx.storage.sql.exec("SELECT id, name, kind, created_at FROM players ORDER BY created_at, id"),
    ).map(mapPlayer);

    const pending = one<{ count: number }>(
      this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM actions WHERE resolved_turn IS NULL"),
    );
    const messages = one<{ count: number }>(
      this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM messages WHERE visibility = 'public'"),
    );
    const rolls = one<{ count: number }>(this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM rolls"));

    return {
      sessionId: metadata.session_id,
      title: metadata.title,
      scenarioId: metadata.scenario_id,
      status: metadata.status,
      turn: metadata.turn,
      createdAt: metadata.created_at,
      updatedAt: metadata.updated_at,
      players,
      pendingActions: Number(pending?.count ?? 0),
      messageCount: Number(messages?.count ?? 0),
      rollCount: Number(rolls?.count ?? 0),
    };
  }

  getPublicTranscript(limit = 100): PublicMessage[] {
    this.requireMetadata();
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    return rows<MessageRow>(
      this.ctx.storage.sql.exec(
        `SELECT id, turn, actor_id, actor_name, role, content, created_at
         FROM messages
         WHERE visibility = 'public'
         ORDER BY id DESC
         LIMIT ?`,
        safeLimit,
      ),
    )
      .reverse()
      .map(mapMessage);
  }

  private getMetadata(): MetadataRow | null {
    return one<MetadataRow>(
      this.ctx.storage.sql.exec(
        `SELECT session_id, title, scenario_id, status, turn, created_at, updated_at
         FROM metadata WHERE singleton = 1`,
      ),
    );
  }

  private requireMetadata(): MetadataRow {
    const metadata = this.getMetadata();
    if (!metadata) {
      throw new Error("Session has not been initialized.");
    }
    return metadata;
  }

  private currentTurn(): number {
    return this.requireMetadata().turn;
  }

  private touch(): void {
    this.ctx.storage.sql.exec("UPDATE metadata SET updated_at = ? WHERE singleton = 1", now());
  }

  private lastInsertId(): number {
    const row = one<{ id: number }>(this.ctx.storage.sql.exec("SELECT last_insert_rowid() AS id"));
    if (!row) {
      throw new Error("Failed to read inserted row id.");
    }
    return Number(row.id);
  }

  private insertMessage(
    turn: number,
    actorId: string | null,
    actorName: string,
    role: "player" | "gm" | "system",
    visibility: "public" | "gm",
    content: string,
  ): PublicMessage {
    const timestamp = now();
    this.ctx.storage.sql.exec(
      `INSERT INTO messages
       (turn, actor_id, actor_name, role, visibility, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      turn,
      actorId,
      actorName,
      role,
      visibility,
      content,
      timestamp,
    );

    return {
      id: this.lastInsertId(),
      turn,
      actorId,
      actorName,
      role,
      content,
      createdAt: timestamp,
    };
  }
}

function cleanText(value: string, field: string, maxLength: number): string {
  const cleaned = value.trim();
  if (!cleaned) {
    throw new Error(`${field} must not be empty.`);
  }
  if (cleaned.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters.`);
  }
  return cleaned;
}

function mapPlayer(row: PlayerRow): PublicPlayer {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

function mapMessage(row: MessageRow): PublicMessage {
  return {
    id: Number(row.id),
    turn: Number(row.turn),
    actorId: row.actor_id,
    actorName: row.actor_name,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}
