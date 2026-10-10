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
}
export interface BookReplayInput {
  startingFunds: number;
  dates: string[];
  trades: BookTrade[];
  members: Record<string, BookMember>;
  reservationMode: "sharedEntryGroup" | "sumChildren";
  sharedEntryGroupBuyingPower: "equalPackageMaximum";
  simultaneousOrder: string[];
  liquidityThresholdContracts: number | null;
  marks?: BookMarks;
}
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
    zeroGroups: number;
    closedRows: number;
    openRows: number;
    openGroups: number;
  };
  warnings: string[];
  insolvent: boolean;
  liquidityFlag: boolean;
  declarations: BookReplayInput;
  marked?: BookMarkedResult;
}

/** Closed-equity replay, not a marked account path or a census of attempted entries. */
export function replayBook(input: BookReplayInput): BookReplayResult {
  validateReplay(input);
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
  const groups = new Map<
    string,
    {
      memberId: string;
      entryGroupId: string;
      children: BookTrade[];
      quantity: number;
      remaining: number;
      bp: number;
    }
  >();
  for (const trade of input.trades) {
    if (trade.ignored) continue;
    const key = JSON.stringify([trade.memberId, trade.entryGroupId]);
    let group = groups.get(key);
    if (!group) {
      group = {
        memberId: trade.memberId,
        entryGroupId: trade.entryGroupId,
        children: [],
        quantity: 0,
        remaining: 0,
        bp: 0,
      };
      groups.set(key, group);
    }
    group.children.push(trade);
    group.remaining++;
  }
  type Group = typeof groups extends Map<string, infer G> ? G : never;
  const activeGroups = new Set<Group>();
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
        ? group.children.reduce((bp, t) => Math.max(bp, t.buyingPowerPerContract), 0)
        : group.children.reduce((sum, t) => sum + t.buyingPowerPerContract, 0);
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
      a.group.entryGroupId.localeCompare(b.group.entryGroupId) ||
      (a.child?.id ?? "").localeCompare(b.child?.id ?? ""),
  );
  const openCounts: Record<string, number> = Object.fromEntries(
    input.simultaneousOrder.map((id) => [id, 0]),
  );
  const equity: DatedEquity[] = [];
  let cursor = 0;
  for (const date of input.dates) {
    while (cursor < events.length && events[cursor].date <= date) {
      const event = events[cursor++];
      const group = event.group;
      const summary = summaries[group.memberId];
      const member = input.members[group.memberId];
      if (event.kind === "open") {
        const bp = group.children[0].buyingPowerPerContract;
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
        if (!member.ignoreMarginRequirements && member.sizing.mode !== "capitalPerContract")
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
      } else {
        const child = event.child!;
        const pl = group.quantity * child.netPlPerContract;
        funds += pl;
        summary.netPl += pl;
        insolvent ||= funds <= 0 || !Number.isFinite(funds);
        group.remaining--;
        if (group.quantity > 0) {
          closedRows++;
          if (input.reservationMode === "sumChildren")
            reserved -= group.quantity * child.buyingPowerPerContract;
          else if (group.remaining === 0) reserved -= group.quantity * group.bp;
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
      for (const group of activeGroups) {
        if (input.marks.mode === "entryGroup") {
          const key = JSON.stringify([group.memberId, group.entryGroupId, date]);
          const mark = markValues.get(key);
          if (mark === undefined) throw new RangeError(`missing_mark_coverage: ${key}`);
          markedFunds += group.quantity * mark;
        } else {
          for (const child of group.children) {
            if (child.dateClosed <= date) continue;
            const key = JSON.stringify([child.id, date]);
            const mark = markValues.get(key);
            if (mark === undefined) throw new RangeError(`missing_mark_coverage: ${key}`);
            markedFunds += group.quantity * mark;
          }
        }
      }
      markedEquity.push({ date, equity: markedFunds });
      markedInsolvent ||= markedFunds <= 0 || !Number.isFinite(markedFunds);
    }
  }
  const startingEquity = { date: input.dates[0], equity: input.startingFunds };
  const drawdownEpisodes = insolvent ? [] : drawdownEpisodesFromEquity([startingEquity, ...equity]);
  const maxDrawdownEpisode = drawdownEpisodes.reduce<DrawdownEpisode | null>(
    (worst, episode) => (!worst || episode.depthPct > worst.depthPct ? episode : worst),
    null,
  );
  const open = [...groups.values()].filter((g) => g.quantity > 0 && g.remaining > 0);
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
      zeroGroups: members.reduce((n, m) => n + m.zeroGroups, 0),
      closedRows,
      openRows: open.reduce((n, g) => n + g.remaining, 0),
      openGroups: open.length,
    },
    warnings: [
      "Closed equity excludes open-position marks and unobserved opportunities.",
      ...members
        .filter((m) => input.members[m.memberId].maxOpenTrades === null)
        .map((m) => `maxOpenTrades unavailable: ${m.memberId}`),
    ],
    insolvent,
    liquidityFlag:
      input.liquidityThresholdContracts !== null &&
      members.some((m) => m.maxContractsPerTrade > input.liquidityThresholdContracts!),
    declarations: input,
    ...(marked ? { marked } : {}),
  };
}

function validateReplay(input: BookReplayInput): void {
  const fail = (name: string): never => {
    throw new RangeError(`Invalid book replay: ${name}`);
  };
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
    if (trade.ignored) continue;
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
        clockSeconds(first.timeOpened) !== clockSeconds(trade.timeOpened) ||
        (input.reservationMode === "sharedEntryGroup" &&
          first.buyingPowerPerContract !== trade.buyingPowerPerContract))
    )
      fail("ambiguous entry group or unequal package BP");
    groups.set(key, trade);
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
          !groups.has(JSON.stringify([mark.memberId, mark.entryGroupId])) ||
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
