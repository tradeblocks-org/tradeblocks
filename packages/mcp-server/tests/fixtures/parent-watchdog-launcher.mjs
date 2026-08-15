// Launcher stand-in used by tests/integration/parent-death-watchdog.test.ts.
//
// Mirrors the real-world `npx tradeblocks-mcp ...` launch: opens the FIFO
// read-end itself (as a real launcher hands node its stdin), spawns the MCP
// server with that read-end as fd0, records its PID, and stays alive.
//
// The test process holds an INDEPENDENT write-end on the same FIFO (opened
// before this launcher runs), so killing this launcher does not close the
// pipe — the MCP server's stdin never EOFs, faithfully modeling "the client
// keeps the pipe open; only the launcher dies."
import { spawn } from "node:child_process";
import fs from "node:fs";

const [mcpEntry, dataDir, outLog, errLog, pidFile, fifoPath] = process.argv.slice(2);

const out = fs.openSync(outLog, "w");
const err = fs.openSync(errLog, "w");
const rfd = fs.openSync(fifoPath, fs.constants.O_RDONLY); // writer (test) already open

const child = spawn(process.execPath, [mcpEntry, dataDir], { stdio: [rfd, out, err] });
fs.writeFileSync(pidFile, String(child.pid));

// Keep the event loop alive so a plain SIGKILL is required to remove this
// launcher — matches how a real `npx` wrapper stays resident.
setInterval(() => {}, 1 << 30);

child.on("exit", (code, signal) => {
  fs.appendFileSync(errLog, `\n[launcher] child exited code=${code} signal=${signal}\n`);
});
