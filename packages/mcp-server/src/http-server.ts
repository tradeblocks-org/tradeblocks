/**
 * HTTP Server for MCP
 *
 * Provides HTTP transport for web platforms (ChatGPT, Google AI Studio, Julius, Claude.ai)
 * that cannot connect to stdio-based MCP servers.
 *
 * When auth is configured, adds OAuth 2.1 Authorization Code + PKCE flow:
 * - /.well-known/oauth-authorization-server (discovery)
 * - /authorize, /token, /register (via MCP SDK auth router)
 * - /login (custom credential form handler)
 * - Bearer token validation on /mcp endpoints
 */

import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type Request, type Response, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import type { AuthConfig } from "./auth/config.ts";
import { TradeBlocksAuthProvider } from "./auth/provider.ts";
import { renderLoginPage } from "./auth/login-page.ts";

export interface HttpServerOptions {
  port: number;
  host?: string;
  auth?: AuthConfig;
}

/** Factory function type for creating configured MCP servers */
export type ServerFactory = () => McpServer;

/**
 * Creates and starts an HTTP server for MCP with optional OAuth authentication.
 */
export async function startHttpServer(
  serverFactory: ServerFactory,
  options: HttpServerOptions
): Promise<Server> {
  const { port, host = "0.0.0.0", auth } = options;

  const app: Express = express();
  app.set("trust proxy", 1);
  app.use(express.json());

  // Auth middleware array - empty when auth is disabled
  let mcpAuthMiddleware: RequestHandler[] = [];

  if (auth && !auth.noAuth) {
    // SDK auth modules stay dynamic (externalized by esbuild, resolved from node_modules)
    const { mcpAuthRouter } = await import(
      "@modelcontextprotocol/sdk/server/auth/router.js"
    );
    const { requireBearerAuth } = await import(
      "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js"
    );

    const provider = new TradeBlocksAuthProvider(auth);

    // Determine issuer URL (public URL for OAuth discovery metadata)
    const issuerUrl = new URL(
      auth.issuerUrl || `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`
    );

    // Mount OAuth routes: /.well-known, /authorize, /token, /register
    app.use(mcpAuthRouter({ provider, issuerUrl }));

    // Parse URL-encoded form bodies for /login
    app.use(express.urlencoded({ extended: false }));

    // Rate limiter for login attempts (express-rate-limit)
    const loginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many login attempts. Try again later." },
    });

    // Custom login route for credential form submission
    app.post("/login", loginLimiter, (req: Request, res: Response) => {
      const result = provider.handleLogin(req.body);
      if ("error" in result) {
        // Re-render login page with error message
        const html = renderLoginPage({
          redirectUri: req.body.redirect_uri || "",
          state: req.body.state,
          codeChallenge: req.body.code_challenge || "",
          clientId: req.body.client_id || "",
          scopes: (req.body.scopes || "").split(" ").filter(Boolean),
          resource: req.body.resource,
          error: result.error,
        });
        res.setHeader("Content-Type", "text/html");
        res.send(html);
        return;
      }
      res.redirect(result.redirectUrl);
    });

    // Create auth middleware for MCP endpoints
    mcpAuthMiddleware = [requireBearerAuth({ verifier: provider })];

    console.error(`Authentication enabled. Login at ${issuerUrl}/authorize`);
  } else if (auth?.noAuth) {
    console.error(
      "WARNING: Authentication disabled (--no-auth). Only use behind an authenticating reverse proxy."
    );
  }

  // Health check endpoint
  app.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
      name: "tradeblocks-mcp",
      status: "ok",
      mcp_endpoint: "/mcp",
    });
  });

  // MCP endpoints with conditional auth middleware
  app.post("/", ...mcpAuthMiddleware, handleMcpRequest(serverFactory));
  app.post("/mcp", ...mcpAuthMiddleware, handleMcpRequest(serverFactory));

  app.get("/mcp", ...mcpAuthMiddleware, (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32601,
        message: "Method not allowed. Use POST for MCP requests.",
      },
      id: null,
    });
  });

  app.delete("/mcp", ...mcpAuthMiddleware, (_req: Request, res: Response) => {
    res.status(202).send();
  });

  const httpServer = createServer(app);

  return new Promise((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, host, () => {
      console.error(
        `TradeBlocks MCP HTTP server listening on http://${host}:${port}/mcp`
      );
      console.error(`Health check available at http://${host}:${port}/`);
      resolve(httpServer);
    });
  });
}

/**
 * Creates a request handler that instantiates fresh server+transport per request.
 * This is the correct stateless pattern per MCP SDK examples.
 */
function handleMcpRequest(serverFactory: ServerFactory) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const server = serverFactory();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };
}
