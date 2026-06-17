/**
 * QuoteStore — Abstract base for option minute-quote storage.
 *
 * Phase 1 shipped a single-ticker placeholder signature. Plan 02-03 Task 1
 * replaces it in-place with the multi-ticker grouped-series shape that
 * matches the primary consumer pattern: bulk
 * `ticker IN (...) AND date BETWEEN ...` → group-by-ticker. Per CONTEXT.md
 * D-06 / D-08 the signature swap is safe because no Phase 4 consumer has
 * migrated onto the Phase 1 placeholder.
 *
 * All OCC tickers in a single `readQuotes` batch MUST resolve to the same
 * underlying (D-07). Concrete subclasses validate this before issuing SQL and
 * throw clearly when a mixed batch arrives (first-iteration behavior — may
 * relax to transparent grouping if a real Phase 4 consumer needs it).
 *
 * Concrete subclasses (ParquetQuoteStore, DuckdbQuoteStore) ship in Plan
 * 02-03 Task 3.
 */
import type {
  StoreContext,
  QuoteRow,
  CoverageReport,
  ReadWindowParams,
  WindowQuoteRow,
} from "./types.ts";
import { extractRoot } from "../tickers/resolver.ts";

export abstract class QuoteStore {
  protected readonly ctx: StoreContext;
  constructor(ctx: StoreContext) {
    this.ctx = ctx;
  }

  /**
   * Public accessor for the underlying TickerRegistry (WR-03).
   *
   * Several pipeline-side helpers need to resolve OCC roots → underlyings
   * BEFORE they can group calls per-underlying (Pitfall 4 — readQuotes /
   * writeQuotes both enforce single-underlying batches). Exposing the
   * registry through a public getter beats reaching into `store["ctx"]`
   * via bracket notation, which silently bypasses TypeScript's `protected`
   * modifier and creates a hidden coupling to the internal field name.
   */
  public get tickers() {
    return this.ctx.tickers;
  }

  abstract writeQuotes(
    underlying: string,
    date: string,
    quotes: QuoteRow[],
  ): Promise<void>;

  /**
   * Write quotes for a single (underlying, date) partition from a user-supplied SELECT.
   *
   * The SELECT must produce columns matching `market.option_quote_minutes`
   * (underlying, date, ticker, time, bid, ask, mid, last_updated_ns, source,
   *  delta, gamma, theta, vega, iv, greeks_source, greeks_revision).
   * Single-partition semantics mirror `SpotStore.writeFromSelect`.
   */
  abstract writeFromSelect(
    partition: { underlying: string; date: string },
    selectSql: string,
  ): Promise<{ rowCount: number }>;

  /**
   * Read quotes for a batch of OCC tickers over a date range.
   *
   * All tickers MUST resolve to the same underlying via
   * `extractRoot(...)` + `ctx.tickers.resolve(...)` (validated by the concrete
   * implementation per D-07). Returns a Map keyed by OCC ticker; values are
   * timestamp-sorted arrays of QuoteRow for that contract across the range.
   */
  abstract readQuotes(
    occTickers: string[],
    from: string,
    to: string,
  ): Promise<Map<string, QuoteRow[]>>;

  /**
   * Group a `(date -> OCC tickers)` request map by resolved underlying.
   *
   * `readQuotes(...)` and `writeQuotes(...)` both enforce single-underlying
   * batches, so multi-date callers need this shared bucketing before they can
   * fan out to backend-specific bulk paths.
   */
  protected groupTickersByUnderlying(
    tickersByDate: Map<string, Set<string>>,
  ): Map<string, Map<string, Set<string>>> {
    const byUnderlying = new Map<string, Map<string, Set<string>>>();
    for (const [date, tickers] of tickersByDate) {
      for (const ticker of tickers) {
        const underlying = this.ctx.tickers.resolve(extractRoot(ticker));
        let perDate = byUnderlying.get(underlying);
        if (!perDate) {
          perDate = new Map();
          byUnderlying.set(underlying, perDate);
        }
        let dateTickers = perDate.get(date);
        if (!dateTickers) {
          dateTickers = new Set<string>();
          perDate.set(date, dateTickers);
        }
        dateTickers.add(ticker);
      }
    }
    return byUnderlying;
  }

  /**
   * Bulk-read quotes for N (date, tickers) pairs across N dates, with a
   * caller-supplied time window pushed into the query.
   *
   * The base implementation is a backend-respecting fallback that fans out to
   * per-date `readQuotes(...)` calls. Concrete backends can override it with a
   * more efficient bulk query shape without changing the public contract.
   *
   * `tickersByDate` may list the same ticker on multiple dates (e.g. a 3-DTE
   * option appearing across a Mon/Tue/Wed window). Returns a Map keyed by
   * OCC ticker whose values contain quotes for that ticker across every date
   * in which it was requested; callers filter by (ticker, date) against the
   * input map if they need date-specific isolation.
   */
  async readQuotesBulk(
    tickersByDate: Map<string, Set<string>>,
    timeStart: string,
    timeEnd: string,
  ): Promise<Map<string, QuoteRow[]>> {
    const out = new Map<string, QuoteRow[]>();
    if (tickersByDate.size === 0) return out;

    for (const [, perDate] of this.groupTickersByUnderlying(tickersByDate)) {
      for (const [date, occs] of perDate) {
        if (occs.size === 0) continue;
        const quotesByOcc = await this.readQuotes([...occs], date, date);
        for (const [occ, quotes] of quotesByOcc) {
          let arr = out.get(occ);
          if (!arr) {
            arr = [];
            out.set(occ, arr);
          }
          for (const quote of quotes) {
            const spaceIdx = quote.timestamp.indexOf(" ");
            const time = spaceIdx === -1 ? "" : quote.timestamp.slice(spaceIdx + 1);
            if (time < timeStart || time > timeEnd) continue;
            arr.push(quote);
          }
        }
      }
    }
    return out;
  }

  abstract getCoverage(
    underlying: string,
    from: string,
    to: string,
  ): Promise<CoverageReport>;

  /**
   * Read every option-quote row in the leg-envelope union over a time window.
   * Returns rows joined back to chain metadata (contract_type, strike, expiration,
   * dte) so the caller doesn't OCC-parse. Greeks columns project as-is from the
   * quote table.
   *
   * Per P1: this is the single read primitive. Ranking + top-N selection happen
   * in JS at the call site. No SQL ranking CTE.
   */
  abstract readWindow(params: ReadWindowParams): Promise<WindowQuoteRow[]>;
}
