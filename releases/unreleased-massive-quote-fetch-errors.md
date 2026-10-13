# Unreleased — Massive quote-fetch request outcomes

`fetch_quotes` no longer reports Massive HTTP, invalid-payload, network, timeout, or pagination-limit failures as successful empty requests. Massive per-ticker output adds `requests[]` with ticker/date, `outcome` (`ok`, `empty`, `error`), returned minute `rows`, successfully decoded `pagesFetched`, and optional `httpStatus`/`errorClass`.

Failed ticker-dates discard every fetched page before enrichment and quote-cache writes. Successful other dates remain available, with top-level `partial` and a failure summary; all-failed requests return `error`. Genuine empty successes still return `ok` with zero rows. Both NBBO and the `synth_close` fallback report outcomes. ThetaData is unchanged.

The provider Map return and successful quote values are preserved. An optional `fetchQuotes` observer carries receipts without throwing away good dates. Market-data integrations remain opt-in and CSV import still needs no provider key. No retry or tier policy is changed.

NBBO date iteration now preserves the requested calendar days in every host timezone, including east-of-UTC hosts.

NBBO-skipped weekends emit no receipt, rather than counting as empty success. A Friday–Sunday request whose only trading day failed therefore returns `error`, not `partial`.

`synth_close` keeps its existing single paginated range fetch with or without an observer; request count and retry policy are unchanged. Per-date receipts are derived from the range rows, and each receipt reports the same range-level page count. If any range page fails, all range rows are discarded and every date in the range reports `error`.
