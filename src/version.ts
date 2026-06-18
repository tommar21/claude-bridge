/** Single source of truth for the bridge version string.
 *
 *  Imported by the HTTP server (re-exported as BRIDGE_VERSION), the standalone
 *  stdio MCP server, and the in-process MCP HTTP server so every advertised
 *  version stays in lockstep. Previously these drifted — the stdio MCP server
 *  still reported "3.3.0" while package.json was at "3.6.1". Bump this in the
 *  same commit as package.json. */
export const BRIDGE_VERSION = "3.6.1";
