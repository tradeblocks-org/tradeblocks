import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { InMemoryClientsStore } from './clients-store.ts';
import { AuthCodeStore } from './code-store.ts';
import { issueAccessToken, verifyAccessToken as verifyJwt } from './token.ts';
import { renderLoginPage } from './login-page.ts';
import type { AuthConfig } from './config.ts';

interface AuthorizationParams {
  state?: string;
  scopes?: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: URL;
}

interface LoginBody {
  username: string;
  password: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  client_id: string;
  scopes?: string;
  resource?: string;
}

type LoginResult = { redirectUrl: string } | { error: string };

export class TradeBlocksAuthProvider implements OAuthServerProvider {
  private _clientsStore: InMemoryClientsStore;
  private codeStore: AuthCodeStore;
  private config: AuthConfig;

  constructor(config: AuthConfig) {
    this.config = config;
    this._clientsStore = new InMemoryClientsStore();
    this.codeStore = new AuthCodeStore();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const html = renderLoginPage({
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      clientId: client.client_id,
      scopes: params.scopes || [],
      resource: params.resource?.toString(),
    });
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }

  handleLogin(body: LoginBody): LoginResult {
    if (!this.validateCredentials(body.username, body.password)) {
      return { error: 'Invalid username or password' };
    }

    const code = randomUUID();
    this.codeStore.store(code, {
      codeChallenge: body.code_challenge,
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      scopes: (body.scopes || '').split(' ').filter(Boolean),
      resource: body.resource ? new URL(body.resource) : undefined,
    });

    const targetUrl = new URL(body.redirect_uri);
    targetUrl.searchParams.set('code', code);
    if (body.state) {
      targetUrl.searchParams.set('state', body.state);
    }

    return { redirectUrl: targetUrl.toString() };
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const entry = this.codeStore.peek(authorizationCode);
    if (!entry) throw new Error('Invalid authorization code');
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const entry = this.codeStore.consume(authorizationCode);
    if (!entry) throw new Error('Invalid or expired authorization code');

    if (entry.clientId !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }

    const { access_token, expires_in } = await issueAccessToken({
      clientId: client.client_id,
      scopes: entry.scopes,
      secret: this.config.jwtSecret,
      expiry: this.config.jwtExpiry,
    });

    return {
      access_token,
      token_type: 'bearer',
      expires_in,
      scope: entry.scopes.join(' '),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    throw new Error('Refresh tokens are not supported');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      return await verifyJwt(token, this.config.jwtSecret);
    } catch {
      // MCP SDK requireBearerAuth checks `error instanceof InvalidTokenError`
      // to return 401. Generic errors fall through to 500.
      throw new InvalidTokenError('Invalid or expired access token');
    }
  }

  private validateCredentials(username: string, password: string): boolean {
    const salt = 'tradeblocks-auth';
    const hashA = scryptSync(username, salt, 32);
    const hashB = scryptSync(this.config.username, salt, 32);
    const hashC = scryptSync(password, salt, 32);
    const hashD = scryptSync(this.config.password, salt, 32);
    return timingSafeEqual(hashA, hashB) && timingSafeEqual(hashC, hashD);
  }
}
