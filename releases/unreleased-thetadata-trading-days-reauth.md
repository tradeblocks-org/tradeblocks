# ThetaData: trading-day fetches and session recovery

Fixed multi-day ThetaData fetches reported in tradeblocks#562. Intraday
`fetch_bars`, per-ticker and bulk `fetch_quotes`, and `fetch_chain` contract
lists now skip weekends and known XNYS holidays instead of requesting data
for closed markets. The bundled calendar covers 2022–2030; outside that range,
weekends are skipped but weekdays are still requested.

Missing data on a trading day is not silently treated as a holiday. Intraday
bar failures name the date and fail the fetch. Per-ticker quote failures appear
in `requests[]` with `partial` or `error` status, while successful dates are
still written. Daily bars and other providers are unchanged.

When ThetaData invalidates a session, TradeBlocks now re-authenticates once and
retries the request with the new session. Concurrent failures share one login.
If recovery fails, the error explains ThetaData's one-active-session limit:
close another ThetaData terminal or client using the same account, then retry.
