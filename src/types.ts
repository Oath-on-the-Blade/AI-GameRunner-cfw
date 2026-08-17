export type PlayerKind = "human" | "ai";
export type Visibility = "public" | "gm";
export type SessionStatus = "lobby" | "running" | "completed";

export interface CreateSessionInput {
  sessionId: string;
  title?: string;
  scenarioId?: string;
}

export interface JoinPlayerInput {
  id: string;
  name: string;
  kind: PlayerKind;
}

export interface SubmitActionInput {
  playerId: string;
  content: string;
  visibility?: Visibility;
}

export interface RollInput {
  actorId?: string;
  notation: string;
  reason?: string;
}

export interface DiceResult {
  notation: string;
  dice: number[];
  modifier: number;
  total: number;
}

export interface PublicPlayer {
  id: string;
  name: string;
  kind: PlayerKind;
  createdAt: string;
}

export interface PublicSessionState {
  sessionId: string;
  title: string;
  scenarioId: string | null;
  status: SessionStatus;
  turn: number;
  createdAt: string;
  updatedAt: string;
  players: PublicPlayer[];
  pendingActions: number;
  messageCount: number;
  rollCount: number;
}

export interface PublicMessage {
  id: number;
  turn: number;
  actorId: string | null;
  actorName: string;
  role: "player" | "gm" | "system";
  content: string;
  createdAt: string;
}

export interface RunTurnResult {
  turn: number;
  processedActions: number;
  gmMessage: PublicMessage | null;
}
