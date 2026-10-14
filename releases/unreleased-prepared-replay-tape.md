# Unreleased — Reusable prepared replay tapes

`searchBookAtDrawdown` now prepares invariant replay data once per search, lazily at its first uncached evaluation. Robust and drop-one evaluations reuse that preparation; bootstrap replicates prepare their own resampled tapes. Member validation, sizing, buying power and mutable replay state remain fresh for every candidate.

For repeated replay calls or short searches over the same tape, `prepareReplayTape(input)` returns an opaque, frozen `PreparedReplayTape` handle. Pass it through `replayBook(input, { preparedTape })` or `searchBookAtDrawdown(input, { preparedTape, ...otherOptions })`. Omitting the handle preserves ordinary validation and replay behavior.

Each call checks the handle against the complete invariant tape declaration, including dates, trade economics and identity, marks, ordering, starting funds and tape policies. A mismatch throws `prepared_replay_tape_mismatch`; member sizing, caps, flags, schedules and reporting options can vary and are validated per call. Prepare separate handles for different ignored-buying-power hypotheses. Matching uses the full canonical values as well as their fingerprint, so a hash collision cannot admit stale input.

Handles are local runtime objects, not serialized checkpoints or an input-identity cache. Prepared data is detached from caller input and held privately; inspecting the token cannot expose it. Checkpoint identity, replay results, provider requirements and MCP tools are unchanged. This is a library-only reuse option, not a parallel search runner.
