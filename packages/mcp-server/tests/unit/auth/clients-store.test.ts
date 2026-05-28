import { InMemoryClientsStore } from '../../../src/auth/clients-store.ts';

describe('InMemoryClientsStore', () => {
  it('returns undefined for unknown client', async () => {
    const store = new InMemoryClientsStore();
    expect(await store.getClient('nope')).toBeUndefined();
  });

  it('registers a client and retrieves it', async () => {
    const store = new InMemoryClientsStore();
    const registered = await store.registerClient({
      redirect_uris: ['https://example.com/callback'],
      client_name: 'Test Client',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });

    expect(registered.client_id).toBeDefined();
    expect(registered.client_name).toBe('Test Client');

    const retrieved = await store.getClient(registered.client_id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.client_id).toBe(registered.client_id);
  });

  it('generates unique client IDs', async () => {
    const store = new InMemoryClientsStore();
    const a = await store.registerClient({ redirect_uris: ['https://a.com/cb'] });
    const b = await store.registerClient({ redirect_uris: ['https://b.com/cb'] });
    expect(a.client_id).not.toBe(b.client_id);
  });
});
