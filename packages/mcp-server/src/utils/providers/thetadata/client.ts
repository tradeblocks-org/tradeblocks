import * as grpc from "@grpc/grpc-js";
import { authenticateThetaData, resolveThetaCredentials, thetaConcurrencyForTier } from "./auth.ts";

export interface ThetaMddsConfig {
  target: string;
  maxAttempts: number;
  retryBaseMs: number;
  maxConcurrency?: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function getThetaMddsConfig(env: NodeJS.ProcessEnv = process.env): ThetaMddsConfig {
  const host = env.THETADATA_MDDS_HOST || "mdds-01.thetadata.us";
  const port = env.THETADATA_MDDS_PORT || "443";
  return {
    target: `${host}:${port}`,
    maxAttempts: positiveInteger(env.THETADATA_MDDS_MAX_ATTEMPTS, 4),
    retryBaseMs: positiveInteger(env.THETADATA_MDDS_RETRY_BASE_MS, 250),
    maxConcurrency: optionalPositiveInteger(env.THETADATA_MDDS_MAX_CONCURRENCY),
  };
}

export function buildThetaQueryInfo(sessionId: string, env: NodeJS.ProcessEnv = process.env) {
  const clientType = env.THETADATA_MDDS_CLIENT_TYPE || "terminal";
  return {
    authToken: { sessionUuid: sessionId },
    queryParameters: { client: "terminal" },
    clientType,
    terminalGitCommit: "",
    terminalVersion: "tradeblocks-mdds",
  };
}

export function isRetryableGrpcCode(code: number | undefined): boolean {
  return (
    code === grpc.status.UNAVAILABLE ||
    code === grpc.status.DEADLINE_EXCEEDED ||
    code === grpc.status.RESOURCE_EXHAUSTED
  );
}

interface MddsStreamCall<T = unknown> {
  on(event: "data", listener: (chunk: T) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

type MddsStreamMethod = (this: MddsClientStub, request: unknown) => MddsStreamCall;
interface MddsClientStub {
  [method: string]: MddsStreamMethod | (() => void) | undefined;
  close?: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ThetaMddsClient {
  private sessionId: string | null = null;
  private stub: MddsClientStub | null = null;
  private connectPromise: Promise<void> | null = null;
  private reauthPromise: Promise<void> | null = null;
  private reauthSession: string | null = null;
  private connectionGeneration = 0;
  private concurrencyLimit = 1;
  private inFlight = 0;
  private waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly loadGrpcPackage: () => Promise<unknown>;
  constructor(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl: typeof fetch = fetch,
    loadGrpcPackage: () => Promise<unknown> = async () => {
      const { loadMddsGrpcPackage } = await import("./proto.ts");
      return loadMddsGrpcPackage();
    },
  ) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.loadGrpcPackage = loadGrpcPackage;
  }

  async connect(): Promise<void> {
    if (this.stub) return;
    if (!this.connectPromise) {
      const generation = this.connectionGeneration;
      const promise = this.establishConnection(generation).catch((error: unknown) => {
        if (this.connectPromise === promise) this.connectPromise = null;
        throw error;
      });
      this.connectPromise = promise;
    }
    await this.connectPromise;
  }

  private async establishConnection(generation: number): Promise<void> {
    const credentials = resolveThetaCredentials(this.env);
    const auth = await authenticateThetaData(credentials, this.fetchImpl);
    const config = getThetaMddsConfig(this.env);
    const pkg = (await this.loadGrpcPackage()) as {
      BetaEndpoints?: {
        BetaThetaTerminal?: new (
          target: string,
          creds: grpc.ChannelCredentials,
          options?: grpc.ChannelOptions,
        ) => MddsClientStub;
      };
    };
    const Ctor = pkg.BetaEndpoints?.BetaThetaTerminal;
    if (!Ctor) throw new Error("ThetaData MDDS proto missing BetaEndpoints.BetaThetaTerminal");
    const stub = new Ctor(config.target, grpc.credentials.createSsl(), {
      "grpc.max_receive_message_length": 256 * 1024 * 1024,
      "grpc.keepalive_time_ms": 30_000,
    });
    if (generation !== this.connectionGeneration) {
      stub.close?.();
      throw new Error("ThetaMddsClient connection was closed before it completed");
    }
    this.sessionId = auth.sessionId;
    this.concurrencyLimit =
      config.maxConcurrency ?? thetaConcurrencyForTier(auth.optionsSubscription);
    this.stub = stub;
  }

  close(): void {
    this.connectionGeneration++;
    this.stub?.close?.();
    this.stub = null;
    this.sessionId = null;
    this.connectPromise = null;
    this.reauthPromise = null;
    this.reauthSession = null;
    this.inFlight = 0;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(new Error("ThetaMddsClient is closed"));
    }
  }

  queryInfo(): ReturnType<typeof buildThetaQueryInfo> {
    if (!this.sessionId) throw new Error("ThetaMddsClient is not connected");
    return buildThetaQueryInfo(this.sessionId, this.env);
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.concurrencyLimit) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  private assertOpen(generation: number): void {
    if (generation !== this.connectionGeneration || !this.stub) {
      throw new Error("ThetaMddsClient is closed");
    }
  }

  private getStreamMethod(stub: MddsClientStub, method: string): MddsStreamMethod {
    const candidate = method === "close" ? undefined : stub[method];
    if (typeof candidate !== "function") {
      throw new Error(`ThetaData MDDS method not found: ${method}`);
    }
    return candidate as MddsStreamMethod;
  }

  private async reauthenticate(session: string | null, generation: number): Promise<void> {
    this.assertOpen(generation);
    if (this.sessionId !== session) return;
    if (!this.reauthPromise || this.reauthSession !== session) {
      this.reauthSession = session;
      const promise = (async () => {
        const auth = await authenticateThetaData(resolveThetaCredentials(this.env), this.fetchImpl);
        this.assertOpen(generation);
        this.sessionId = auth.sessionId;
      })();
      // A failed login is shared by the requests waiting on it, but must not be
      // cached: a later request gets its own attempt instead of the old rejection.
      promise.catch(() => {
        if (this.reauthPromise === promise) {
          this.reauthPromise = null;
          this.reauthSession = null;
        }
      });
      this.reauthPromise = promise;
    }
    await this.reauthPromise;
    this.assertOpen(generation);
  }

  private sessionError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return Object.assign(
      new Error(message, { cause: error }),
      typeof error === "object" && error !== null ? error : {},
      {
        message: `${message}. Another ThetaData terminal or client may be logged in with the same account; ThetaData allows one active session per account. Close the other client, then retry.`,
      },
    );
  }

  async callStream<T>(method: string, request: unknown): Promise<T[]> {
    if (!this.stub) await this.connect();
    const callGeneration = this.connectionGeneration;
    const config = getThetaMddsConfig(this.env);
    let lastError: unknown;
    let reauthenticated = false;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      this.assertOpen(callGeneration);
      await this.acquire();
      let releasePermit = true;
      let requestSession = this.sessionId;
      try {
        this.assertOpen(callGeneration);
        const stub = this.stub!;
        const streamMethod = this.getStreamMethod(stub, method);
        requestSession = this.sessionId;
        const currentRequest =
          typeof request === "object" && request !== null && "queryInfo" in request
            ? { ...request, queryInfo: this.queryInfo() }
            : request;
        const call = streamMethod.call(stub, currentRequest) as MddsStreamCall<T>;
        return await new Promise<T[]>((resolve, reject) => {
          const rows: T[] = [];
          call.on("data", (chunk: T) => rows.push(chunk));
          call.on("error", reject);
          call.on("end", () => resolve(rows));
        });
      } catch (error) {
        lastError = error;
        const code =
          typeof error === "object" && error && "code" in error
            ? Number((error as { code: unknown }).code)
            : undefined;
        if (code === grpc.status.UNAUTHENTICATED) {
          if (reauthenticated) throw this.sessionError(error);
          reauthenticated = true;
          this.release();
          releasePermit = false;
          try {
            await this.reauthenticate(requestSession, callGeneration);
          } catch {
            this.assertOpen(callGeneration);
            throw this.sessionError(error);
          }
          attempt--;
          continue;
        }
        if (!isRetryableGrpcCode(code) || attempt === config.maxAttempts) throw error;
        this.release();
        releasePermit = false;
        await sleep(config.retryBaseMs * attempt);
        this.assertOpen(callGeneration);
      } finally {
        if (releasePermit) this.release();
      }
    }
    throw lastError;
  }
}
