import {
  processStaticDatasetContent,
  getMatchedValuesForTrade,
  getMatchedFieldValue,
  resolveDatasetColumnAtTime,
  getDatasetValueAvailableAt,
  validateDatasetTiming,
  createStaticDataset,
  getStaticDataset,
  getStaticDatasetByName,
  getAllStaticDatasets,
  updateStaticDatasetTiming,
  deleteDatabase,
  type Trade,
} from "../../packages/lib";

it("does not expose a date-only close value until the following day", async () => {
  const parsed = await processStaticDatasetContent("date,signal\n2024-03-08,42", {
    name: "model",
    fileName: "model.csv",
  });
  const data = [
    {
      dataset: parsed.dataset,
      rows: parsed.rows.map((row) => ({ ...row, datasetId: parsed.dataset.id })),
    },
  ];
  const trade = { dateOpened: new Date("2024-03-08"), timeOpened: "09:45:00" } as Trade;
  expect(getMatchedValuesForTrade(trade, data)).toEqual({});
  expect(getMatchedValuesForTrade({ ...trade, dateOpened: new Date("2024-03-11") }, data)).toEqual({
    model: { signal: 42 },
  });
});

it("resolves mixed open/close columns independently, with known-by and DST", async () => {
  const parsed = await processStaticDatasetContent("date,opening,closing\n2024-03-11,10,20", {
    name: "mixed",
    fileName: "mixed.csv",
    columnTiming: { opening: "open", closing: "close" },
    knownBy: "09:30",
  });
  expect(parsed.errors).toEqual([]);
  const rows = parsed.rows.map((row) => ({ ...row, datasetId: parsed.dataset.id }));
  expect(
    resolveDatasetColumnAtTime(parsed.dataset, rows, "opening", new Date("2024-03-11T13:29:59Z")),
  ).toBeNull();
  expect(
    resolveDatasetColumnAtTime(parsed.dataset, rows, "opening", new Date("2024-03-11T13:30:00Z"))
      ?.value,
  ).toBe(10);
  expect(getDatasetValueAvailableAt(parsed.dataset, rows[0], "closing").toISOString()).toBe(
    "2024-03-12T04:00:00.000Z",
  );
  const data = [{ dataset: parsed.dataset, rows }];
  expect(
    getMatchedFieldValue(
      { dateOpened: new Date(2024, 2, 11), timeOpened: "09:45" } as Trade,
      "mixed.opening",
      data,
    ),
  ).toBe(10);
  expect(
    getMatchedValuesForTrade(
      { dateOpened: new Date(2024, 2, 11), timeOpened: "09:45" } as Trade,
      data,
    ),
  ).toEqual({ mixed: { opening: 10 } });
  expect(() => resolveDatasetColumnAtTime(parsed.dataset, rows, "missing", new Date())).toThrow(
    "Unknown dataset column",
  );
});

it("refuses date-only open without known-by and unknown timing columns", async () => {
  const parsed = await processStaticDatasetContent("date,signal\n2020-01-02,42", {
    name: "model",
    fileName: "m.csv",
    columnTiming: { signal: "open" },
  });
  expect(parsed.errors).toEqual([expect.stringContaining("requires a known-by")]);
  expect(() => validateDatasetTiming({ ...parsed.dataset, knownBy: "25:00" }, true)).toThrow(
    "HH:mm",
  );
  expect(() =>
    validateDatasetTiming(
      { ...parsed.dataset, columnTiming: { signal: "close", typo: "close" } },
      true,
    ),
  ).toThrow("Unknown dataset column");
});

it("treats explicit midnight timestamps as-of, not as date-only closes", async () => {
  const parsed = await processStaticDatasetContent("date,signal\n2024-01-15T00:00:00-05:00,42", {
    name: "model",
    fileName: "m.csv",
  });
  const rows = parsed.rows.map((row) => ({ ...row, datasetId: parsed.dataset.id }));
  expect(
    resolveDatasetColumnAtTime(parsed.dataset, rows, "signal", new Date("2024-01-15T04:59:59Z")),
  ).toBeNull();
  expect(
    resolveDatasetColumnAtTime(parsed.dataset, rows, "signal", new Date("2024-01-15T05:00:00Z"))
      ?.value,
  ).toBe(42);
});

it("keeps legacy IndexedDB numbers unchanged until an explicit timing update", async () => {
  const parsed = await processStaticDatasetContent("date,signal\n2020-01-02,42", {
    name: "legacy",
    fileName: "old.csv",
  });
  const { timingMode: _mode, columnTiming: _timing, ...legacy } = parsed.dataset;
  await createStaticDataset(legacy);
  try {
    const loaded = (await getStaticDataset(legacy.id))!;
    expect(loaded.timingMode).toBe("legacy-same-day");
    expect((await getStaticDatasetByName("legacy"))?.timingMode).toBe("legacy-same-day");
    expect((await getAllStaticDatasets())[0].timingMode).toBe("legacy-same-day");
    const rows = parsed.rows.map(({ dateOnly: _precision, ...row }) => ({
      ...row,
      datasetId: legacy.id,
    }));
    const trade = { dateOpened: new Date(2020, 0, 2), timeOpened: "09:45" } as Trade;
    expect(getMatchedValuesForTrade(trade, [{ dataset: loaded, rows }])).toEqual({
      legacy: { signal: 42 },
    });
    await updateStaticDatasetTiming(
      legacy.id,
      { columnTiming: { signal: "close" }, dateOnly: true },
      true,
    );
    const updated = (await getStaticDataset(legacy.id))!;
    expect(updated.timingMode).toBe("declared");
    expect(getMatchedValuesForTrade(trade, [{ dataset: updated, rows }])).toEqual({});
  } finally {
    await deleteDatabase();
  }
});

it("skips blank observations and carries forward the last real value", async () => {
  const parsed = await processStaticDatasetContent(
    "date,x\n2025-01-02,1.5\n2025-01-03, \n2025-01-06,2.5",
    { name: "blank", fileName: "blank.csv" },
  );
  expect(parsed.errors).toEqual([]);
  expect(parsed.rows[1].values).toEqual({});
  const rows = parsed.rows.map((row) => ({ ...row, datasetId: parsed.dataset.id }));
  expect(
    resolveDatasetColumnAtTime(parsed.dataset, rows, "x", new Date("2025-01-04T15:00:00Z"))?.value,
  ).toBe(1.5);
  const legacyBlank = [
    ...rows,
    {
      datasetId: parsed.dataset.id,
      timestamp: new Date("2025-01-03T05:00:00Z"),
      dateOnly: true,
      values: { x: "  " },
    },
  ];
  expect(
    resolveDatasetColumnAtTime(parsed.dataset, legacyBlank, "x", new Date("2025-01-04T15:00:00Z"))
      ?.value,
  ).toBe(1.5);
});

it.each(["same-day", "nearest-after", "nearest", "exact", "nearest-before"] as const)(
  "honors declared availability with stored strategy %s",
  async (matchStrategy) => {
    const parsed = await processStaticDatasetContent("date,x\n2025-01-02,1.5\n2025-01-03,2.5", {
      name: "declared",
      fileName: "declared.csv",
      matchStrategy,
    });
    const data = [
      {
        dataset: parsed.dataset,
        rows: parsed.rows.map((row) => ({ ...row, datasetId: parsed.dataset.id })),
      },
    ];
    expect(
      getMatchedValuesForTrade(
        { dateOpened: new Date("2025-01-03"), timeOpened: "10:00:00" } as Trade,
        data,
      ),
    ).toEqual({ declared: { x: 1.5 } });
  },
);

it.each([
  ["2025-01-03", "2025-01-06T15:00:00Z", "close", 0],
  ["2025-01-02", "2025-01-06T15:00:00Z", "close", 1],
  ["2026-07-02", "2026-07-06T14:00:00Z", "close", 0],
  ["2030-12-31", "2031-01-02T15:00:00Z", "close", "unsupported"],
  ["2025-01-03", "2025-01-06T14:29:00Z", "open", 0],
  ["2025-01-03", "2025-01-06T14:30:00Z", "open", 1],
] as const)("counts missed sessions from %s at %s (%s)", async (source, entry, timing, age) => {
  const parsed = await processStaticDatasetContent(`date,x\n${source},1`, {
    name: "sessions",
    fileName: "sessions.csv",
    columnTiming: { x: timing },
    knownBy: "09:30",
  });
  const rows = parsed.rows.map((row) => ({ ...row, datasetId: parsed.dataset.id }));
  expect(resolveDatasetColumnAtTime(parsed.dataset, rows, "x", new Date(entry))).toEqual(
    expect.objectContaining({ value: 1, sessionAge: age, accepted: true }),
  );
  expect(resolveDatasetColumnAtTime(parsed.dataset, rows, "x", new Date(entry), 0)).toEqual(
    expect.objectContaining({ sessionAge: age, accepted: age === 0 }),
  );
});
