// Local MCP server: speaks stdio MCP to the AI client that launched it and
// reaches the Chrome extension over a WebSocket on 127.0.0.1 (see bridge.ts).

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { localAgentId } from '../../shared/local-agent-id';
import { toolsServerFactory } from '../../shared/mcp-tools-server';
import { DEFAULT_LOCAL_PORT } from '../../shared/protocol';
import { parseProfile } from '../../shared/tools';
import { startBridge } from './bridge';

const port = Number(process.env.HELMSMAN_PORT) || DEFAULT_LOCAL_PORT;
// stdout belongs to the MCP protocol; everything human-readable goes to stderr.
const log = (line: string) => process.stderr.write(`[helmsman] ${line}\n`);

if (process.stdin.isTTY) {
  log('This is an MCP server: configure it in your AI client (see docs/huong-dan.md), do not run it by hand.');
}

const bridge = startBridge({ port, extensionId: process.env.HELMSMAN_EXTENSION_ID, log });

// Each client session spawns its own server process, so the process is the agent: two Claude Code
// sessions sharing one MCP config get separate tabs and tab groups. The working folder (the
// client's project) is the group title until the agent names its group itself.
const instance = randomUUID().slice(0, 8);
const agentId = () => localAgentId(server.server.getClientVersion()?.name ?? 'local', process.cwd(), os.homedir(), instance);

// HELMSMAN_PROFILE=core advertises only the most-used tools (smaller tool list); anything else means full.
const server = toolsServerFactory()(
  (tool, args, timeoutMs, safeToRepeat) => bridge.call(tool, args, timeoutMs, safeToRepeat, agentId()),
  parseProfile(process.env.HELMSMAN_PROFILE),
);

const shutdown = () => {
  bridge.close();
  process.exit(0);
};
// The client closing stdin (or dying) ends this process so a waiting peer can take over the port.
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await server.connect(new StdioServerTransport());
