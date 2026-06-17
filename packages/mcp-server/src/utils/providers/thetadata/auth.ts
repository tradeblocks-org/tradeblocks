import { readFileSync } from "fs";

export interface ThetaCredentials {
  email: string;
  password: string;
  source: string;
}

export interface ThetaAuthResult {
  sessionId: string;
  stockSubscription?: number;
  optionsSubscription?: number;
  indicesSubscription?: number;
}

const TERMINAL_KEY = "cf58ada4-4175-11f0-860f-1e2e95c79e64";
const AUTH_URL = "https://nexus-api.thetadata.us/identity/terminal/auth_user";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveThetaCredentials(env: NodeJS.ProcessEnv = process.env): ThetaCredentials {
  const email = nonEmpty(env.THETADATA_EMAIL);
  const password = nonEmpty(env.THETADATA_PASSWORD);
  if (email && password) return { email, password, source: "env" };

  const filePath = nonEmpty(env.THETADATA_CREDENTIALS_FILE);
  if (filePath) {
    const [fileEmail, filePassword] = readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (fileEmail && filePassword) {
      return { email: fileEmail, password: filePassword, source: filePath };
    }
    throw new Error(`ThetaData credentials file is missing email or password: ${filePath}`);
  }

  throw new Error(
    "ThetaData credentials missing. Set THETADATA_EMAIL and THETADATA_PASSWORD, or THETADATA_CREDENTIALS_FILE.",
  );
}

export function thetaConcurrencyForTier(tier: number | undefined): number {
  if (!Number.isInteger(tier) || tier == null || tier < 0) return 1;
  return Math.max(1, 2 ** tier);
}

function statusLabel(response: Response): string {
  const statusText = nonEmpty(response.statusText);
  return statusText ? `${response.status} ${statusText}` : String(response.status);
}

function integerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export async function authenticateThetaData(
  credentials: ThetaCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<ThetaAuthResult> {
  const response = await fetchImpl(AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "TD-TERMINAL-KEY": TERMINAL_KEY,
    },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
    }),
  });

  if (!response.ok) {
    throw new Error(`ThetaData authentication failed (${statusLabel(response)})`);
  }

  const parsed = JSON.parse(await response.text()) as {
    sessionId?: unknown;
    user?: {
      stockSubscription?: unknown;
      optionsSubscription?: unknown;
      indicesSubscription?: unknown;
    };
  };
  const sessionId = typeof parsed.sessionId === "string" ? nonEmpty(parsed.sessionId) : undefined;
  if (!sessionId) throw new Error("ThetaData authentication response missing sessionId");
  return {
    sessionId,
    stockSubscription: integerOrUndefined(parsed.user?.stockSubscription),
    optionsSubscription: integerOrUndefined(parsed.user?.optionsSubscription),
    indicesSubscription: integerOrUndefined(parsed.user?.indicesSubscription),
  };
}
