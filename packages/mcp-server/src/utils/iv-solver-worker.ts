/**
 * iv-solver-worker.ts
 *
 * worker_threads entry point for the parallel option-greeks solve.
 *
 * The Newton-Raphson IV solve in `computeLegGreeks` is pure CPU over
 * independent rows. This worker runs the identical `computeLegGreeks` on a
 * batch of flat numeric jobs and posts back the resulting greeks. Only plain
 * numbers cross the worker boundary, so the output is bit-identical to the
 * inline path (same code, same inputs, same IEEE-754 arithmetic).
 *
 * The batch is encoded as parallel typed arrays for cheap structured-clone
 * transfer:
 *   - optionPrice, underlyingPrice, strike, dte, riskFreeRate, dividendYield
 *     as Float64Array (one entry per job)
 *   - type as Uint8Array (0 = call "C", 1 = put "P")
 * The reply mirrors that shape: delta/gamma/theta/vega/iv as Float64Array plus
 * an `ok` Uint8Array flag (1 = greeks finite, 0 = solve failed → caller treats
 * the row as math-failed, exactly as the inline path's null result does).
 */

import { parentPort } from "node:worker_threads";
import { computeLegGreeks } from "./black-scholes.ts";

export interface IvSolveBatchRequest {
  id: number;
  count: number;
  optionPrice: Float64Array;
  underlyingPrice: Float64Array;
  strike: Float64Array;
  dte: Float64Array;
  riskFreeRate: Float64Array;
  dividendYield: Float64Array;
  type: Uint8Array; // 0 = call, 1 = put
}

export interface IvSolveBatchReply {
  id: number;
  count: number;
  delta: Float64Array;
  gamma: Float64Array;
  theta: Float64Array;
  vega: Float64Array;
  iv: Float64Array;
  ok: Uint8Array; // 1 = all five greeks finite, 0 = solve failed
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Run `computeLegGreeks` over a flat batch. Shared by the worker message
 * handler and by the inline fallback in the pool, so both paths execute the
 * exact same loop.
 */
export function solveIvBatch(req: IvSolveBatchRequest): IvSolveBatchReply {
  const { id, count } = req;
  const delta = new Float64Array(count);
  const gamma = new Float64Array(count);
  const theta = new Float64Array(count);
  const vega = new Float64Array(count);
  const iv = new Float64Array(count);
  const ok = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const result = computeLegGreeks(
      req.optionPrice[i],
      req.underlyingPrice[i],
      req.strike[i],
      req.dte[i],
      req.type[i] === 0 ? "C" : "P",
      req.riskFreeRate[i],
      req.dividendYield[i],
    );
    if (
      isFiniteNumber(result.delta) &&
      isFiniteNumber(result.gamma) &&
      isFiniteNumber(result.theta) &&
      isFiniteNumber(result.vega) &&
      isFiniteNumber(result.iv)
    ) {
      delta[i] = result.delta;
      gamma[i] = result.gamma;
      theta[i] = result.theta;
      vega[i] = result.vega;
      iv[i] = result.iv;
      ok[i] = 1;
    } else {
      ok[i] = 0;
    }
  }

  return { id, count, delta, gamma, theta, vega, iv, ok };
}

if (parentPort) {
  const port = parentPort;
  port.on("message", (req: IvSolveBatchRequest) => {
    const reply = solveIvBatch(req);
    // Transfer the result buffers back to the main thread to avoid a copy.
    // These are freshly-allocated ArrayBuffer-backed typed arrays.
    port.postMessage(reply, [
      reply.delta.buffer,
      reply.gamma.buffer,
      reply.theta.buffer,
      reply.vega.buffer,
      reply.iv.buffer,
      reply.ok.buffer,
    ] as ArrayBuffer[]);
  });
}
