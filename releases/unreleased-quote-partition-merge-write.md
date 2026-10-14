# Quote partition merge-on-write fix

Fixed a data-loss bug where a single-ticker `fetch_quotes` rewrote the entire
underlying/date Parquet quote partition, wiping other contracts on that date.
Quote writes now replace only the incoming tickers' minutes and preserve all
other contracts, including their stored Greeks and source/rate provenance.
Multi-ticker `fetch_quotes` batches accepted rows and flushes after each complete
ticker if pending rows reach 32,768, then publishes any remainder even
when a later provider request fails. Pending rows are bounded by that threshold
plus one ticker's accepted batch. A 79-ticker, 391-minute date stays together;
larger requests may publish a partition more than once, retaining earlier
tickers through merge-on-write.

Both quote-store writes and whole-partition flat-file imports now refuse
publications with fewer than half the existing rows. `QuotePartitionShrinkError`
names the partition, existing and candidate row counts, and the 0.5 threshold;
the existing file remains untouched. Exactly half is accepted. Fresh/empty
partitions and growth from any size remain allowed, including full-day imports
that restore previously truncated data. No override or new provider requirement
is introduced, and tool inputs and outputs are unchanged.
If the existing partition file is unreadable, both write entrances refuse with
the underlying DuckDB error and leave the file untouched; move the corrupt
file aside before re-importing that date.

This fix does not recover data already lost. See the [Market Data Guide](../docs/market-data.md#quote-partition-writes-and-shrink-protection)
for the distinction between ticker-replacing writes and whole-partition imports.
