# MCP integration locked to pi-mcp-adapter

MCP support is delegated entirely to the optional `pi-mcp-adapter` package, locked to the version whose profile-scoped state store lets `/mcp enable` and `/mcp disable` write the active profile's catalog entry. `profiles.json` never stores MCP connection parameters or credentials; server commands, addresses, OAuth, and tokens stay in adapter-managed configuration.

Considered alternative: pi-profile manages MCP configuration itself. Rejected because it would fork server management away from the adapter's single implementation and pull credentials into profile catalogs.

Consequence: a profile that declares `mcp` fails to activate when the adapter is not installed; profiles without `mcp` work fine without it.
