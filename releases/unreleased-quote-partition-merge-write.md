# Quote partition merge-on-write fix

Fixed a data-loss bug where a single-ticker `fetch_quotes` rewrote the entire
underlying/date Parquet quote partition, wiping other contracts on that date.
Quote writes now replace only the incoming tickers' minutes and preserve all
other contracts, including their stored Greeks and source/rate provenance.

Both quote-store writes and whole-partition flat-file imports now refuse
publications with fewer than half the existing rows. `QuotePartitionShrinkError`
names the partition, existing and candidate row counts, and the 0.5 threshold;
the existing file remains untouched. Exactly half is accepted. Fresh/empty
partitions and growth from any size remain allowed, including full-day imports
that restore previously truncated data. No override or new provider requirement
is introduced, and tool inputs and outputs are unchanged.

This fix does not recover data already lost. See the [Market Data Guide](../docs/market-data.md#quote-partition-writes-and-shrink-protection)
for the distinction between ticker-replacing writes and whole-partition imports.
