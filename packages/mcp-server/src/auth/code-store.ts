export interface CodeEntry {
  codeChallenge: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  resource?: URL;
  expiresAt: number;
}

type StoreInput = Omit<CodeEntry, "expiresAt">;

export class AuthCodeStore {
  private codes = new Map<string, CodeEntry>();
  private ttlMs: number;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  store(code: string, entry: StoreInput): void {
    this.codes.set(code, { ...entry, expiresAt: Date.now() + this.ttlMs });
  }

  peek(code: string): CodeEntry | undefined {
    const entry = this.codes.get(code);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.codes.delete(code);
      return undefined;
    }
    return entry;
  }

  consume(code: string): CodeEntry | undefined {
    const entry = this.peek(code);
    if (!entry) return undefined;
    this.codes.delete(code);
    return entry;
  }
}
