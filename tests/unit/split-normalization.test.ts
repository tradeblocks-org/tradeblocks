import { normalizeSplitAdjustedRows } from "@tradeblocks/lib";

const action = { ticker: "TSLA", date: "2022-08-25", ratio: 3 };
const freshRow = {
  underlying: "TSLA",
  dateOpened: "2022-08-24",
  timeOpened: "15:20:00",
  dateClosed: "2022-08-25",
  numberOfContracts: 3,
  profit: 40.97,
  buyingPowerRequired: 23084.8,
  wasAdjusted: true,
};

it("preserves native cent-rounded P/L on the entry-contract basis", () => {
  const result = normalizeSplitAdjustedRows([freshRow], [action]);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  expect(result.rows[0]).toMatchObject({
    nativeQuantity: 3,
    entryQuantity: 1,
    factor: 3,
    netPlPerContract: 40.97,
    buyingPowerPerContract: 23084.8,
    action,
  });
  expect(result.adjusted_rows).toEqual([
    {
      row_index: 0,
      entry_date: "2022-08-24",
      entry_time: "15:20:00",
      factor: 3,
      native_quantity: 3,
      entry_quantity: 1,
      action,
    },
  ]);
});

it("normalizes the retained two-entry witness without reconstructing premiums", () => {
  const result = normalizeSplitAdjustedRows(
    [{ ...freshRow, numberOfContracts: 6, profit: 81.94, buyingPowerRequired: 46169.6 }],
    [action],
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  expect(result.rows[0]).toMatchObject({
    nativeQuantity: 6,
    entryQuantity: 2,
    netPlPerContract: 40.97,
    buyingPowerPerContract: 23084.8,
  });
});

it("keeps same-opening unadjusted siblings and other tickers on factor one", () => {
  const rows = [
    freshRow,
    { ...freshRow, wasAdjusted: false, dateClosed: "2022-08-24", profit: 10.001 },
    { ...freshRow, wasAdjusted: false, underlying: "SPY" },
    { ...freshRow, wasAdjusted: false, dateOpened: "2022-08-25" },
  ];
  const before = JSON.stringify([rows, action]);
  const result = normalizeSplitAdjustedRows(rows, [action]);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  expect(result.rows.map((row) => [row.entryQuantity, row.factor])).toEqual([
    [1, 3],
    [3, 1],
    [3, 1],
    [3, 1],
  ]);
  expect(result.rows[1].netPlPerContract).toBe(10.001 / 3);
  expect(result.rows[1].row).toBe(rows[1]);
  expect(result.adjusted_rows).toHaveLength(1);
  expect(JSON.stringify([rows, action])).toBe(before);
});

it("supports declared reverse splits and calendar dates without timezone conversion", () => {
  const result = normalizeSplitAdjustedRows(
    [{ ...freshRow, dateOpened: "2024-02-28", dateClosed: "2024-02-29", numberOfContracts: 1 }],
    [{ ...action, date: "2024-02-29", ratio: 0.5 }],
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  expect(result.rows[0]).toMatchObject({
    entryQuantity: 2,
    netPlPerContract: 20.485,
    buyingPowerPerContract: 11542.4,
  });
});

it.each([
  ["no declaration", freshRow, []],
  ["other ticker", freshRow, [{ ...action, ticker: "SPY" }]],
  ["exact ticker identity", freshRow, [{ ...action, ticker: "tsla" }]],
  ["opening on ex-date", { ...freshRow, dateOpened: "2022-08-25" }, [action]],
  ["closing before ex-date", { ...freshRow, dateClosed: "2022-08-24" }, [action]],
] as const)("refuses unknown adjusted row: %s", (_label, row, actions) => {
  expect(normalizeSplitAdjustedRows([row], actions)).toMatchObject({
    ok: false,
    refused: "split-unknown-adjusted-row",
    detail: expect.any(String),
  });
});

it.each([
  [action, action],
  [{ ...action, date: "2022-08-24" }, action],
])("refuses multiple held-across actions, including duplicate declarations", (first, second) => {
  expect(
    normalizeSplitAdjustedRows([{ ...freshRow, dateOpened: "2022-08-23" }], [first, second]),
  ).toMatchObject({ ok: false, refused: "split-multiple-actions" });
});

it.each([2, 4, 6])("refuses a non-whole or sub-one entry quantity with ratio %s", (ratio) => {
  expect(normalizeSplitAdjustedRows([freshRow], [{ ...action, ratio }])).toMatchObject({
    ok: false,
    refused: "split-invalid-entry-quantity",
  });
});

it.each([
  { ...action, ratio: 0 },
  { ...action, ratio: -3 },
  { ...action, ratio: NaN },
  { ...action, ratio: Infinity },
  { ...action, date: "2022-02-29" },
  { ...action, date: "2022-13-01" },
  { ...action, date: "2022-08-25T00:00:00Z" },
  { ...action, ticker: "" },
  { ...action, ticker: " TSLA" },
])("refuses invalid action %j", (invalid) => {
  expect(normalizeSplitAdjustedRows([freshRow], [invalid])).toMatchObject({
    ok: false,
    refused: "split-invalid-action",
  });
});

it("accepts book-level actions unused by an individual tape", () => {
  const result = normalizeSplitAdjustedRows([freshRow], [action, { ...action, ticker: "SPY" }]);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  expect(result.rows[0].entryQuantity).toBe(1);
  expect(result.adjusted_rows).toHaveLength(1);
  expect(normalizeSplitAdjustedRows([], [action])).toEqual({
    ok: true,
    rows: [],
    adjusted_rows: [],
  });
});

it("treats an omitted adjustment flag as false while retaining held-across protection", () => {
  const row = {
    underlying: "TSLA",
    dateOpened: "2022-08-24",
    timeOpened: "15:20:00",
    dateClosed: "2022-08-25",
    numberOfContracts: 3,
    profit: 40.97,
    buyingPowerRequired: 23084.8,
  };
  const result = normalizeSplitAdjustedRows([row], []);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  expect(result.rows[0]).toMatchObject({
    entryQuantity: 3,
    factor: 1,
    netPlPerContract: 40.97 / 3,
    buyingPowerPerContract: 23084.8 / 3,
    action: null,
  });
  expect(result.adjusted_rows).toEqual([]);
  expect(normalizeSplitAdjustedRows([row], [action])).toMatchObject({
    ok: false,
    refused: "split-unadjusted-held-row",
  });
});

it("refuses an unadjusted held-across row instead of scaling or ignoring it", () => {
  expect(
    normalizeSplitAdjustedRows([freshRow, { ...freshRow, wasAdjusted: false }], [action]),
  ).toMatchObject({ ok: false, refused: "split-unadjusted-held-row" });
});

it.each([
  { ...freshRow, dateOpened: "2022-02-30" },
  { ...freshRow, dateClosed: "2022-08-23" },
  { ...freshRow, dateClosed: "0000-01-01" },
  { ...freshRow, timeOpened: "24:00:00" },
  { ...freshRow, wasAdjusted: "false" as unknown as boolean },
  { ...freshRow, underlying: "" },
  { ...freshRow, numberOfContracts: 0 },
  { ...freshRow, numberOfContracts: 1.5 },
  { ...freshRow, profit: NaN },
  { ...freshRow, buyingPowerRequired: Infinity },
  { ...freshRow, buyingPowerRequired: -1 },
])("refuses invalid native row %j", (row) => {
  expect(normalizeSplitAdjustedRows([row], [action])).toMatchObject({
    ok: false,
    refused: "split-invalid-row",
  });
});

it("accepts empty input and unadjusted-only input without declarations", () => {
  expect(normalizeSplitAdjustedRows([], [])).toEqual({ ok: true, rows: [], adjusted_rows: [] });
  const result = normalizeSplitAdjustedRows([{ ...freshRow, wasAdjusted: false }], []);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.detail);
  expect(result.rows[0]).toMatchObject({
    entryQuantity: 3,
    factor: 1,
    netPlPerContract: 40.97 / 3,
    buyingPowerPerContract: 23084.8 / 3,
    action: null,
  });
  expect(result.adjusted_rows).toEqual([]);
});
