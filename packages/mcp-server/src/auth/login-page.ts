// src/auth/login-page.ts

export interface LoginPageParams {
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  error?: string;
}

export function renderLoginPage(params: LoginPageParams): string {
  const error = params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TradeBlocks - Sign In</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0a; color: #e5e5e5;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh;
    }
    .card {
      background: #171717; border: 1px solid #262626;
      border-radius: 12px; padding: 2rem;
      width: 100%; max-width: 400px;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    .subtitle { color: #a3a3a3; margin-bottom: 1.5rem; font-size: 0.875rem; }
    label { display: block; font-size: 0.875rem; margin-bottom: 0.25rem; color: #d4d4d4; }
    input[type="text"], input[type="password"] {
      width: 100%; padding: 0.5rem 0.75rem;
      background: #0a0a0a; border: 1px solid #404040;
      border-radius: 6px; color: #e5e5e5; font-size: 1rem;
      margin-bottom: 1rem;
    }
    input:focus { outline: none; border-color: #3b82f6; }
    button {
      width: 100%; padding: 0.625rem;
      background: #3b82f6; color: white;
      border: none; border-radius: 6px;
      font-size: 1rem; cursor: pointer;
    }
    button:hover { background: #2563eb; }
    .error {
      background: #451a1a; border: 1px solid #7f1d1d;
      color: #fca5a5; padding: 0.75rem;
      border-radius: 6px; margin-bottom: 1rem; font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>TradeBlocks</h1>
    <p class="subtitle">Sign in to access your trading data</p>
    ${error}
    <form method="POST" action="/login">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(params.state || "")}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
      <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
      <input type="hidden" name="scopes" value="${escapeHtml(params.scopes.join(" "))}">
      ${params.resource ? `<input type="hidden" name="resource" value="${escapeHtml(params.resource)}">` : ""}
      <label for="username">Username</label>
      <input type="text" id="username" name="username" required autocomplete="username">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
