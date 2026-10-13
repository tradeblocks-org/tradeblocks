# Unreleased — Fixed member caps in drawdown-budget search

The public `@tradeblocks/lib` `searchBookAtDrawdown` calculation accepts optional `memberCapPolicies: { [memberId]: "fixed" | "scaled" }`. A fixed policy preserves that member's declared `maxContractsPerTrade` while its sizing continues to follow the search weight. It applies to initial vectors, coordinate moves, robust common-factor shrinkage, drop-one reoptimization, and all bootstrap stability and sensitivity panels. Declare the actual liquidity cap directly; caller-side cap precompensation is no longer necessary.

Omitting the map or a member retains the existing scaled-cap behavior. Zero weight still removes the member, null caps remain uncapped, and allocation dollar caps still scale. Unknown member IDs and invalid policies are refused explicitly. `replayBook` and MCP tools are unchanged; no provider or market-data dependency is added.
