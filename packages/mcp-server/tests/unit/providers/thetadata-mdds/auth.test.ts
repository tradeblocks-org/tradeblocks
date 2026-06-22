import { describe, expect, it, jest } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  authenticateThetaData,
  resolveThetaCredentials,
  thetaConcurrencyForTier,
} from "../../../../src/utils/providers/thetadata/auth.ts";

describe("ThetaData MDDS auth", () => {
  it("prefers THETADATA_EMAIL and THETADATA_PASSWORD", () => {
    const creds = resolveThetaCredentials({
      THETADATA_EMAIL: "env@example.com",
      THETADATA_PASSWORD: "env-pass",
      THETADATA_CREDENTIALS_FILE: "/not/read",
    } as NodeJS.ProcessEnv);
    expect(creds).toEqual({ email: "env@example.com", password: "env-pass", source: "env" });
  });

  it("reads explicit THETADATA_CREDENTIALS_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "theta-creds-"));
    try {
      const file = join(dir, "creds.txt");
      writeFileSync(file, "file@example.com\nfile-pass\n", "utf8");
      const creds = resolveThetaCredentials({
        THETADATA_CREDENTIALS_FILE: file,
      } as NodeJS.ProcessEnv);
      expect(creds).toEqual({ email: "file@example.com", password: "file-pass", source: file });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a safe error when credentials are missing", () => {
    expect(() => resolveThetaCredentials({} as NodeJS.ProcessEnv)).toThrow(
      "ThetaData credentials missing",
    );
  });

  it("maps subscription tier to conservative concurrency", () => {
    expect(thetaConcurrencyForTier(undefined)).toBe(1);
    expect(thetaConcurrencyForTier(0)).toBe(1);
    expect(thetaConcurrencyForTier(1)).toBe(2);
    expect(thetaConcurrencyForTier(2)).toBe(4);
    expect(thetaConcurrencyForTier(3)).toBe(8);
  });

  it("authenticates through Nexus without leaking credentials in errors", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          sessionId: "session-123",
          user: { stockSubscription: 1, optionsSubscription: 2, indicesSubscription: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await authenticateThetaData(
      { email: "person@example.com", password: "secret", source: "env" },
      fetchMock,
    );

    expect(result.sessionId).toBe("session-123");
    expect(result.optionsSubscription).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://nexus-api.thetadata.us/identity/terminal/auth_user",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "TD-TERMINAL-KEY": "cf58ada4-4175-11f0-860f-1e2e95c79e64",
        }),
      }),
    );
  });

  it("does not leak echoed credentials or session-like values on failed auth", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Invalid credentials for person@example.com with password secret",
          sessionId: "550e8400-e29b-41d4-a716-446655440000",
        }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    let error: unknown;
    try {
      await authenticateThetaData(
        { email: "person@example.com", password: "secret", source: "env" },
        fetchMock,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toBe("ThetaData authentication failed (401 Unauthorized)");
    expect(message).not.toMatch(/person@example\.com|secret|550e8400-e29b-41d4-a716-446655440000/);
  });

  it.each([
    ["missing", {}],
    ["blank", { sessionId: " " }],
    ["non-string", { sessionId: 123 }],
  ])("rejects %s sessionId values", async (_label, body) => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      authenticateThetaData(
        { email: "person@example.com", password: "secret", source: "env" },
        fetchMock,
      ),
    ).rejects.toThrow("ThetaData authentication response missing sessionId");
  });

  it("ignores absent or non-integer subscription fields", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          sessionId: "session-123",
          user: { stockSubscription: 1.5, optionsSubscription: "2", indicesSubscription: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await authenticateThetaData(
      { email: "person@example.com", password: "secret", source: "env" },
      fetchMock,
    );

    expect(result).toEqual({
      sessionId: "session-123",
      stockSubscription: undefined,
      optionsSubscription: undefined,
      indicesSubscription: 3,
    });
  });
});
