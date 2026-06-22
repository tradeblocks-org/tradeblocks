/* eslint-disable @typescript-eslint/no-explicit-any */
import { TradeBlocksAuthProvider } from "../../../src/auth/provider.ts";
import type { AuthConfig } from "../../../src/auth/config.ts";

const TEST_CONFIG: AuthConfig = {
  username: "admin",
  password: "secret",
  jwtSecret: "test-secret-key-at-least-32-characters-long",
  jwtExpiry: "1h",
  noAuth: false,
};

describe("TradeBlocksAuthProvider", () => {
  let provider: TradeBlocksAuthProvider;

  beforeEach(() => {
    provider = new TradeBlocksAuthProvider(TEST_CONFIG);
  });

  describe("authorize", () => {
    it("sends HTML login page via res", async () => {
      let sentHtml = "";
      let headerName = "";
      let headerValue = "";
      const mockRes = {
        setHeader: (name: string, value: string) => {
          headerName = name;
          headerValue = value;
        },
        send: (html: string) => {
          sentHtml = html;
        },
      } as any;

      await provider.authorize(
        { client_id: "c1", redirect_uris: ["https://example.com/cb"] } as any,
        {
          state: "xyz",
          scopes: [],
          codeChallenge: "challenge123",
          redirectUri: "https://example.com/cb",
        },
        mockRes,
      );

      expect(headerName).toBe("Content-Type");
      expect(headerValue).toBe("text/html");
      expect(sentHtml).toContain("TradeBlocks");
      expect(sentHtml).toContain("challenge123");
    });
  });

  describe("handleLogin", () => {
    it("returns redirect URL on valid credentials", () => {
      const result = provider.handleLogin({
        username: "admin",
        password: "secret",
        redirect_uri: "https://example.com/cb",
        state: "xyz",
        code_challenge: "challenge123",
        client_id: "c1",
      });
      expect("redirectUrl" in result).toBe(true);
      if ("redirectUrl" in result) {
        const url = new URL(result.redirectUrl);
        expect(url.origin).toBe("https://example.com");
        expect(url.searchParams.get("code")).toBeDefined();
        expect(url.searchParams.get("state")).toBe("xyz");
      }
    });

    it("returns error on invalid credentials", () => {
      const result = provider.handleLogin({
        username: "admin",
        password: "wrong",
        redirect_uri: "https://example.com/cb",
        code_challenge: "c",
        client_id: "c1",
      });
      expect("error" in result).toBe(true);
    });
  });

  describe("challengeForAuthorizationCode", () => {
    it("returns the stored challenge for a valid code", async () => {
      const result = provider.handleLogin({
        username: "admin",
        password: "secret",
        redirect_uri: "https://example.com/cb",
        code_challenge: "my-challenge",
        client_id: "c1",
      });
      expect("redirectUrl" in result).toBe(true);
      if (!("redirectUrl" in result)) return;

      const url = new URL(result.redirectUrl);
      const code = url.searchParams.get("code")!;

      const challenge = await provider.challengeForAuthorizationCode(
        { client_id: "c1" } as any,
        code,
      );
      expect(challenge).toBe("my-challenge");
    });

    it("throws for invalid code", async () => {
      await expect(
        provider.challengeForAuthorizationCode({ client_id: "c1" } as any, "bad-code"),
      ).rejects.toThrow();
    });
  });

  describe("exchangeAuthorizationCode", () => {
    it("returns JWT tokens for valid code and matching client", async () => {
      const result = provider.handleLogin({
        username: "admin",
        password: "secret",
        redirect_uri: "https://example.com/cb",
        code_challenge: "my-challenge",
        client_id: "c1",
      });
      if (!("redirectUrl" in result)) throw new Error("Expected redirect");

      const url = new URL(result.redirectUrl);
      const code = url.searchParams.get("code")!;

      const tokens = await provider.exchangeAuthorizationCode({ client_id: "c1" } as any, code);
      expect(tokens.access_token).toMatch(/^eyJ/);
      expect(tokens.token_type).toBe("bearer");
      expect(tokens.expires_in).toBe(3600);
    });

    it("rejects code issued to different client", async () => {
      const result = provider.handleLogin({
        username: "admin",
        password: "secret",
        redirect_uri: "https://example.com/cb",
        code_challenge: "c",
        client_id: "c1",
      });
      if (!("redirectUrl" in result)) throw new Error("Expected redirect");

      const url = new URL(result.redirectUrl);
      const code = url.searchParams.get("code")!;

      await expect(
        provider.exchangeAuthorizationCode({ client_id: "c2" } as any, code),
      ).rejects.toThrow("not issued to this client");
    });
  });

  describe("verifyAccessToken", () => {
    it("verifies a token issued by this provider", async () => {
      const result = provider.handleLogin({
        username: "admin",
        password: "secret",
        redirect_uri: "https://example.com/cb",
        code_challenge: "c",
        client_id: "c1",
      });
      if (!("redirectUrl" in result)) throw new Error("Expected redirect");

      const url = new URL(result.redirectUrl);
      const code = url.searchParams.get("code")!;

      const tokens = await provider.exchangeAuthorizationCode({ client_id: "c1" } as any, code);

      const authInfo = await provider.verifyAccessToken(tokens.access_token);
      expect(authInfo.clientId).toBe("c1");
    });
  });
});
