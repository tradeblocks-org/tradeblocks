import {
  drawdownEpisodesFromEquity,
  type DatedEquity,
  type DrawdownEpisode,
} from "./marked-equity.ts";
import type {
  BookReplayInput,
  BookReplayResult,
  BookMember,
  BookMemberResult,
  BookMarkedResult,
  BookTrade,
  BookSizingScheduleEntry,
  BookDisabledScheduleEntry,
  BookReplayAudit,
  EntrySizingFact,
  ReadonlyFact,
} from "./book-replay.ts";

interface ReplayGroupShape {
  key: string;
  memberId: string;
  entryGroupId: string;
  simultaneousRank: number;
  children: BookTrade[];
}
interface PreparedReplay {
  groups: ReplayGroupShape[];
  events: Array<{
    date: string;
    time: number;
    kind: "open" | "close";
    group: ReplayGroupShape;
    child?: BookTrade;
  }>;
  markValues: Map<string, number>;
}
const preparedTapeBrand: unique symbol = Symbol("preparedReplayTape");
export interface PreparedReplayTape {
  readonly [preparedTapeBrand]: true;
}
interface TapeHandleData {
  readonly fingerprint: number;
  readonly canonical: string;
  readonly prepared: PreparedReplay;
}
// Explicit caller-held tokens own their private payload; this is not an input cache.
const preparedTapes = new WeakMap<PreparedReplayTape, TapeHandleData>();

function canonicalTape(input: BookReplayInput): string {
  const marks =
    input.marks?.mode === "child"
      ? input.marks.values.map((mark) => [mark.tradeId, mark.date, mark.netOpenPlPerContract])
      : input.marks?.values.map((mark) => [
          mark.memberId,
          mark.entryGroupId,
          mark.date,
          mark.netOpenPlPerContract,
        ]);
  return JSON.stringify([
    input.startingFunds,
    input.dates,
    input.trades.map((trade) => [
      trade.id,
      trade.memberId,
      trade.entryGroupId,
      trade.dateOpened,
      trade.timeOpened,
      trade.dateClosed,
      trade.timeClosed,
      trade.netPlPerContract,
      trade.buyingPowerPerContract,
      trade.ignored,
    ]),
    input.marks?.mode,
    marks,
    input.simultaneousOrder,
    input.simultaneousGroupOrder === undefined
      ? ["absent"]
      : input.simultaneousGroupOrder === null
        ? ["null"]
        : Object.keys(input.simultaneousGroupOrder)
            .sort()
            .map((id) => [id, input.simultaneousGroupOrder![id]]),
    input.reservationMode,
    input.sharedEntryGroupBuyingPower,
    input.ignoredRows,
    input.ignoredBuyingPower,
    input.liquidityThresholdContracts,
  ]);
}

function tapeHash(canonical: string): number {
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i++)
    hash = Math.imul(hash ^ canonical.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function prepareReplayTapeInternal(input: BookReplayInput): PreparedReplayTape {
  validateReplay(input);
  const canonical = canonicalTape(input);
  // Detach the tape: mutating its source must not corrupt another matching caller.
  const snapshot = structuredClone(input);
  const handle: PreparedReplayTape = Object.freeze({ [preparedTapeBrand]: true as const });
  preparedTapes.set(handle, {
    canonical,
    fingerprint: tapeHash(canonical),
    prepared: prepareReplay(snapshot),
  });
  return handle;
}

function checkedTape(input: BookReplayInput, handle: PreparedReplayTape): PreparedReplay {
  const tape = preparedTapes.get(handle);
  let canonical: string;
  try {
    canonical = canonicalTape(input);
  } catch {
    throw new RangeError("prepared_replay_tape_mismatch: invariant inputs changed");
  }
  // Full canonical equality makes hash collisions harmless.
  if (!tape || tape.fingerprint !== tapeHash(canonical) || tape.canonical !== canonical)
    throw new RangeError("prepared_replay_tape_mismatch: invariant inputs changed");
  return tape.prepared;
}

export function replayBookInternal(
  input: BookReplayInput,
  preparedTape?: PreparedReplayTape,
  audit?: BookReplayAudit,
): BookReplayResult {
  const prepared = preparedTape ? checkedTape(input, preparedTape) : undefined;
  validateReplay(input, prepared !== undefined);
  return runReplay(input, prepared ?? prepareReplay(input), audit);
}
/** Internal search seam; deliberately not exported by the package entrypoint. */
export function createSearchReplay(
  input: BookReplayInput,
  preparedTape?: PreparedReplayTape,
): (members: Record<string, BookMember>) => BookReplayResult {
  let prepared = preparedTape ? checkedTape(input, preparedTape) : undefined;
  return (members) => {
    const candidate = { ...input, members };
    validateReplay(candidate, prepared !== undefined);
    prepared ??= prepareReplay(candidate);
    return runReplay(candidate, prepared);
  };
}

function runReplay(
  input: BookReplayInput,
  prepared: PreparedReplay,
  audit?: BookReplayAudit,
): BookReplayResult {
  const origins = audit ? checkedAuditOrigins(input, audit) : undefined;
  const markOnly = input.ignoredRows === "markOnly";
  const countIgnoredBuyingPower = input.ignoredBuyingPower === "reserve";
  const reportsDisabled = Object.values(input.sizingSchedule ?? {}).some((schedule) =>
    schedule.some((entry) => entry.disabled === true),
  );
  const ignoredPositions = {
    entryGroups: 0,
    executedGroups: 0,
    zeroGroups: 0,
    ...(reportsDisabled ? { disabledGroups: 0 } : {}),
    executedRows: 0,
    closedRows: 0,
    openRows: 0,
    openGroups: 0,
  };
  let funds = input.startingFunds;
  let reserved = 0;
  let insolvent = false;
  let closedRows = 0;
  const members = input.simultaneousOrder.map((memberId): BookMemberResult => ({
    memberId,
    entryGroups: 0,
    executedGroups: 0,
    zeroGroups: 0,
    ...(reportsDisabled ? { disabledGroups: 0 } : {}),
    totalContracts: 0,
    maxContractsPerTrade: 0,
    contractsPerEntry: [],
    netPl: 0,
  }));
  const summaries = Object.fromEntries(members.map((m) => [m.memberId, m]));
  const memberMarked = input.memberMarkedPl
    ? members.map(({ memberId }) => ({
        memberId,
        daily: [] as Array<{ date: string; pl: number }>,
        cumulative: 0,
        previous: 0,
      }))
    : undefined;
  const markedSummaries = memberMarked
    ? Object.fromEntries(memberMarked.map((member) => [member.memberId, member]))
    : undefined;
  const groups = new Map(
    prepared.groups.map((shape) => [
      shape.key,
      {
        ...shape,
        quantity: 0,
        remaining: shape.children.length,
        remainingBuyingPowerChildren: shape.children.reduce(
          (count, trade) => count + Number(!trade.ignored || countIgnoredBuyingPower),
          0,
        ),
        bp:
          input.reservationMode === "sharedEntryGroup"
            ? shape.children.reduce(
                (bp, trade) =>
                  !trade.ignored || countIgnoredBuyingPower
                    ? Math.max(bp, trade.buyingPowerPerContract)
                    : bp,
                0,
              )
            : shape.children.reduce(
                (bp, trade) =>
                  !trade.ignored || countIgnoredBuyingPower
                    ? bp + trade.buyingPowerPerContract
                    : bp,
                0,
              ),
      },
    ]),
  );
  type Group = typeof groups extends Map<string, infer G> ? G : never;
  const activeGroups = new Set<Group>();
  let executedIgnoredOnlyGroups = 0;
  const markValues = prepared.markValues;
  const markedEquity: DatedEquity[] = [];
  let markedInsolvent = false;
  const events = prepared.events;
  const openCounts: Record<string, number> = Object.fromEntries(
    input.simultaneousOrder.map((id) => [id, 0]),
  );
  const equity: DatedEquity[] = [];
  let cursor = 0;
  for (const date of input.dates) {
    if (audit && origins!.has(date)) {
      emitAudit(audit.onOrigin, {
        date,
        timing: "session_open_before_events",
        closedFunds: funds,
        precedingCloseMarkedEquity: markedEquity.length
          ? available({ ...markedEquity[markedEquity.length - 1] })
          : unavailable("preceding_close_mark_unavailable"),
        reservedBuyingPower: reserved,
        members: input.simultaneousOrder.map((memberId) => ({
          memberId,
          openGroups: openCounts[memberId],
        })),
        heldGroups: [...activeGroups].map((group) => {
          const remaining = group.children.filter((child) => child.dateClosed >= date);
          return {
            memberId: group.memberId,
            entryGroupId: group.entryGroupId,
            dateOpened: group.children[0].dateOpened,
            timeOpened: group.children[0].timeOpened,
            entryQuantity: group.quantity,
            remainingChildIds: remaining.map((child) => child.id),
            remainingReservedBuyingPower:
              group.quantity *
              (input.reservationMode === "sharedEntryGroup"
                ? group.remainingBuyingPowerChildren > 0
                  ? group.bp
                  : 0
                : remaining.reduce(
                    (sum, child) =>
                      sum +
                      (!child.ignored || countIgnoredBuyingPower
                        ? child.buyingPowerPerContract
                        : 0),
                    0,
                  )),
          };
        }),
      });
    }
    let closingCashFlow = 0;
    while (cursor < events.length && events[cursor].date <= date) {
      const event = events[cursor++];
      const group = groups.get(event.group.key)!;
      const summary = summaries[group.memberId];
      const member = input.members[group.memberId];
      if (event.kind === "open") {
        const schedule = input.sizingSchedule?.[group.memberId];
        let rule: BookMember | BookSizingScheduleEntry | BookDisabledScheduleEntry = member;
        if (schedule) {
          let low = 0;
          let high = schedule.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (schedule[middle].effectiveDate <= event.date) low = middle + 1;
            else high = middle;
          }
          if (low > 0) rule = schedule[low - 1];
        }
        const fact = audit
          ? entryFact(
              group,
              event.date,
              cursor - 1,
              rule,
              member,
              funds,
              reserved,
              openCounts[group.memberId],
            )
          : undefined;
        if ("disabled" in rule && rule.disabled === true) {
          if (audit) emitAudit(audit.onEntry, fact!);
          summary.entryGroups++;
          summary.disabledGroups!++;
          summary.contractsPerEntry.push({
            entryGroupId: group.entryGroupId,
            contracts: 0,
            ...(input.includeFundsAtEntry ? { fundsAtEntry: funds } : {}),
          });
          if (group.children.some((child) => child.ignored)) {
            ignoredPositions.entryGroups++;
            ignoredPositions.disabledGroups!++;
          }
          continue;
        }
        // An all-ignored excluded group still needs unit economics for sizing, not capacity.
        const bp = group.bp || group.children[0].buyingPowerPerContract;
        let quantity =
          rule.sizing.mode === "allocation"
            ? Math.floor((Math.max(0, funds) * rule.sizing.allocationPercentage) / 100 / bp)
            : rule.sizing.mode === "fixed"
              ? rule.sizing.contracts
              : Math.floor(Math.max(0, funds) / rule.sizing.capitalPerContract);
        if (fact) {
          fact.rawQuantity = available(
            rule.sizing.mode === "allocation"
              ? (Math.max(0, funds) * rule.sizing.allocationPercentage) / 100 / bp
              : rule.sizing.mode === "fixed"
                ? rule.sizing.contracts
                : Math.max(0, funds) / rule.sizing.capitalPerContract,
          );
          fact.flooredQuantity = available(quantity);
        }
        if ((rule.minimumOne ?? member.minimumOne) && funds > 0) quantity = Math.max(1, quantity);
        if (fact) fact.afterMinimumOne = available(quantity);
        if (rule.maxContractsPerTrade !== null)
          quantity = Math.min(quantity, rule.maxContractsPerTrade);
        if (fact) fact.afterContractCap = available(quantity);
        if (rule.maxAllocationAmount !== null)
          quantity = Math.min(quantity, Math.floor(rule.maxAllocationAmount / bp));
        if (fact) fact.afterAllocationCap = available(quantity);
        if (
          group.bp > 0 &&
          !member.ignoreMarginRequirements &&
          rule.sizing.mode !== "capitalPerContract"
        )
          quantity = Math.min(quantity, Math.floor(Math.max(0, funds - reserved) / group.bp));
        if (fact) fact.afterBuyingPowerAdmission = available(quantity);
        if (
          member.removed ||
          funds <= 0 ||
          (rule.maxOpenTrades !== null && openCounts[group.memberId] >= rule.maxOpenTrades)
        )
          quantity = 0;
        if (fact) {
          fact.finalQuantity = quantity;
          if (member.removed) fact.rejectionReasons.push("removed");
          if (funds <= 0) fact.rejectionReasons.push("insolvent");
          if (rule.maxOpenTrades !== null && openCounts[group.memberId] >= rule.maxOpenTrades)
            fact.rejectionReasons.push("max_open");
          emitAudit(audit!.onEntry, fact);
        }
        group.quantity = quantity;
        reserved += quantity * group.bp;
        if (quantity > 0) {
          openCounts[group.memberId]++;
          activeGroups.add(group);
        }
        summary.entryGroups++;
        summary.executedGroups += Number(quantity > 0);
        summary.zeroGroups += Number(quantity === 0);
        summary.totalContracts += quantity;
        summary.maxContractsPerTrade = Math.max(summary.maxContractsPerTrade, quantity);
        summary.contractsPerEntry.push({
          entryGroupId: group.entryGroupId,
          contracts: quantity,
          ...(input.includeFundsAtEntry ? { fundsAtEntry: funds } : {}),
        });
        const ignoredChildren = group.children.reduce((n, child) => n + Number(child.ignored), 0);
        executedIgnoredOnlyGroups += Number(
          quantity > 0 && ignoredChildren === group.children.length,
        );
        if (ignoredChildren > 0) {
          ignoredPositions.entryGroups++;
          ignoredPositions.executedGroups += Number(quantity > 0);
          ignoredPositions.zeroGroups += Number(quantity === 0);
          if (quantity > 0) ignoredPositions.executedRows += ignoredChildren;
        }
      } else {
        const child = event.child!;
        const pl = child.ignored ? 0 : group.quantity * child.netPlPerContract;
        closingCashFlow += pl;
        summary.netPl += pl;
        const next = events[cursor];
        // Settle all closes at this timestamp before judging funds or admitting opens.
        if (next?.kind !== "close" || next.date !== event.date || next.time !== event.time) {
          funds += closingCashFlow;
          closingCashFlow = 0;
          insolvent ||= funds <= 0 || !Number.isFinite(funds);
        }
        group.remaining--;
        const countsBuyingPower = !child.ignored || countIgnoredBuyingPower;
        if (countsBuyingPower) group.remainingBuyingPowerChildren--;
        if (group.quantity > 0) {
          closedRows++;
          if (child.ignored) ignoredPositions.closedRows++;
          if (countsBuyingPower) {
            if (input.reservationMode === "sumChildren")
              reserved -= group.quantity * child.buyingPowerPerContract;
            else if (group.remainingBuyingPowerChildren === 0)
              reserved -= group.quantity * group.bp;
          }
          if (group.remaining === 0) {
            openCounts[group.memberId]--;
            activeGroups.delete(group);
          }
        }
      }
    }
    equity.push({ date, equity: funds });
    if (input.marks) {
      let markedFunds = funds;
      if (memberMarked)
        for (const member of memberMarked) member.cumulative = summaries[member.memberId].netPl;
      for (const group of activeGroups) {
        if (input.marks.mode === "entryGroup") {
          const key = JSON.stringify([group.memberId, group.entryGroupId, date]);
          const mark = markValues.get(key);
          if (mark === undefined) throw new RangeError(`missing_mark_coverage: ${key}`);
          markedFunds += group.quantity * mark;
          if (markedSummaries) markedSummaries[group.memberId].cumulative += group.quantity * mark;
        } else {
          for (const child of group.children) {
            if (child.dateClosed <= date) continue;
            const key = JSON.stringify([child.id, date]);
            const mark = markValues.get(key);
            if (mark === undefined) throw new RangeError(`missing_mark_coverage: ${key}`);
            markedFunds += group.quantity * mark;
            if (markedSummaries)
              markedSummaries[group.memberId].cumulative += group.quantity * mark;
          }
        }
      }
      markedEquity.push({ date, equity: markedFunds });
      markedInsolvent ||= markedFunds <= 0 || !Number.isFinite(markedFunds);
      if (memberMarked)
        for (const member of memberMarked) {
          member.daily.push({ date, pl: member.cumulative - member.previous });
          member.previous = member.cumulative;
        }
    }
  }
  const startingEquity = { date: input.dates[0], equity: input.startingFunds };
  const drawdownEpisodes = insolvent ? [] : drawdownEpisodesFromEquity([startingEquity, ...equity]);
  const maxDrawdownEpisode = drawdownEpisodes.reduce<DrawdownEpisode | null>(
    (worst, episode) => (!worst || episode.depthPct > worst.depthPct ? episode : worst),
    null,
  );
  const open = [...groups.values()].filter((g) => g.quantity > 0 && g.remaining > 0);
  if (markOnly)
    for (const group of open) {
      const ignoredOpenRows = group.children.reduce(
        (n, child) => n + Number(child.ignored && child.dateClosed > input.dates.at(-1)!),
        0,
      );
      ignoredPositions.openRows += ignoredOpenRows;
      ignoredPositions.openGroups += Number(ignoredOpenRows > 0);
    }
  const markedEpisodes =
    input.marks && !markedInsolvent && !insolvent
      ? drawdownEpisodesFromEquity([startingEquity, ...markedEquity])
      : [];
  const markedWorst = markedEpisodes.reduce<DrawdownEpisode | null>(
    (worst, episode) => (!worst || episode.depthPct > worst.depthPct ? episode : worst),
    null,
  );
  const marked: BookMarkedResult | undefined = input.marks
    ? {
        basis: "offline_marked_equity",
        equity: markedEquity,
        drawdownEpisodes: markedEpisodes,
        maxDrawdownPct: markedInsolvent || insolvent ? null : (markedWorst?.depthPct ?? 0),
        maxDrawdownEpisode: markedWorst,
        insolvent: markedInsolvent || insolvent,
        ...(memberMarked
          ? { members: memberMarked.map(({ memberId, daily }) => ({ memberId, daily })) }
          : {}),
      }
    : undefined;
  return {
    status: insolvent ? "insolvent" : "ok",
    basis: "offline_closed_equity",
    endingFunds: funds,
    returnPct: ((funds - input.startingFunds) / input.startingFunds) * 100,
    startingEquity,
    equity,
    drawdownEpisodes,
    maxDrawdownPct: insolvent ? null : (maxDrawdownEpisode?.depthPct ?? 0),
    maxDrawdownEpisode,
    members,
    census: {
      inputRows: input.trades.length,
      ignoredRows: input.trades.filter((t) => t.ignored).length,
      eligibleRows: input.trades.filter((t) => !t.ignored).length,
      entryGroups: groups.size,
      executedGroups: members.reduce((n, m) => n + m.executedGroups, 0),
      executedIgnoredOnlyGroups,
      zeroGroups: members.reduce((n, m) => n + m.zeroGroups, 0),
      ...(reportsDisabled
        ? { disabledGroups: members.reduce((n, m) => n + m.disabledGroups!, 0) }
        : {}),
      closedRows,
      openRows: open.reduce((n, g) => n + g.remaining, 0),
      openGroups: open.length,
      ...(markOnly ? { ignoredPositions } : {}),
    },
    warnings: [
      "Closed equity excludes open-position marks and unobserved opportunities.",
      ...(markOnly
        ? [
            `Ignored buying-power ${input.ignoredBuyingPower} is a declared hypothesis, not verified native behavior; mixed-child treatment is hypothetical.`,
          ]
        : []),
      ...members
        .filter((m) => input.members[m.memberId].maxOpenTrades === null)
        .map((m) => `maxOpenTrades unavailable: ${m.memberId}`),
    ],
    insolvent,
    liquidityFlag:
      input.liquidityThresholdContracts !== null &&
      members.some((m) => m.maxContractsPerTrade > input.liquidityThresholdContracts!),
    declarations: input.ignoredRows === "markOnly" ? input : { ...input, ignoredRows: "exclude" },
    ...(marked ? { marked } : {}),
  };
}

function prepareReplay(input: BookReplayInput): PreparedReplay {
  const groupOrders = new Map(
    Object.entries(input.simultaneousGroupOrder ?? {}).map(([memberId, ids]) => [
      memberId,
      new Map(ids.map((id, index) => [id, index])),
    ]),
  );
  const groups = new Map<
    string,
    {
      key: string;
      memberId: string;
      entryGroupId: string;
      simultaneousRank: number;
      children: BookTrade[];
    }
  >();
  for (const trade of input.trades) {
    if (trade.ignored && input.ignoredRows !== "markOnly") continue;
    const key = JSON.stringify([trade.memberId, trade.entryGroupId]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        memberId: trade.memberId,
        entryGroupId: trade.entryGroupId,
        simultaneousRank: groupOrders.get(trade.memberId)?.get(trade.entryGroupId) ?? -1,
        children: [],
      };
      groups.set(key, group);
    }
    group.children.push(trade);
  }
  const markValues = new Map<string, number>();
  if (input.marks?.mode === "child")
    for (const mark of input.marks.values)
      markValues.set(JSON.stringify([mark.tradeId, mark.date]), mark.netOpenPlPerContract);
  else if (input.marks?.mode === "entryGroup")
    for (const mark of input.marks.values)
      markValues.set(
        JSON.stringify([mark.memberId, mark.entryGroupId, mark.date]),
        mark.netOpenPlPerContract,
      );
  type Group = typeof groups extends Map<string, infer G> ? G : never;
  const events: Array<{
    date: string;
    time: number;
    kind: "open" | "close";
    group: Group;
    child?: BookTrade;
  }> = [];
  for (const group of groups.values()) {
    const first = group.children[0];
    events.push({
      date: first.dateOpened,
      time: clockSeconds(first.timeOpened),
      kind: "open",
      group,
    });
    for (const child of group.children)
      events.push({
        date: child.dateClosed,
        time: clockSeconds(child.timeClosed),
        kind: "close",
        group,
        child,
      });
  }
  const order = Object.fromEntries(input.simultaneousOrder.map((id, i) => [id, i]));
  events.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.time - b.time ||
      (a.kind === b.kind ? 0 : a.kind === "close" ? -1 : 1) ||
      order[a.group.memberId] - order[b.group.memberId] ||
      (a.kind === "open" ? a.group.simultaneousRank - b.group.simultaneousRank : 0) ||
      a.group.entryGroupId.localeCompare(b.group.entryGroupId) ||
      (a.child?.id ?? "").localeCompare(b.child?.id ?? ""),
  );
  return { groups: [...groups.values()], events, markValues };
}

function validateReplay(input: BookReplayInput, prepared = false): void {
  const fail = (name: string): never => {
    throw new RangeError(`Invalid book replay: ${name}`);
  };
  if (input.memberMarkedPl !== undefined && typeof input.memberMarkedPl !== "boolean")
    fail("memberMarkedPl");
  if (input.memberMarkedPl && !input.marks) fail("memberMarkedPl requires marks");
  if (
    input.ignoredRows !== undefined &&
    input.ignoredRows !== "exclude" &&
    input.ignoredRows !== "markOnly"
  )
    fail("ignoredRows");
  if (input.ignoredRows === "markOnly") {
    if (input.ignoredBuyingPower !== "exclude" && input.ignoredBuyingPower !== "reserve")
      fail("ignoredBuyingPower required with markOnly");
  } else if (input.ignoredBuyingPower !== undefined) fail("ignoredBuyingPower requires markOnly");
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const dateValid = (date: string) => {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const [year, month, day] = date.split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
  };
  const timeValid = (time: string) =>
    typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?$/.test(time);
  if (!prepared && !positive(input.startingFunds)) fail("startingFunds");
  if (
    !prepared &&
    (!input.dates.length ||
      input.dates.some((date, i) => !dateValid(date) || (i > 0 && date <= input.dates[i - 1])))
  )
    fail("dates");
  if (
    !["sharedEntryGroup", "sumChildren"].includes(input.reservationMode) ||
    input.sharedEntryGroupBuyingPower !== "equalPackageMaximum"
  )
    fail("reservation declarations");
  if (
    !prepared &&
    input.liquidityThresholdContracts !== null &&
    !positive(input.liquidityThresholdContracts)
  )
    fail("liquidityThresholdContracts");
  const ids = Object.keys(input.members);
  if (
    input.simultaneousOrder.length !== ids.length ||
    new Set(input.simultaneousOrder).size !== ids.length ||
    input.simultaneousOrder.some((id) => !Object.hasOwn(input.members, id))
  )
    fail("simultaneousOrder");
  const validateSizing = (
    member: Pick<
      BookMember,
      "sizing" | "maxContractsPerTrade" | "maxAllocationAmount" | "maxOpenTrades"
    >,
    ignoreMarginRequirements: boolean,
  ) => {
    if (
      member.maxContractsPerTrade !== null &&
      (!integer(member.maxContractsPerTrade) || member.maxContractsPerTrade === 0)
    )
      fail("maxContractsPerTrade");
    if (member.maxAllocationAmount !== null && !positive(member.maxAllocationAmount))
      fail("maxAllocationAmount");
    if (
      member.maxOpenTrades !== null &&
      (!integer(member.maxOpenTrades) || member.maxOpenTrades === 0)
    )
      fail("maxOpenTrades");
    const rule = member.sizing;
    if (rule.mode === "allocation") {
      if (!Number.isFinite(rule.allocationPercentage) || rule.allocationPercentage < 0)
        fail("allocationPercentage");
    } else if (rule.mode === "fixed") {
      if (!integer(rule.contracts)) fail("contracts");
    } else if (rule.mode === "capitalPerContract") {
      if (!positive(rule.capitalPerContract) || ignoreMarginRequirements)
        fail("capitalPerContract requires margin flag false");
    } else fail("sizing mode");
  };
  for (const member of Object.values(input.members)) {
    validateSizing(member, member.ignoreMarginRequirements);
    if (
      [member.removed, member.minimumOne, member.ignoreMarginRequirements].some(
        (v) => typeof v !== "boolean",
      )
    )
      fail("member booleans");
  }
  if (input.sizingSchedule !== undefined) {
    if (
      !input.sizingSchedule ||
      typeof input.sizingSchedule !== "object" ||
      Array.isArray(input.sizingSchedule)
    )
      fail("sizingSchedule");
    for (const [memberId, schedule] of Object.entries(input.sizingSchedule)) {
      if (!Object.hasOwn(input.members, memberId)) fail("sizingSchedule unknown member");
      if (!Array.isArray(schedule)) fail("sizingSchedule entries");
      for (let i = 0; i < schedule.length; i++) {
        const entry = schedule[i];
        if (
          !entry ||
          !dateValid(entry.effectiveDate) ||
          (i > 0 && entry.effectiveDate <= schedule[i - 1].effectiveDate)
        )
          fail("sizingSchedule effective dates");
        if (
          Object.keys(entry).some(
            (key) =>
              ![
                "effectiveDate",
                "disabled",
                "sizing",
                "maxContractsPerTrade",
                "maxAllocationAmount",
                "maxOpenTrades",
                "minimumOne",
              ].includes(key),
          )
        )
          fail("sizingSchedule fields");
        if (entry.disabled !== undefined && typeof entry.disabled !== "boolean")
          fail("sizingSchedule disabled");
        if (entry.disabled === true) continue;
        if (entry.minimumOne !== undefined && typeof entry.minimumOne !== "boolean")
          fail("sizingSchedule minimumOne");
        if (!entry.sizing) fail("sizingSchedule sizing");
        validateSizing(entry, input.members[memberId].ignoreMarginRequirements);
      }
    }
  }
  if (prepared) return;
  const dates = new Set(input.dates);
  const tradeIds = new Set<string>();
  const groups = new Map<string, BookTrade>();
  const knownGroups = new Set<string>();
  const groupBuyingPower = new Map<string, number>();
  for (const trade of input.trades) {
    if (
      !trade.id ||
      tradeIds.has(trade.id) ||
      !trade.entryGroupId ||
      !Object.hasOwn(input.members, trade.memberId) ||
      typeof trade.ignored !== "boolean"
    )
      fail("trade identity");
    tradeIds.add(trade.id);
    knownGroups.add(JSON.stringify([trade.memberId, trade.entryGroupId]));
    if (trade.ignored && input.ignoredRows !== "markOnly") continue;
    if (
      !dateValid(trade.dateOpened) ||
      !dateValid(trade.dateClosed) ||
      !timeValid(trade.timeOpened) ||
      !timeValid(trade.timeClosed)
    )
      fail("trade date/time");
    if (
      !dates.has(trade.dateOpened) ||
      (trade.dateClosed <= input.dates.at(-1)! && !dates.has(trade.dateClosed))
    )
      fail("trade session absent");
    if (
      trade.dateClosed < trade.dateOpened ||
      (trade.dateClosed === trade.dateOpened &&
        clockSeconds(trade.timeClosed) <= clockSeconds(trade.timeOpened))
    )
      fail("close must follow open");
    if (!positive(trade.buyingPowerPerContract) || !Number.isFinite(trade.netPlPerContract))
      fail("unit economics");
    const key = JSON.stringify([trade.memberId, trade.entryGroupId]);
    const first = groups.get(key);
    if (
      first &&
      (first.dateOpened !== trade.dateOpened ||
        clockSeconds(first.timeOpened) !== clockSeconds(trade.timeOpened))
    )
      fail("ambiguous entry group or unequal package BP");
    if (
      input.reservationMode === "sharedEntryGroup" &&
      (!trade.ignored || input.ignoredBuyingPower === "reserve")
    ) {
      const bp = groupBuyingPower.get(key);
      if (bp !== undefined && bp !== trade.buyingPowerPerContract) fail("unequal package BP");
      groupBuyingPower.set(key, trade.buyingPowerPerContract);
    }
    groups.set(key, trade);
  }
  if (input.simultaneousGroupOrder !== undefined) {
    if (
      !input.simultaneousGroupOrder ||
      typeof input.simultaneousGroupOrder !== "object" ||
      Array.isArray(input.simultaneousGroupOrder)
    )
      fail("simultaneousGroupOrder");
    for (const [memberId, order] of Object.entries(input.simultaneousGroupOrder)) {
      if (
        !Object.hasOwn(input.members, memberId) ||
        !Array.isArray(order) ||
        order.some((id) => typeof id !== "string" || !id) ||
        new Set(order).size !== order.length
      )
        fail("simultaneousGroupOrder");
    }
  }
  const firstAtTimestamp = new Map<string, BookTrade>();
  for (const trade of groups.values()) {
    const key = JSON.stringify([trade.memberId, trade.dateOpened, clockSeconds(trade.timeOpened)]);
    const first = firstAtTimestamp.get(key);
    if (first) {
      const order =
        input.simultaneousGroupOrder && Object.hasOwn(input.simultaneousGroupOrder, trade.memberId)
          ? input.simultaneousGroupOrder[trade.memberId]
          : undefined;
      if (!order?.includes(first.entryGroupId) || !order.includes(trade.entryGroupId))
        throw new RangeError(`ambiguous_simultaneous_groups: ${key}`);
    } else firstAtTimestamp.set(key, trade);
  }
  if (input.marks) {
    if (input.marks.mode !== "child" && input.marks.mode !== "entryGroup") fail("marks mode");
    const seen = new Set<string>();
    if (input.marks.mode === "child") {
      for (const mark of input.marks.values) {
        const key = JSON.stringify([mark.tradeId, mark.date]);
        if (
          !tradeIds.has(mark.tradeId) ||
          !dates.has(mark.date) ||
          !Number.isFinite(mark.netOpenPlPerContract) ||
          seen.has(key)
        )
          fail("child mark identity/date/value");
        seen.add(key);
      }
    } else {
      for (const mark of input.marks.values) {
        const key = JSON.stringify([mark.memberId, mark.entryGroupId, mark.date]);
        if (
          !knownGroups.has(JSON.stringify([mark.memberId, mark.entryGroupId])) ||
          !dates.has(mark.date) ||
          !Number.isFinite(mark.netOpenPlPerContract) ||
          seen.has(key)
        )
          fail("group mark identity/date/value");
        seen.add(key);
      }
    }
  }
}

function clockSeconds(time: string): number {
  const [hours, minutes, seconds] = time.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function checkedAuditOrigins(input: BookReplayInput, audit: BookReplayAudit): Set<string> {
  const dates = new Set(input.dates);
  const origins = new Set<string>();
  for (const date of audit.originDates) {
    if (!dates.has(date) || origins.has(date))
      throw new RangeError("invalid_book_replay_audit_origin");
    origins.add(date);
  }
  return origins;
}

function available<T>(value: T): ReadonlyFact<T> {
  return { status: "available", value };
}

function unavailable(reason: string): { readonly status: "unavailable"; readonly reason: string } {
  return { status: "unavailable", reason };
}

function freezeFact(value: object): void {
  for (const child of Object.values(value))
    if (child !== null && typeof child === "object") freezeFact(child);
  Object.freeze(value);
}

function emitAudit<T extends object>(callback: (fact: T) => void, fact: T): void {
  freezeFact(fact);
  try {
    callback(fact);
  } catch (cause) {
    throw new Error("book_replay_audit_callback", { cause });
  }
}

function entryFact(
  group: ReplayGroupShape & { bp: number },
  date: string,
  eventOrdinal: number,
  rule: BookMember | BookSizingScheduleEntry | BookDisabledScheduleEntry,
  member: BookMember,
  funds: number,
  reserved: number,
  openGroups: number,
): Omit<{ -readonly [K in keyof EntrySizingFact]: EntrySizingFact[K] }, "rejectionReasons"> & {
  rejectionReasons: Array<"disabled" | "removed" | "insolvent" | "max_open">;
} {
  const disabled = "disabled" in rule && rule.disabled === true;
  const active = disabled ? undefined : (rule as BookMember | BookSizingScheduleEntry);
  const bp = group.bp || group.children[0].buyingPowerPerContract;
  const bpApplies =
    active !== undefined &&
    group.bp > 0 &&
    !member.ignoreMarginRequirements &&
    active.sizing.mode !== "capitalPerContract";
  return {
    memberId: group.memberId,
    entryGroupId: group.entryGroupId,
    sourceRows: group.children.map((child) => ({ id: child.id, ignored: child.ignored })),
    date,
    time: group.children[0].timeOpened,
    eventOrdinal,
    allIgnored: group.children.every((child) => child.ignored),
    fundsAtEntry: funds,
    effectiveRuleDate: "effectiveDate" in rule ? rule.effectiveDate : null,
    sizing: active ? available({ ...active.sizing }) : unavailable("disabled"),
    maxContractsPerTrade: active ? available(active.maxContractsPerTrade) : unavailable("disabled"),
    maxAllocationAmount: active ? available(active.maxAllocationAmount) : unavailable("disabled"),
    maxOpenTrades: active ? available(active.maxOpenTrades) : unavailable("disabled"),
    minimumOne: active?.minimumOne ?? member.minimumOne,
    removed: member.removed,
    ignoreMarginRequirements: member.ignoreMarginRequirements,
    reservedBuyingPowerBefore: reserved,
    availableBuyingPowerBefore: Math.max(0, funds - reserved),
    packageBuyingPower: group.bp,
    sizingBuyingPower: bp,
    memberOpenGroupsBefore: openGroups,
    rawQuantity: unavailable("disabled"),
    flooredQuantity: unavailable("disabled"),
    afterMinimumOne: unavailable("disabled"),
    contractCapLimit: active ? available(active.maxContractsPerTrade) : unavailable("disabled"),
    allocationCapLimit: active
      ? available(
          active.maxAllocationAmount === null ? null : Math.floor(active.maxAllocationAmount / bp),
        )
      : unavailable("disabled"),
    buyingPowerLimit: active
      ? available(bpApplies ? Math.floor(Math.max(0, funds - reserved) / group.bp) : null)
      : unavailable("disabled"),
    afterContractCap: unavailable("disabled"),
    afterAllocationCap: unavailable("disabled"),
    afterBuyingPowerAdmission: unavailable("disabled"),
    finalQuantity: 0,
    rejectionReasons: disabled ? ["disabled"] : [],
    buyingPowerAdmissionApplied: bpApplies,
  };
}
