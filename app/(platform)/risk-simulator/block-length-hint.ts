export type BlockStepUnit = "trades" | "days";

export interface BlockLengthHintInput {
  /**
   * Mean block length the last completed run actually used, or null when no run
   * has completed yet or that run resampled independently instead of in blocks.
   */
  lastRunBlockLength: number | null;
  /** Mean block length that run was asked for (null when it was left on auto) */
  lastRunRequestedBlockLength: number | null;
  /** What that run counted blocks in, null when no run has completed */
  lastRunStepUnit: BlockStepUnit | null;
  /** Mean block length the form asks for now (null when left on auto) */
  requestedBlockLength: number | null;
  /**
   * Automatic block length previewed from the estimated resample pool. Only an
   * estimate: the pool is counted from the trades in scope before the run.
   */
  estimatedBlockLength: number;
  /** What the form counts blocks in now */
  stepUnit: BlockStepUnit;
}

export interface BlockLengthHint {
  /**
   * Where the number comes from. "run" is the authoritative value a completed
   * run reported, "manual" is the exact value typed into the form, "estimate"
   * is the pre-run preview of what auto will pick.
   */
  source: "run" | "manual" | "estimate";
  blockLength: number;
  /** True while the form's mean block length is set by hand */
  manual: boolean;
  /** Unit the number is counted in */
  stepUnit: BlockStepUnit;
}

/**
 * Which block length to show.
 *
 * Before a run there is only the preview, computed from an estimate of the
 * resample pool. Once a run completes it reports the block length it actually
 * used, and that number replaces the estimate — but only while the form still
 * asks for the same thing that run was given. Typing a different mean block
 * length, or resampling in days instead of trades, makes the run's number
 * describe something the form no longer asks for, so the hint goes back to
 * previewing the current settings.
 */
export function selectBlockLengthHint(input: BlockLengthHintInput): BlockLengthHint {
  const {
    lastRunBlockLength,
    lastRunRequestedBlockLength,
    lastRunStepUnit,
    requestedBlockLength,
    estimatedBlockLength,
    stepUnit,
  } = input;

  const manual = requestedBlockLength !== null;

  if (
    lastRunBlockLength !== null &&
    lastRunStepUnit === stepUnit &&
    lastRunRequestedBlockLength === requestedBlockLength
  ) {
    return { source: "run", blockLength: lastRunBlockLength, manual, stepUnit };
  }

  if (requestedBlockLength !== null) {
    return { source: "manual", blockLength: requestedBlockLength, manual, stepUnit };
  }

  return { source: "estimate", blockLength: estimatedBlockLength, manual, stepUnit };
}

/**
 * The block length as a phrase that can sit inside a longer sentence. Says
 * "about" only for the pre-run estimate, so an estimate never reads like a fact
 * and the run's own number never reads like a guess.
 */
export function describeBlockLength(hint: BlockLengthHint): string {
  const { blockLength, stepUnit } = hint;

  switch (hint.source) {
    case "run":
      return `your last run used ${blockLength} ${stepUnit} per block`;
    case "manual":
      return `${blockLength} ${stepUnit} per block`;
    case "estimate":
      return `about ${blockLength} ${stepUnit} per block for your current pool`;
  }
}

/** Helper text under the mean-block-length input. */
export function describeBlockLengthSetting(
  hint: BlockLengthHint,
  stationaryBlocks: boolean,
): string {
  if (!stationaryBlocks) {
    return "Only used with stationary-block resampling";
  }

  const { blockLength, stepUnit } = hint;
  const backToAuto = hint.manual ? "; blank returns to auto" : "";

  if (hint.source === "run") {
    return `Your last run used ${blockLength} ${stepUnit} per block${backToAuto}`;
  }

  if (hint.source === "manual") {
    return `Blocks average ${blockLength} ${stepUnit}${backToAuto}`;
  }

  return `Auto: about ${blockLength} ${stepUnit} per block for your current pool`;
}
