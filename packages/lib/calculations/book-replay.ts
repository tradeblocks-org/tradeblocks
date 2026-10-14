import { replayBookInternal, prepareReplayTapeInternal } from "./book-replay-prepared.ts";
import type { PreparedReplayTape } from "./book-replay-prepared.ts";
export type { PreparedReplayTape } from "./book-replay-prepared.ts";
export interface BookReplayOptions {
  preparedTape?: PreparedReplayTape;
  audit?: BookReplayAudit;
}

/** Unknown facts are distinct from measured zero and an absent cap (null). */
export type ReadonlyFact<T> =
  | { readonly status: "available"; readonly value: T }
  | { readonly status: "unavailable"; readonly reason: string };

export interface EntrySizingFact {
  readonly memberId: string;
  readonly entryGroupId: string;
  readonly sourceRows: readonly { readonly id: string; readonly ignored: boolean }[];
  readonly date: string;
  readonly time: string;
  /** Zero-based ordinal in the complete event stream, including closes. */
  readonly eventOrdinal: number;
  readonly allIgnored: boolean;
  readonly fundsAtEntry: number;
  readonly effectiveRuleDate: string | null;
  readonly sizing: ReadonlyFact<Readonly<BookSizing>>;
  readonly maxContractsPerTrade: ReadonlyFact<number | null>;
  readonly maxAllocationAmount: ReadonlyFact<number | null>;
  readonly maxOpenTrades: ReadonlyFact<number | null>;
  readonly minimumOne: boolean;
  readonly removed: boolean;
  readonly ignoreMarginRequirements: boolean;
  readonly reservedBuyingPowerBefore: number;
  readonly availableBuyingPowerBefore: number;
  readonly packageBuyingPower: number;
  readonly sizingBuyingPower: number;
  readonly memberOpenGroupsBefore: number;
  readonly rawQuantity: ReadonlyFact<number>;
  readonly flooredQuantity: ReadonlyFact<number>;
  readonly afterMinimumOne: ReadonlyFact<number>;
  readonly contractCapLimit: ReadonlyFact<number | null>;
  readonly allocationCapLimit: ReadonlyFact<number | null>;
  readonly buyingPowerLimit: ReadonlyFact<number | null>;
  readonly afterContractCap: ReadonlyFact<number>;
  readonly afterAllocationCap: ReadonlyFact<number>;
  readonly afterBuyingPowerAdmission: ReadonlyFact<number>;
  readonly finalQuantity: number;
  readonly rejectionReasons: readonly ("disabled" | "removed" | "insolvent" | "max_open")[];
  readonly buyingPowerAdmissionApplied: boolean;
}

export interface OriginPositionFact {
  readonly date: string;
  readonly timing: "session_open_before_events";
  readonly closedFunds: number;
  readonly precedingCloseMarkedEquity: ReadonlyFact<{
    readonly date: string;
    readonly equity: number;
  }>;
  readonly reservedBuyingPower: number;
  readonly members: readonly { readonly memberId: string; readonly openGroups: number }[];
  readonly heldGroups: readonly {
    readonly memberId: string;
    readonly entryGroupId: string;
    readonly dateOpened: string;
    readonly timeOpened: string;
    readonly entryQuantity: number;
    readonly remainingChildIds: readonly string[];
    readonly remainingReservedBuyingPower: number;
  }[];
}

/** Detached, frozen facts; callback failures abort replay. No facts are built when omitted. */
export interface BookReplayAudit {
  readonly originDates: readonly string[];
  readonly onEntry: (fact: EntrySizingFact) => void;
  readonly onOrigin: (fact: OriginPositionFact) => void;
}

/** Prepare an immutable, caller-held tape; mismatched invariant inputs are refused. */
export function prepareReplayTape(input: BookReplayInput): PreparedReplayTape {
  return prepareReplayTapeInternal(input);
}
import type { DatedEquity, DrawdownEpisode } from "./marked-equity.ts";

export type BookSizing =
  | { mode: "allocation"; allocationPercentage: number }
  | { mode: "fixed"; contracts: number }
  | { mode: "capitalPerContract"; capitalPerContract: number };
export interface BookMember {
  sizing: BookSizing;
  removed: boolean;
  ignoreMarginRequirements: boolean;
  maxContractsPerTrade: number | null;
  maxAllocationAmount: number | null;
  minimumOne: boolean;
  maxOpenTrades: number | null;
}
/** An active schedule entry: complete replacement sizing/caps from its effective date. */
export type BookSizingScheduleEntry = Pick<
  BookMember,
  "sizing" | "maxContractsPerTrade" | "maxAllocationAmount" | "maxOpenTrades"
> & { effectiveDate: string; disabled?: false };
/** A disabled schedule entry: no new entries from its effective date; supplied sizing/caps are ignored. */
export type BookDisabledScheduleEntry = { effectiveDate: string; disabled: true } & Partial<
  Pick<BookMember, "sizing" | "maxContractsPerTrade" | "maxAllocationAmount" | "maxOpenTrades">
>;
export interface BookTrade {
  id: string;
  memberId: string;
  entryGroupId: string;
  dateOpened: string;
  timeOpened: string;
  dateClosed: string;
  timeClosed: string;
  netPlPerContract: number;
  buyingPowerPerContract: number;
  ignored: boolean;
}
export type BookMarks =
  | {
      mode: "child";
      values: Array<{ tradeId: string; date: string; netOpenPlPerContract: number }>;
    }
  | {
      mode: "entryGroup";
      values: Array<{
        memberId: string;
        entryGroupId: string;
        date: string;
        netOpenPlPerContract: number;
      }>;
    };
export interface BookMarkedResult {
  basis: "offline_marked_equity";
  equity: DatedEquity[];
  drawdownEpisodes: DrawdownEpisode[];
  maxDrawdownPct: number | null;
  maxDrawdownEpisode: DrawdownEpisode | null;
  insolvent: boolean;
  /** Opt-in daily net-dollar contributions on the replay dates axis, in simultaneousOrder. */
  members?: Array<{ memberId: string; daily: Array<{ date: string; pl: number }> }>;
}
interface BookReplayBaseInput {
  startingFunds: number;
  dates: string[];
  trades: BookTrade[];
  members: Record<string, BookMember>;
  /** Ordered complete sizing/caps or disabled states by member; base applies before the first date. */
  sizingSchedule?: Record<string, Array<BookSizingScheduleEntry | BookDisabledScheduleEntry>>;
  reservationMode: "sharedEntryGroup" | "sumChildren";
  sharedEntryGroupBuyingPower: "equalPackageMaximum";
  simultaneousOrder: string[];
  simultaneousGroupOrder?: Record<string, string[]>;
  liquidityThresholdContracts: number | null;
  marks?: BookMarks;
  /** Requires marks; attribute changes in marked equity to each member, including ignored drop-off. */
  memberMarkedPl?: boolean;
  /** Include the closed funds used at each entry, including zero-quantity attempts. */
  includeFundsAtEntry?: boolean;
}
export type BookReplayInput = BookReplayBaseInput &
  (
    | { ignoredRows?: "exclude"; ignoredBuyingPower?: never }
    | { ignoredRows: "markOnly"; ignoredBuyingPower: "exclude" | "reserve" }
  );
export interface BookMemberResult {
  memberId: string;
  entryGroups: number;
  executedGroups: number;
  zeroGroups: number;
  /** Present only when at least one disabled schedule entry is supplied. */
  disabledGroups?: number;
  totalContracts: number;
  maxContractsPerTrade: number;
  contractsPerEntry: Array<{ entryGroupId: string; contracts: number; fundsAtEntry?: number }>;
  netPl: number;
}
export interface BookReplayResult {
  status: "ok" | "insolvent";
  basis: "offline_closed_equity";
  endingFunds: number;
  returnPct: number;
  startingEquity: DatedEquity;
  equity: DatedEquity[];
  drawdownEpisodes: DrawdownEpisode[];
  maxDrawdownPct: number | null;
  maxDrawdownEpisode: DrawdownEpisode | null;
  members: BookMemberResult[];
  census: {
    inputRows: number;
    ignoredRows: number;
    eligibleRows: number;
    entryGroups: number;
    executedGroups: number;
    executedIgnoredOnlyGroups: number;
    zeroGroups: number;
    disabledGroups?: number;
    closedRows: number;
    openRows: number;
    openGroups: number;
    ignoredPositions?: {
      entryGroups: number;
      executedGroups: number;
      zeroGroups: number;
      disabledGroups?: number;
      executedRows: number;
      closedRows: number;
      openRows: number;
      openGroups: number;
    };
  };
  warnings: string[];
  insolvent: boolean;
  liquidityFlag: boolean;
  declarations: BookReplayInput & { ignoredRows: "exclude" | "markOnly" };
  marked?: BookMarkedResult;
}

/**
 * Replay closed funds and, with supplied marks, a separate marked equity path.
 * memberMarkedPl opts into per-member daily net-dollar changes in that marked path:
 * realized net P/L plus remaining open marks, differenced from zero on day one.
 * Fees are already included in net inputs; ignored mark-only closes realize no cash.
 * Missing marks are refused, and endpoint positions remain open. Attribution requires marks.
 * sizingSchedule selects complete sizing/caps or disabled state on each entry date (inclusive).
 * Disabled entries need no sizing/caps; any supplied values are ignored. A later active
 * entry reinstates its complete sizing/caps. Before the first date the base applies.
 * Fixed member flags (including removed) still apply; concurrency counts the real member.
 * Held quantities/reservations never resize or exit early, including across disable dates.
 * Funds, marks and member attribution continue without resets. Disabled groups are counted
 * separately from zero groups, with additive disabledGroups only when disabled state is supplied.
 * Declarations echo the schedule. Without disabled state, output is unchanged.
 * includeFundsAtEntry records closed funds on each contractsPerEntry entry after
 * same-timestamp closes settle and before sizing/admission, including zero and disabled entries.
 * Marks and buying-power reservations do not reduce this value.
 * Without the option, the result shape and replay behavior are unchanged.
 */
export function replayBook(input: BookReplayInput, options?: BookReplayOptions): BookReplayResult {
  return replayBookInternal(input, options?.preparedTape, options?.audit);
}
