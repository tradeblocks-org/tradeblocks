import { issueAccessToken, verifyAccessToken } from '../../../src/auth/token.ts';

const TEST_SECRET = 'test-secret-key-at-least-32-chars-long';

describe('issueAccessToken', () => {
  it('returns a JWT string and expiry', async () => {
    const result = await issueAccessToken({
      clientId: 'client1',
      scopes: ['mcp:tools'],
      secret: TEST_SECRET,
      expiry: '1h',
    });
    expect(result.access_token).toMatch(/^eyJ/);
    expect(result.expires_in).toBe(3600);
  });

  it('defaults to 24h when expiry format is invalid', async () => {
    const result = await issueAccessToken({
      clientId: 'client1',
      scopes: [],
      secret: TEST_SECRET,
      expiry: 'invalid',
    });
    expect(result.expires_in).toBe(86400);
  });
});

describe('verifyAccessToken', () => {
  it('verifies a valid token and returns AuthInfo', async () => {
    const { access_token } = await issueAccessToken({
      clientId: 'client1',
      scopes: ['mcp:tools'],
      secret: TEST_SECRET,
      expiry: '1h',
    });
    const info = await verifyAccessToken(access_token, TEST_SECRET);
    expect(info.clientId).toBe('client1');
    expect(info.scopes).toEqual(['mcp:tools']);
    expect(info.token).toBe(access_token);
    expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects a token signed with wrong secret', async () => {
    const { access_token } = await issueAccessToken({
      clientId: 'client1',
      scopes: [],
      secret: TEST_SECRET,
      expiry: '1h',
    });
    await expect(
      verifyAccessToken(access_token, 'wrong-secret-that-is-also-long-enough')
    ).rejects.toThrow();
  });

  it('rejects a malformed token', async () => {
    await expect(
      verifyAccessToken('not.a.jwt', TEST_SECRET)
    ).rejects.toThrow();
  });
});

describe('parseExpiry', () => {
  it('handles seconds, minutes, hours, days', async () => {
    const cases = [
      { expiry: '30s', expected: 30 },
      { expiry: '15m', expected: 900 },
      { expiry: '2h', expected: 7200 },
      { expiry: '7d', expected: 604800 },
    ];
    for (const { expiry, expected } of cases) {
      const result = await issueAccessToken({
        clientId: 'c', scopes: [], secret: TEST_SECRET, expiry,
      });
      expect(result.expires_in).toBe(expected);
    }
  });
});
