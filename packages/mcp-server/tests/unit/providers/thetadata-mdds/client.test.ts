import { describe, expect, it } from "@jest/globals";
import {
  buildThetaQueryInfo,
  getThetaMddsConfig,
  isRetryableGrpcCode,
  ThetaMddsClient,
} from "../../../../src/utils/providers/thetadata/client.ts";

interface FakeStream<T> {
  on(event: "data", listener: (chunk: T) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  finish(chunk: T): void;
  emitData(chunk: T): void;
  emitError(error: unknown): void;
  emitEnd(): void;
}

interface TestableThetaMddsClient {
  stub: Record<string, unknown> | null;
  sessionId: string | null;
  concurrencyLimit: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createFakeStream<T>(): FakeStream<T> {
  const dataListeners: Array<(chunk: T) => void> = [];
  const errorListeners: Array<(error: unknown) => void> = [];
  const endListeners: Array<() => void> = [];
  return {
    on(
      event: "data" | "error" | "end",
      listener: ((chunk: T) => void) | ((error: unknown) => void) | (() => void),
    ) {
      if (event === "data") dataListeners.push(listener as (chunk: T) => void);
      if (event === "error") errorListeners.push(listener as (error: unknown) => void);
      if (event === "end") endListeners.push(listener as () => void);
    },
    finish(chunk: T) {
      for (const listener of dataListeners) listener(chunk);
      for (const listener of endListeners) listener();
    },
    emitData(chunk: T) {
      for (const listener of dataListeners) listener(chunk);
    },
    emitError(error: unknown) {
      for (const listener of errorListeners) listener(error);
    },
    emitEnd() {
      for (const listener of endListeners) listener();
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("ThetaData MDDS client shell", () => {
  it("builds QueryInfo with auth_token in the request body", () => {
    expect(
      buildThetaQueryInfo("session-abc", {
        THETADATA_MDDS_CLIENT_TYPE: "terminal",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      authToken: { sessionUuid: "session-abc" },
      queryParameters: { client: "terminal" },
      clientType: "terminal",
      terminalGitCommit: "",
      terminalVersion: expect.any(String),
    });
  });

  it("resolves config defaults and env overrides", () => {
    const config = getThetaMddsConfig({
      THETADATA_MDDS_HOST: "example.test",
      THETADATA_MDDS_PORT: "8443",
      THETADATA_MDDS_MAX_ATTEMPTS: "5",
      THETADATA_MDDS_RETRY_BASE_MS: "10",
      THETADATA_MDDS_MAX_CONCURRENCY: "3",
    } as NodeJS.ProcessEnv);
    expect(config.target).toBe("example.test:8443");
    expect(config.maxAttempts).toBe(5);
    expect(config.retryBaseMs).toBe(10);
    expect(config.maxConcurrency).toBe(3);
  });

  it("falls back to defaults for non-positive numeric config values", () => {
    const config = getThetaMddsConfig({
      THETADATA_MDDS_MAX_ATTEMPTS: "-2",
      THETADATA_MDDS_RETRY_BASE_MS: "0",
      THETADATA_MDDS_MAX_CONCURRENCY: "-3",
    } as NodeJS.ProcessEnv);
    expect(config.maxAttempts).toBe(4);
    expect(config.retryBaseMs).toBe(250);
    expect(config.maxConcurrency).toBeUndefined();
  });

  it("classifies retryable grpc status codes", () => {
    expect(isRetryableGrpcCode(14)).toBe(true); // UNAVAILABLE
    expect(isRetryableGrpcCode(4)).toBe(true); // DEADLINE_EXCEEDED
    expect(isRetryableGrpcCode(8)).toBe(true); // RESOURCE_EXHAUSTED
    expect(isRetryableGrpcCode(7)).toBe(false); // PERMISSION_DENIED
    expect(isRetryableGrpcCode(3)).toBe(false); // INVALID_ARGUMENT
  });

  it("keeps callStream retries from overtaking queued streams at concurrency limit 1", async () => {
    let activeStreams = 0;
    let maxActiveStreams = 0;
    const streams: Array<FakeStream<string>> = [];
    const client = new ThetaMddsClient({
      THETADATA_MDDS_MAX_ATTEMPTS: "2",
      THETADATA_MDDS_RETRY_BASE_MS: "1",
      THETADATA_MDDS_MAX_CONCURRENCY: "1",
    } as NodeJS.ProcessEnv) as unknown as ThetaMddsClient & TestableThetaMddsClient;
    client.concurrencyLimit = 1;
    client.stub = {
      testMethod: () => {
        activeStreams++;
        maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
        const stream = createFakeStream<string>();
        streams.push(stream);
        return stream;
      },
    };

    const first = client.callStream<string>("testMethod", {});
    await flushMicrotasks();
    const second = client.callStream<string>("testMethod", {});
    await flushMicrotasks();

    streams[0].emitError({ code: 14 });
    activeStreams--;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushMicrotasks();

    expect(streams).toHaveLength(2);
    streams[1].emitData("second");
    streams[1].emitEnd();
    activeStreams--;
    await flushMicrotasks();

    expect(streams).toHaveLength(3);
    streams[2].emitData("first-retry");
    streams[2].emitEnd();
    activeStreams--;

    await expect(first).resolves.toEqual(["first-retry"]);
    await expect(second).resolves.toEqual(["second"]);
    expect(maxActiveStreams).toBe(1);
  });

  it("lets queued streams run while a previous call is in retry backoff", async () => {
    const streams: Array<FakeStream<string>> = [];
    const client = new ThetaMddsClient({
      THETADATA_MDDS_MAX_ATTEMPTS: "2",
      THETADATA_MDDS_RETRY_BASE_MS: "50",
      THETADATA_MDDS_MAX_CONCURRENCY: "1",
    } as NodeJS.ProcessEnv) as unknown as ThetaMddsClient & TestableThetaMddsClient;
    client.concurrencyLimit = 1;
    client.stub = {
      testMethod: () => {
        const stream = createFakeStream<string>();
        streams.push(stream);
        return stream;
      },
    };

    const first = client.callStream<string>("testMethod", {});
    await flushMicrotasks();
    const second = client.callStream<string>("testMethod", {});
    await flushMicrotasks();

    streams[0].emitError({ code: 14 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushMicrotasks();

    expect(streams).toHaveLength(2);
    streams[1].finish("second");
    await expect(second).resolves.toEqual(["second"]);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await flushMicrotasks();
    expect(streams).toHaveLength(3);
    streams[2].finish("first-retry");
    await expect(first).resolves.toEqual(["first-retry"]);
  });

  it("does not retry on a stale stub after close runs during backoff", async () => {
    let methodCalls = 0;
    const streams: Array<FakeStream<string>> = [];
    const client = new ThetaMddsClient({
      THETADATA_MDDS_MAX_ATTEMPTS: "2",
      THETADATA_MDDS_RETRY_BASE_MS: "25",
    } as NodeJS.ProcessEnv) as unknown as ThetaMddsClient & TestableThetaMddsClient;
    client.stub = {
      close: () => undefined,
      testMethod: () => {
        methodCalls++;
        if (methodCalls > 1) throw new Error("stale stub invoked");
        const stream = createFakeStream<string>();
        streams.push(stream);
        return stream;
      },
    };

    const pending = client.callStream<string>("testMethod", {});
    await flushMicrotasks();
    streams[0].emitError({ code: 14 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    client.close();

    await expect(pending).rejects.toThrow("ThetaMddsClient is closed");
    expect(methodCalls).toBe(1);
  });

  it("preserves the generated grpc method receiver", async () => {
    const client = new ThetaMddsClient({
      THETADATA_MDDS_MAX_ATTEMPTS: "1",
    } as NodeJS.ProcessEnv) as unknown as ThetaMddsClient & TestableThetaMddsClient;
    client.stub = {
      boundValue: "bound-row",
      testMethod(this: { boundValue: string }) {
        const stream = createFakeStream<string>();
        setImmediate(() => stream.finish(this.boundValue));
        return stream;
      },
    };

    await expect(client.callStream<string>("testMethod", {})).resolves.toEqual(["bound-row"]);
  });

  it("shares one cold connect attempt across concurrent callStream calls", async () => {
    let authCount = 0;
    let grpcClientCount = 0;
    const fetchImpl = (async () => {
      authCount++;
      await flushMicrotasks();
      return new Response(
        JSON.stringify({
          sessionId: "session-abc",
          user: { optionsSubscription: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const loadGrpcPackage = async () => ({
      BetaEndpoints: {
        BetaThetaTerminal: class {
          constructor() {
            grpcClientCount++;
            return {
              testMethod: () => {
                const stream = createFakeStream<string>();
                setImmediate(() => stream.finish("row"));
                return stream;
              },
            };
          }
        },
      },
    });

    const client = new ThetaMddsClient(
      {
        THETADATA_EMAIL: "person@example.com",
        THETADATA_PASSWORD: "secret",
        THETADATA_MDDS_MAX_ATTEMPTS: "1",
      } as NodeJS.ProcessEnv,
      fetchImpl,
      loadGrpcPackage,
    );

    await expect(
      Promise.all([
        client.callStream<string>("testMethod", {}),
        client.callStream<string>("testMethod", {}),
      ]),
    ).resolves.toEqual([["row"], ["row"]]);
    expect(authCount).toBe(1);
    expect(grpcClientCount).toBe(1);
  });

  it("closes the generated client and clears connection state", async () => {
    let closeCount = 0;
    const client = new ThetaMddsClient() as unknown as ThetaMddsClient &
      TestableThetaMddsClient & { close(): void };
    client.sessionId = "session-abc";
    client.concurrencyLimit = 4;
    client.stub = {
      close: () => {
        closeCount++;
      },
      testMethod: () => createFakeStream<string>(),
    };

    client.close();

    expect(closeCount).toBe(1);
    expect(() => client.queryInfo()).toThrow("ThetaMddsClient is not connected");
  });

  it("rejects and closes a stale stub when close wins an in-flight connect race", async () => {
    const auth = deferred<Response>();
    let staleCloseCount = 0;
    const fetchImpl = (() => auth.promise) as typeof fetch;
    const loadGrpcPackage = async () => ({
      BetaEndpoints: {
        BetaThetaTerminal: class {
          constructor() {
            return {
              close: () => {
                staleCloseCount++;
              },
              testMethod: () => {
                const stream = createFakeStream<string>();
                setImmediate(() => stream.finish("late"));
                return stream;
              },
            };
          }
        },
      },
    });
    const client = new ThetaMddsClient(
      {
        THETADATA_EMAIL: "person@example.com",
        THETADATA_PASSWORD: "secret",
        THETADATA_MDDS_MAX_ATTEMPTS: "1",
      } as NodeJS.ProcessEnv,
      fetchImpl,
      loadGrpcPackage,
    ) as unknown as ThetaMddsClient & TestableThetaMddsClient;

    const pending = client.callStream<string>("testMethod", {});
    await flushMicrotasks();
    client.close();
    auth.resolve(
      new Response(
        JSON.stringify({
          sessionId: "session-abc",
          user: { optionsSubscription: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(pending).rejects.toThrow(
      "ThetaMddsClient connection was closed before it completed",
    );
    expect(staleCloseCount).toBe(1);
    expect(client.stub).toBeNull();
    expect(() => client.queryInfo()).toThrow("ThetaMddsClient is not connected");
  });

  it("throws an explicit error for missing stream methods", async () => {
    const client = new ThetaMddsClient({
      THETADATA_MDDS_MAX_ATTEMPTS: "1",
    } as NodeJS.ProcessEnv) as unknown as ThetaMddsClient & TestableThetaMddsClient;
    client.stub = {};

    await expect(client.callStream("missingMethod", {})).rejects.toThrow(
      "ThetaData MDDS method not found: missingMethod",
    );
  });
});
