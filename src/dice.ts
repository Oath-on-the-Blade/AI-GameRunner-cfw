import type { DiceResult } from "./types";

const DICE_RE = /^\s*(\d{1,3})d(\d{1,4})(?:\s*([+-])\s*(\d{1,5}))?\s*$/i;
const MAX_DICE = 100;
const MAX_SIDES = 1000;

function randomDie(sides: number): number {
  const range = 0x1_0000_0000;
  const limit = range - (range % sides);
  const buffer = new Uint32Array(1);

  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);

  return (buffer[0] % sides) + 1;
}

export function rollDice(notation: string): DiceResult {
  const match = DICE_RE.exec(notation);
  if (!match) {
    throw new Error("Invalid dice notation. Use forms such as 1d20, 2d6+3, or 3d8-1.");
  }

  const count = Number(match[1]);
  const sides = Number(match[2]);
  const sign = match[3] === "-" ? -1 : 1;
  const modifier = match[4] ? sign * Number(match[4]) : 0;

  if (count < 1 || count > MAX_DICE) {
    throw new Error(`Dice count must be between 1 and ${MAX_DICE}.`);
  }
  if (sides < 2 || sides > MAX_SIDES) {
    throw new Error(`Die sides must be between 2 and ${MAX_SIDES}.`);
  }

  const dice = Array.from({ length: count }, () => randomDie(sides));
  const total = dice.reduce((sum, value) => sum + value, 0) + modifier;

  return {
    notation: `${count}d${sides}${modifier === 0 ? "" : modifier > 0 ? `+${modifier}` : modifier}`,
    dice,
    modifier,
    total,
  };
}
