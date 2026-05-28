import { AuthCodeStore } from '../../../src/auth/code-store.ts';

describe('AuthCodeStore', () => {
  it('stores and retrieves a code via peek', () => {
    const store = new AuthCodeStore();
    store.store('abc', {
      codeChallenge: 'challenge123',
      clientId: 'client1',
      redirectUri: 'https://example.com/callback',
      scopes: ['mcp:tools'],
    });
    const entry = store.peek('abc');
    expect(entry).toBeDefined();
    expect(entry!.codeChallenge).toBe('challenge123');
    expect(entry!.clientId).toBe('client1');
  });

  it('peek does not consume the code', () => {
    const store = new AuthCodeStore();
    store.store('abc', {
      codeChallenge: 'c',
      clientId: 'x',
      redirectUri: 'https://example.com/cb',
      scopes: [],
    });
    store.peek('abc');
    expect(store.peek('abc')).toBeDefined();
  });

  it('consume returns and deletes the code', () => {
    const store = new AuthCodeStore();
    store.store('abc', {
      codeChallenge: 'c',
      clientId: 'x',
      redirectUri: 'https://example.com/cb',
      scopes: [],
    });
    const entry = store.consume('abc');
    expect(entry).toBeDefined();
    expect(store.consume('abc')).toBeUndefined();
  });

  it('returns undefined for unknown code', () => {
    const store = new AuthCodeStore();
    expect(store.peek('nope')).toBeUndefined();
    expect(store.consume('nope')).toBeUndefined();
  });

  it('returns undefined for expired code', () => {
    const store = new AuthCodeStore(1); // 1ms TTL
    store.store('abc', {
      codeChallenge: 'c',
      clientId: 'x',
      redirectUri: 'https://example.com/cb',
      scopes: [],
    });
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    expect(store.peek('abc')).toBeUndefined();
    expect(store.consume('abc')).toBeUndefined();
  });
});
