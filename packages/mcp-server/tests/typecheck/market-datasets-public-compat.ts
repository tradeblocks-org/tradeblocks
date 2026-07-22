import { DATASETS_V3, type DatasetDef } from "tradeblocks-mcp/db/market-datasets";

// Compile-only compatibility fixture for the published 3.3.x contract.
const legacyDefinition: DatasetDef = {
  subdir: "enriched",
  partitionKeys: ["ticker"],
  filename: "data.parquet",
};
legacyDefinition.partitionKeys.push("date");

const legacyRegistry: Record<string, DatasetDef> = DATASETS_V3;
legacyRegistry.compatibility_fixture = legacyDefinition;
delete legacyRegistry.compatibility_fixture;
