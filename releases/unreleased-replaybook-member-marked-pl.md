# Unreleased — Book replay member marked P/L

The public `@tradeblocks/lib` `replayBook` calculation accepts optional `memberMarkedPl: true` alongside `marks`. It adds `marked.members: Array<{ memberId, daily: Array<{ date, pl }> }>` in the declared member order, with every series aligned to the replay dates. Daily net-dollar P/L includes realized cash changes and remaining open marks at the replay's actual executed quantities; member flows reconcile to each day's aggregate marked-equity change, including day one from starting funds.

Partial closes, ignored mark-only drop-off and positions open at the cutoff retain the aggregate replay's treatment in both mark and reservation modes. Ignored drop-off belongs to the ignored position's member; no unowned flow or residual is introduced. Net inputs already include fees and are not charged again. Removed and zero-quantity members receive zero series. Attribution changes neither admission nor aggregate results. Omitting the option preserves the existing output exactly.

Requesting attribution without marks explicitly throws `Invalid book replay: memberMarkedPl requires marks`: closed-equity-only flows are not marked values. Missing marks remain errors, without fills or invented closes. No MCP tool exposes this replay interface, and existing MCP tools are unchanged.
