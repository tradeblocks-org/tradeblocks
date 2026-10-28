import { describe, expect, it } from "@jest/globals";
import {
  ThetaMddsClient,
  isRetryableGrpcCode,
} from "../../../../src/utils/providers/thetadata/client.ts";
import { stockHistoryOhlc } from "../../../../src/utils/providers/thetadata/endpoints.ts";

function fixture(mode: "recover" | "reject" | "auth-fails" | "close" = "recover") {
  let authCount = 0;
  const sessions: string[] = [];
  const fetchImpl = (async () => {
    authCount++;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
    if (authCount === 2 && mode === "close") client.close();
    return new Response(
      JSON.stringify({ sessionId: `session-${authCount}`, user: { optionsSubscription: 3 } }),
      {
        status: authCount === 2 && mode === "auth-fails" ? 401 : 200,
      },
    );
  }) as typeof fetch;
  const client = new ThetaMddsClient(
    {
      THETADATA_EMAIL: "test@example.com",
      THETADATA_PASSWORD: "fixture-password",
      THETADATA_MDDS_MAX_ATTEMPTS: "1",
      THETADATA_MDDS_MAX_CONCURRENCY: "3",
    },
    fetchImpl,
    async () => ({
      BetaEndpoints: {
        BetaThetaTerminal: class {
          GetStockHistoryOhlc(request: { queryInfo: { authToken: { sessionUuid: string } } }) {
            const session = request.queryInfo.authToken.sessionUuid;
            sessions.push(session);
            const listeners = new Map<string, (error?: unknown) => void>();
            setImmediate(() => {
              if (session === "session-1" || mode === "reject") {
                listeners.get("error")?.(
                  Object.assign(new Error("16 UNAUTHENTICATED: session invalid"), {
                    code: 16,
                    details: "session invalid",
                  }),
                );
              } else listeners.get("end")?.();
            });
            return {
              on(event: string, listener: (error?: unknown) => void) {
                listeners.set(event, listener);
              },
            };
          }
          close() {}
        },
      },
    }),
  );
  const request = () =>
    stockHistoryOhlc(client, {
      symbol: "SPY",
      startDate: "2025-07-07",
      endDate: "2025-07-07",
      interval: "1m",
    });
  return { client, request, sessions, authCount: () => authCount };
}

describe("ThetaData session recovery through an exported endpoint", () => {
  it("re-authenticates once and rebuilds the endpoint request with the new session", async () => {
    const f = fixture();
    try {
      await f.client.connect();
      await expect(f.request()).resolves.toEqual([]);
      expect(f.authCount()).toBe(2);
      expect(f.sessions).toEqual(["session-1", "session-2"]);
      expect(isRetryableGrpcCode(16)).toBe(false);
    } finally {
      f.client.close();
    }
  });

  it("shares one re-authentication across concurrent invalidated streams", async () => {
    const f = fixture();
    try {
      await f.client.connect();
      await expect(Promise.all([f.request(), f.request(), f.request()])).resolves.toEqual([
        [],
        [],
        [],
      ]);
      expect(f.authCount()).toBe(2);
      expect(f.sessions).toEqual([
        "session-1",
        "session-1",
        "session-1",
        "session-2",
        "session-2",
        "session-2",
      ]);
    } finally {
      f.client.close();
    }
  });

  it.each(["reject", "auth-fails"] as const)(
    "preserves gRPC details with the single-session remedy after %s",
    async (mode) => {
      const f = fixture(mode);
      try {
        await f.client.connect();
        const error = await f.request().catch((error: unknown) => error);
        expect(error).toMatchObject({ code: 16, details: "session invalid" });
        expect((error as Error).message).toMatch(
          /16 UNAUTHENTICATED.*another ThetaData terminal or client.*one active session.*Close the other client, then retry/i,
        );
        expect(f.authCount()).toBe(2);
        expect(f.sessions).toHaveLength(mode === "reject" ? 2 : 1);
      } finally {
        f.client.close();
      }
    },
  );

  it("gives a later request its own login after a failed re-authentication", async () => {
    const f = fixture("auth-fails");
    try {
      await f.client.connect();
      await expect(f.request()).rejects.toMatchObject({ code: 16 });
      await expect(f.request()).resolves.toEqual([]);
      expect(f.authCount()).toBe(3);
      expect(f.sessions).toEqual(["session-1", "session-1", "session-3"]);
    } finally {
      f.client.close();
    }
  });

  it("does not resurrect a connection closed during re-authentication", async () => {
    const f = fixture("close");
    await f.client.connect();
    await expect(f.request()).rejects.toThrow("ThetaMddsClient is closed");
    expect(f.sessions).toEqual(["session-1"]);
    expect(() => f.client.queryInfo()).toThrow("not connected");
  });
});
