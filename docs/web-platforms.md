# Web Platform Integration Guide

Connect TradeBlocks MCP to web-based AI platforms for trading analysis from your browser.

## Overview

Web AI platforms like ChatGPT, Google AI Studio, and Julius require **remote MCP server URLs** - they cannot connect to servers running on localhost. TradeBlocks MCP runs locally to keep your backtest data on your machine.

**Solution:** Use an ngrok tunnel to expose your local MCP server as a remote URL. This approach:

- Keeps your trading data on your local machine
- Allows web platforms to connect via secure HTTPS
- Requires no cloud deployment or data uploads

## Platform Compatibility

| Platform         | MCP Support    | Plan Required                    | Setup Complexity |
| ---------------- | -------------- | -------------------------------- | ---------------- |
| ChatGPT          | Developer Mode | Pro/Plus/Business/Enterprise/Edu | Medium           |
| Google AI Studio | Native         | Free                             | Easy             |
| Julius AI        | Native         | Free tier available              | Easy             |

## Prerequisites

Before setting up any web platform:

1. **Node.js 18+** - Required for TradeBlocks MCP
2. **ngrok account** - Free tier works ([sign up at ngrok.com](https://ngrok.com))
3. **TradeBlocks MCP installed**:
   ```bash
   npm install -g tradeblocks-mcp
   ```
4. **Backtest data directory** - Folder with your strategy CSV files

## Quick Start (All Platforms)

**Terminal 1:** Start MCP server with HTTP transport:

```bash
tradeblocks-mcp --http ~/Trading/backtests
```

Or with a custom port:

```bash
tradeblocks-mcp --http --port 8080 ~/Trading/backtests
```

**Terminal 2:** Expose via ngrok:

```bash
ngrok http 3100
```

Note the ngrok URL (e.g., `https://abc123.ngrok.io`) - you'll need this for platform setup.

> **Note:** The `--http` flag enables HTTP transport mode. Without it, the server runs in stdio mode (for Claude Desktop and CLI tools).

---

## ChatGPT Integration

### Requirements

- ChatGPT Pro, Plus, Business, Enterprise, or Education plan
- Developer Mode enabled (not available in EEA, Switzerland, UK)

### Setup Steps

1. **Enable Developer Mode:**
   - Open ChatGPT Settings (gear icon)
   - Navigate to Connectors > Advanced
   - Toggle on "Developer Mode"

2. **Add TradeBlocks connector:**
   - In ChatGPT, go to Settings > Connectors > Add Connector
   - Enter your ngrok URL: `https://your-subdomain.ngrok.io/mcp`
   - Name it "TradeBlocks"

3. **Test the connection:**
   - Start a new chat
   - Ask: "List my backtests using TradeBlocks"
   - ChatGPT should call `list_blocks` and show your strategies

### Limitations

- **Developer Mode required** - Standard Connectors mode requires search/fetch tools which TradeBlocks doesn't implement
- **Session-based** - ngrok URL changes each restart (paid ngrok has stable URLs)
- **Not available in EEA/Switzerland/UK** - Regional restrictions apply

### Troubleshooting

- **"Connection failed"**: Verify ngrok is running and URL is correct
- **"No tools found"**: Ensure MCP server started with `--http` flag
- **"Unauthorized"**: Some ChatGPT plans don't support Developer Mode

---

## Google AI Studio Integration

### Requirements

- Google account
- ngrok tunnel running

### Setup Steps

1. **Open AI Studio:** Navigate to [aistudio.google.com](https://aistudio.google.com)

2. **Add MCP Server:**
   - Click Settings (gear icon) > MCP Servers
   - Add new server with your ngrok URL: `https://your-subdomain.ngrok.io/mcp`
   - Name it "TradeBlocks"

3. **Test the connection:**
   - Start a new prompt
   - Ask: "Use TradeBlocks to list my backtests"
   - AI Studio should discover and use the MCP tools

### Notes

- Google AI Studio MCP support is experimental
- All TradeBlocks tools are available
- Works with Gemini models

---

## Julius AI Integration

### Requirements

- Julius AI account (free tier available)
- ngrok tunnel running

### Setup Steps

1. **Open Julius:** Navigate to [julius.ai](https://julius.ai)

2. **Connect MCP Server:**
   - Go to Settings > Data Connections > MCP
   - Add your ngrok URL: `https://your-subdomain.ngrok.io/mcp`
   - Name the connection "TradeBlocks"

3. **Test the connection:**
   - Start a new conversation
   - Ask: "Connect to TradeBlocks and show my available backtests"

### Notes

- Julius excels at data visualization - great for chart-heavy analysis
- Combine with `get_performance_charts` tool for visual reports

---

## Tips for All Platforms

### Keeping ngrok Running

For extended sessions, consider:

- **Paid ngrok**: Stable URLs that don't change between restarts
- **Screen/tmux**: Keep terminal sessions alive when you disconnect
- **PM2**: Process manager for Node.js (`pm2 start tradeblocks-mcp -- --http ~/backtests`)

### Security Considerations

- ngrok exposes your local server to the internet
- Your backtest data stays local - only analysis results are transmitted
- Consider ngrok's IP allowlisting for extra security
- Use authentication tokens when available

### Alternative: Cloudflare Tunnel

For a free stable URL alternative:

```bash
cloudflared tunnel --url http://localhost:3100
```

Cloudflare Tunnel provides stable URLs without a paid plan.

---

## Related Documentation

- [README.md](../README.md) - Installation and CLI setup
- [Usage Guide](usage.md) - Detailed usage examples
