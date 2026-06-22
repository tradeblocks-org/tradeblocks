import { SignJWT, jwtVerify } from "jose";

// AuthInfo matches the MCP SDK's expected shape
export interface AuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
}

export async function issueAccessToken(params: {
  clientId: string;
  scopes: string[];
  secret: string;
  expiry: string;
}): Promise<{ access_token: string; expires_in: number }> {
  const secretKey = new TextEncoder().encode(params.secret);
  const expirySeconds = parseExpiry(params.expiry);

  const jwt = await new SignJWT({
    client_id: params.clientId,
    scope: params.scopes.join(" "),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("tradeblocks-user")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expirySeconds)
    .sign(secretKey);

  return { access_token: jwt, expires_in: expirySeconds };
}

export async function verifyAccessToken(token: string, secret: string): Promise<AuthInfo> {
  const secretKey = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, secretKey);

  return {
    token,
    clientId: (payload.client_id as string) || "",
    scopes: ((payload.scope as string) || "").split(" ").filter(Boolean),
    expiresAt: payload.exp,
  };
}

export function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 86400;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return n;
    case "m":
      return n * 60;
    case "h":
      return n * 3600;
    case "d":
      return n * 86400;
    default:
      return 86400;
  }
}
