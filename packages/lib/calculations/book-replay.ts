import {
  drawdownEpisodesFromEquity,
  type DatedEquity,
  type DrawdownEpisode,
} from "./marked-equity.ts";

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
  reservationMode: "sharedEntryGroup" | "sumChildren";
  sharedEntryGroupBuyingPower: "equalPackageMaximum";
  simultaneousOrder: string[];
  simultaneousGroupOrder?: Record<string, string[]>;
  liquidityThresholdContracts: number | null;
  marks?: BookMarks;
  /** Requires marks; attribute changes in marked equity to each member, including ignored drop-off. */
  memberMarkedPl?: boolean;
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
  totalContracts: number;
  maxContractsPerTrade: number;
  contractsPerEntry: Array<{ entryGroupId: string; contracts: number }>;
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
    closedRows: number;
    openRows: number;
    openGroups: number;
    ignoredPositions?: {
      entryGroups: number;
      executedGroups: number;
      zeroGroups: number;
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
 * Without the option, the result shape and replay behavior are unchanged.
 */
export function replayBook(input: BookReplayInput): BookReplayResult {
  validateReplay(input);
  const markOnly = input.ignoredRows === "markOnly";
  const countIgnoredBuyingPower = input.ignoredBuyingPower === "reserve";
  const ignoredPositions = {
    entryGroups: 0,
    executedGroups: 0,
    zeroGroups: 0,
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
  const groupOrders = new Map(
    Object.entries(input.simultaneousGroupOrder ?? {}).map(([memberId, ids]) => [
      memberId,
      new Map(ids.map((id, index) => [id, index])),
    ]),
  );
  const groups = new Map<
    string,
    {
      memberId: string;
      entryGroupId: string;
      simultaneousRank: number;
      children: BookTrade[];
      quantity: number;
      remaining: number;
      remainingBuyingPowerChildren: number;
      bp: number;
    }
  >();
  for (const trade of input.trades) {
    if (trade.ignored && !markOnly) continue;
    const key = JSON.stringify([trade.memberId, trade.entryGroupId]);
    let group = groups.get(key);
    if (!group) {
      group = {
        memberId: trade.memberId,
        entryGroupId: trade.entryGroupId,
        simultaneousRank: groupOrders.get(trade.memberId)?.get(trade.entryGroupId) ?? -1,
        children: [],
        quantity: 0,
        remaining: 0,
        remainingBuyingPowerChildren: 0,
        bp: 0,
      };
      groups.set(key, group);
    }
    group.children.push(trade);
    group.remaining++;
    if (!trade.ignored || countIgnoredBuyingPower) group.remainingBuyingPowerChildren++;
  }
  type Group = typeof groups extends Map<string, infer G> ? G : never;
  const activeGroups = new Set<Group>();
  let executedIgnoredOnlyGroups = 0;
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
  const markedEquity: DatedEquity[] = [];
  let markedInsolvent = false;
  const events: Array<{
    date: string;
    time: number;
    kind: "open" | "close";
    group: Group;
    child?: BookTrade;
  }> = [];
  for (const group of groups.values()) {
    const first = group.children[0];
    group.bp =
      input.reservationMode === "sharedEntryGroup"
        ? group.children.reduce(
            (bp, t) =>
              !t.ignored || countIgnoredBuyingPower ? Math.max(bp, t.buyingPowerPerContract) : bp,
            0,
          )
        : group.children.reduce(
            (sum, t) =>
              !t.ignored || countIgnoredBuyingPower ? sum + t.buyingPowerPerContract : sum,
            0,
          );
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
  const openCounts: Record<string, number> = Object.fromEntries(
    input.simultaneousOrder.map((id) => [id, 0]),
  );
  const equity: DatedEquity[] = [];
  let cursor = 0;
  for (const date of input.dates) {
    let closingCashFlow = 0;
    while (cursor < events.length && events[cursor].date <= date) {
      const event = events[cursor++];
      const group = event.group;
      const summary = summaries[group.memberId];
      const member = input.members[group.memberId];
      if (event.kind === "open") {
        // An all-ignored excluded group still needs unit economics for sizing, not capacity.
        const bp = group.bp || group.children[0].buyingPowerPerContract;
        let quantity =
          member.sizing.mode === "allocation"
            ? Math.floor((Math.max(0, funds) * member.sizing.allocationPercentage) / 100 / bp)
            : member.sizing.mode === "fixed"
              ? member.sizing.contracts
              : Math.floor(Math.max(0, funds) / member.sizing.capitalPerContract);
        if (member.minimumOne && funds > 0) quantity = Math.max(1, quantity);
        if (member.maxContractsPerTrade !== null)
          quantity = Math.min(quantity, member.maxContractsPerTrade);
        if (member.maxAllocationAmount !== null)
          quantity = Math.min(quantity, Math.floor(member.maxAllocationAmount / bp));
        if (
          group.bp > 0 &&
          !member.ignoreMarginRequirements &&
          member.sizing.mode !== "capitalPerContract"
        )
          quantity = Math.min(quantity, Math.floor(Math.max(0, funds - reserved) / group.bp));
        if (
          member.removed ||
          funds <= 0 ||
          (member.maxOpenTrades !== null && openCounts[group.memberId] >= member.maxOpenTrades)
        )
          quantity = 0;
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
        summary.contractsPerEntry.push({ entryGroupId: group.entryGroupId, contracts: quantity });
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

function validateReplay(input: BookReplayInput): void {
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
  if (!positive(input.startingFunds)) fail("startingFunds");
  if (
    !input.dates.length ||
    input.dates.some((date, i) => !dateValid(date) || (i > 0 && date <= input.dates[i - 1]))
  )
    fail("dates");
  if (
    !["sharedEntryGroup", "sumChildren"].includes(input.reservationMode) ||
    input.sharedEntryGroupBuyingPower !== "equalPackageMaximum"
  )
    fail("reservation declarations");
  if (input.liquidityThresholdContracts !== null && !positive(input.liquidityThresholdContracts))
    fail("liquidityThresholdContracts");
  const ids = Object.keys(input.members);
  if (
    input.simultaneousOrder.length !== ids.length ||
    new Set(input.simultaneousOrder).size !== ids.length ||
    input.simultaneousOrder.some((id) => !Object.hasOwn(input.members, id))
  )
    fail("simultaneousOrder");
  for (const member of Object.values(input.members)) {
    if (
      [member.removed, member.minimumOne, member.ignoreMarginRequirements].some(
        (v) => typeof v !== "boolean",
      )
    )
      fail("member booleans");
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
      if (!positive(rule.capitalPerContract) || member.ignoreMarginRequirements)
        fail("capitalPerContract requires margin flag false");
    } else fail("sizing mode");
  }
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
