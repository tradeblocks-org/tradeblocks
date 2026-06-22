export interface AuthConfig {
  username: string;
  password: string;
  jwtSecret: string;
  jwtExpiry: string;
  issuerUrl?: string;
  noAuth: boolean;
}

export function loadAuthConfig(options: { noAuth?: boolean } = {}): AuthConfig {
  const noAuth = options.noAuth || process.env.TRADEBLOCKS_NO_AUTH === "true";

  if (noAuth) {
    return {
      username: "",
      password: "",
      jwtSecret: "",
      jwtExpiry: "24h",
      noAuth: true,
    };
  }

  const username = process.env.TRADEBLOCKS_USERNAME;
  const password = process.env.TRADEBLOCKS_PASSWORD;
  const jwtSecret = process.env.TRADEBLOCKS_JWT_SECRET;
  const jwtExpiry = process.env.TRADEBLOCKS_JWT_EXPIRY || "24h";
  const issuerUrl = process.env.TRADEBLOCKS_ISSUER_URL;

  if (!username) {
    throw new Error(
      "TRADEBLOCKS_USERNAME is required for HTTP mode.\n" +
        "Set it in your .env file or pass --no-auth to disable authentication.",
    );
  }
  if (!password) {
    throw new Error(
      "TRADEBLOCKS_PASSWORD is required for HTTP mode.\n" + "Set it in your .env file.",
    );
  }
  if (!jwtSecret) {
    throw new Error(
      "TRADEBLOCKS_JWT_SECRET is required for HTTP mode.\n" +
        "Generate one with: openssl rand -hex 32",
    );
  }

  return { username, password, jwtSecret, jwtExpiry, issuerUrl, noAuth: false };
}
