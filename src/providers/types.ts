export interface ProviderAction {
  playerId: string;
  playerName: string;
  content: string;
  visibility: "public" | "gm";
}

export interface ProviderInput {
  sessionId: string;
  turn: number;
  title: string;
  scenarioId: string | null;
  actions: ProviderAction[];
}

export interface ProviderOutput {
  content: string;
}

export interface GameMasterProvider {
  readonly name: string;
  generateTurn(input: ProviderInput): Promise<ProviderOutput>;
}
