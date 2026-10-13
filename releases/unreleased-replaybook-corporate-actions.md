# Unreleased — Corporate-action rows in book replay

The developer guide now explains how callers can reproduce adjusted Option Omega rows with the existing `replayBook` interface: normalize net P/L and open marks to the entry-contract basis, while retaining entry-basis sizing and buying power. A public-entrypoint regression pins the TSLA 3-for-1 case: two entry contracts reproduce six adjusted contracts' $120 settlement and $140 open mark. Replay reports entry quantities; callers retain adjusted quantities separately for settlement displays.

No adjustment field, automatic corporate-action detection, provider requirement, MCP tool change, or replay-algorithm change is introduced. Existing default-output coverage remains unchanged.
