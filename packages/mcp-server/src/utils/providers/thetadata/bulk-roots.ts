/** Wire-level roots that ThetaData bulk quote ingestion expands an underlying into. */
export function bulkQuoteRootsForUnderlying(underlying: string): string[] {
  const upper = underlying.toUpperCase();
  return upper === "SPX" ? ["SPX", "SPXW"] : [upper];
}

/** Number of final root/right groups per date. */
export function countBulkQuoteGroupsPerDate(underlying: string): number {
  return bulkQuoteRootsForUnderlying(underlying).length * 2;
}
