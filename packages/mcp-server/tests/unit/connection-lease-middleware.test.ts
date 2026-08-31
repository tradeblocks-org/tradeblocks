/**
 * The tool-registration lease wrapper (#445).
 *
 * Why this exists separately from the idle-release integration tests: those prove the
 * lease mechanism works when a lease is taken. They say nothing about whether the
 * wrapper actually takes one. A wrapper applied to the wrong object, or one that
 * stopped recognising the SDK's handler position, would silently mean "no lease" on
 * every tool — and every other test in the suite would still pass, while production
 * released the handle mid-call. So the assertion here is on the lease count observed
 * from INSIDE a registered handler.
 */
// @ts-expect-error - importing from the source barrel used by the other suites
import { leaseToolHandlers, getConnectionLeaseCount } from "../../src/test-exports.ts";

/** Minimal stand-in for the SDK server: records what was registered. */
function makeFakeServer() {
  const registered: Record<string, (...args: unknown[]) => unknown> = {};
  return {
    registered,
    unrelatedProperty: "untouched",
    registerTool(name: string, _config: unknown, handler: (...args: unknown[]) => unknown) {
      // `this` must be the real server, not the proxy, or SDK internals break.
      if (this !== server) throw new Error("registerTool lost its `this` binding");
      registered[name] = handler;
      return { name };
    },
  };
}
const server = makeFakeServer();

describe("leaseToolHandlers", () => {
  afterEach(() => {
    // Never leak a lease into another suite.
    expect(getConnectionLeaseCount()).toBe(0);
  });

  it("holds a lease for the duration of a tool handler", async () => {
    const leased = leaseToolHandlers(server);
    let leaseInsideHandler = -1;

    leased.registerTool("probe", {}, async () => {
      leaseInsideHandler = getConnectionLeaseCount();
      return "done";
    });

    expect(getConnectionLeaseCount()).toBe(0);
    const result = await server.registered.probe();

    expect(result).toBe("done");
    expect(leaseInsideHandler).toBe(1);
    expect(getConnectionLeaseCount()).toBe(0);
  });

  it("releases the lease when a handler throws", async () => {
    const leased = leaseToolHandlers(server);
    leased.registerTool("boom", {}, async () => {
      throw new Error("tool failed");
    });

    await expect(server.registered.boom()).rejects.toThrow("tool failed");
    // A leaked lease here would pin the handle open forever — the exact defect
    // #445 fixes, reintroduced by an error path.
    expect(getConnectionLeaseCount()).toBe(0);
  });

  it("passes handler arguments and the return value through untouched", async () => {
    const leased = leaseToolHandlers(server);
    leased.registerTool("echo", {}, async (a: unknown, b: unknown) => ({ a, b }));

    await expect(server.registered.echo(1, "two")).resolves.toEqual({ a: 1, b: "two" });
  });

  it("counts nested handlers so an inner call cannot release an outer lease", async () => {
    const leased = leaseToolHandlers(server);
    const seen: number[] = [];

    leased.registerTool("inner", {}, async () => {
      seen.push(getConnectionLeaseCount());
    });
    leased.registerTool("outer", {}, async () => {
      seen.push(getConnectionLeaseCount());
      await server.registered.inner();
      // If the inner handler's release dropped the count to zero, the outer
      // handler's connection could be closed underneath it.
      seen.push(getConnectionLeaseCount());
    });

    await server.registered.outer();

    expect(seen).toEqual([1, 2, 1]);
    expect(getConnectionLeaseCount()).toBe(0);
  });

  it("leaves every other property and method alone", () => {
    const leased = leaseToolHandlers(server);
    expect(leased.unrelatedProperty).toBe("untouched");
  });
});
