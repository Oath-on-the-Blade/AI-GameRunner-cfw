import type { GameMasterProvider, ProviderInput, ProviderOutput } from "./types";

export class MockGameMasterProvider implements GameMasterProvider {
  readonly name = "mock";

  async generateTurn(input: ProviderInput): Promise<ProviderOutput> {
    if (input.actions.length === 0) {
      return {
        content: `Turn ${input.turn}: no player actions were submitted.`,
      };
    }

    const summary = input.actions
      .map((action) =>
        action.visibility === "public"
          ? `${action.playerName}: ${action.content}`
          : `${action.playerName}: [GM-only action]`,
      )
      .join(" | ");

    return {
      content: `[MOCK GM · Turn ${input.turn}] Received ${input.actions.length} action(s): ${summary}`,
    };
  }
}
