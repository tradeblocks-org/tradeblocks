/**
 * Shared input schema for an explicit capital basis (get_statistics,
 * get_period_returns).
 */

import { z } from "zod";
import type { CapitalBasis } from "@tradeblocks/lib";

export const capitalBasisSchema = z
  .discriminatedUnion("mode", [
    z.object({
      mode: z.literal("fixed"),
      amount: z.number().positive().describe("Capital every return is divided by, in dollars."),
    }),
    z.object({
      mode: z.literal("compounding"),
      amount: z
        .number()
        .positive()
        .optional()
        .describe("Starting capital in dollars. Default: the block's resolved starting capital."),
    }),
  ])
  .describe(
    "Optional capital basis for percent figures. 'fixed': P&L / amount. 'compounding': P&L / " +
      "(amount + all earlier P&L). Dollar figures do not change; trade sizes stay as logged.",
  );

export type CapitalBasisInput = z.infer<typeof capitalBasisSchema>;

/** Resolve the input to a basis with an amount, and say where the amount came from. */
export function resolveCapitalBasis(
  input: CapitalBasisInput,
  fallback: { amount: number; source: string },
): { basis: CapitalBasis; amountSource: string } {
  if (input.amount !== undefined) {
    return { basis: { mode: input.mode, amount: input.amount }, amountSource: "input" };
  }
  return {
    basis: { mode: input.mode, amount: fallback.amount },
    amountSource: fallback.source,
  };
}
