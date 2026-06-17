/**
 * True when a (bid, ask) pair is broken/untradable:
 * - Crossed: bid > ask
 * - Blown spread: ask > 10x bid AND mid > $1
 *
 * Sub-$1 deep-OTM markets can legitimately quote 10x+ ratios, so the dollar
 * floor avoids false positives there.
 */
export function isAnomalousQuote(bid: number, ask: number): boolean {
  if (!(bid > 0 && ask > 0)) return false;
  if (bid > ask) return true;
  if (ask > 10 * bid && (bid + ask) / 2 > 1) return true;
  return false;
}
