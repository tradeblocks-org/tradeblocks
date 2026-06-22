import type { Trade } from "../models/trade.ts";

function scaleNumeric(value: number, factor: number): number {
  return Number.isFinite(value) ? value * factor : value;
}

function sortTradesChronologically(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => {
    const dateA = new Date(a.dateClosed ?? a.dateOpened);
    const dateB = new Date(b.dateClosed ?? b.dateOpened);

    if (!isFinite(dateA.getTime()) || !isFinite(dateB.getTime())) {
      return 0;
    }

    const diff = dateA.getTime() - dateB.getTime();
    if (diff !== 0) return diff;

    const timeA = a.timeClosed ?? a.timeOpened;
    const timeB = b.timeClosed ?? b.timeOpened;
    return (timeA || "").localeCompare(timeB || "");
  });
}

function calculateInitialCapitalPerLot(trades: Trade[]): number {
  if (trades.length === 0) return 100_000;

  const chronological = sortTradesChronologically(trades);
  const firstTrade = chronological[0];
  const capitalBeforeTrade = firstTrade.fundsAtClose - firstTrade.pl;
  const contracts = Math.max(1, Math.abs(firstTrade.numContracts) || 1);
  const perLotCapital = capitalBeforeTrade / contracts;

  if (!Number.isFinite(perLotCapital) || perLotCapital <= 0) {
    return 100_000;
  }

  return perLotCapital;
}

function normalizeTradeToOneLotInternal(trade: Trade): Trade {
  const contracts = Math.abs(trade.numContracts);
  if (!Number.isFinite(contracts) || contracts <= 1) {
    return {
      ...trade,
      numContracts: 1,
    };
  }

  const factor = 1 / contracts;

  return {
    ...trade,
    pl: trade.pl * factor,
    marginReq: scaleNumeric(trade.marginReq, factor),
    openingCommissionsFees: scaleNumeric(trade.openingCommissionsFees, factor),
    closingCommissionsFees: scaleNumeric(trade.closingCommissionsFees, factor),
    numContracts: 1,
  };
}

export function normalizeTradeToOneLot(trade: Trade): Trade {
  return normalizeTradesToOneLot([trade])[0];
}

export function normalizeTradesToOneLot(trades: Trade[]): Trade[] {
  if (trades.length === 0) return [];

  const normalized = trades.map((trade) => normalizeTradeToOneLotInternal(trade));

  const chronological = trades
    .map((trade, index) => ({ trade, index }))
    .sort((a, b) => {
      const dateA = new Date(a.trade.dateClosed ?? a.trade.dateOpened);
      const dateB = new Date(b.trade.dateClosed ?? b.trade.dateOpened);

      if (!isFinite(dateA.getTime()) || !isFinite(dateB.getTime())) {
        return 0;
      }

      const diff = dateA.getTime() - dateB.getTime();
      if (diff !== 0) return diff;

      const timeA = a.trade.timeClosed ?? a.trade.timeOpened;
      const timeB = b.trade.timeClosed ?? b.trade.timeOpened;
      return (timeA || "").localeCompare(timeB || "");
    });

  const initialCapitalPerLot = calculateInitialCapitalPerLot(trades);
  let runningEquity = initialCapitalPerLot;

  chronological.forEach(({ index }) => {
    const normalizedTrade = normalized[index];
    runningEquity += normalizedTrade.pl;
    normalizedTrade.fundsAtClose = runningEquity;
  });

  return normalized;
}
