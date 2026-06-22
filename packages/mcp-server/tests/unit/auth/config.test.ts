import { loadAuthConfig } from "../../../src/auth/config.ts";

describe("loadAuthConfig", () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIG_ENV };
    process.env.TRADEBLOCKS_USERNAME = "admin";
    process.env.TRADEBLOCKS_PASSWORD = "secret";
    process.env.TRADEBLOCKS_JWT_SECRET = "test-secret-key";
  });

  afterEach(() => {
    process.env = ORIG_ENV;
  });

  it("loads valid config from env vars", () => {
    const config = loadAuthConfig();
    expect(config.username).toBe("admin");
    expect(config.password).toBe("secret");
    expect(config.jwtSecret).toBe("test-secret-key");
    expect(config.jwtExpiry).toBe("24h");
    expect(config.noAuth).toBe(false);
  });

  it("uses custom JWT expiry when set", () => {
    process.env.TRADEBLOCKS_JWT_EXPIRY = "7d";
    const config = loadAuthConfig();
    expect(config.jwtExpiry).toBe("7d");
  });

  it("uses custom issuer URL when set", () => {
    process.env.TRADEBLOCKS_ISSUER_URL = "https://mcp.example.com";
    const config = loadAuthConfig();
    expect(config.issuerUrl).toBe("https://mcp.example.com");
  });

  it("throws when username is missing", () => {
    delete process.env.TRADEBLOCKS_USERNAME;
    expect(() => loadAuthConfig()).toThrow("TRADEBLOCKS_USERNAME");
  });

  it("throws when password is missing", () => {
    delete process.env.TRADEBLOCKS_PASSWORD;
    expect(() => loadAuthConfig()).toThrow("TRADEBLOCKS_PASSWORD");
  });

  it("throws when JWT secret is missing", () => {
    delete process.env.TRADEBLOCKS_JWT_SECRET;
    expect(() => loadAuthConfig()).toThrow("TRADEBLOCKS_JWT_SECRET");
  });

  it("returns noAuth config when noAuth option is true", () => {
    delete process.env.TRADEBLOCKS_USERNAME;
    delete process.env.TRADEBLOCKS_PASSWORD;
    delete process.env.TRADEBLOCKS_JWT_SECRET;
    const config = loadAuthConfig({ noAuth: true });
    expect(config.noAuth).toBe(true);
    expect(config.username).toBe("");
  });

  it("returns noAuth config when TRADEBLOCKS_NO_AUTH env is true", () => {
    delete process.env.TRADEBLOCKS_USERNAME;
    delete process.env.TRADEBLOCKS_PASSWORD;
    delete process.env.TRADEBLOCKS_JWT_SECRET;
    process.env.TRADEBLOCKS_NO_AUTH = "true";
    const config = loadAuthConfig();
    expect(config.noAuth).toBe(true);
  });
});
