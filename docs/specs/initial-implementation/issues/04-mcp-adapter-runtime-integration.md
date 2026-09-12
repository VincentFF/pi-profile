# 04: pi-mcp-adapter coordination via pi.events

**What to build:** MCP support through in-Pi coordination: the pi-profile extension detects the locked `pi-mcp-adapter`, validates the profile's `mcp` references against adapter-discovered server names, and publishes the profile's runtime server allowlist over the `pi.events` event bus at activation (session start and after every reload). When the adapter is absent, profiles without `mcp` activate normally while profiles declaring `mcp` fail with a clear missing-adapter error. pi-profile never stores or manages MCP connection configuration, credentials, or the adapter's own enable/disable state.

**Blocked by:** 02 (Named global profiles via generated settings)

**Status:** ready-for-agent

- [ ] Adapter presence is detected at activation; a profile declaring `mcp` fails loudly when the adapter is absent, while a profile without `mcp` activates unchanged and publishes no coordination.
- [ ] Profile MCP names are validated against adapter-discovered servers; a referenced-but-undiscovered name fails activation before spawn (launch) or before reload (switch).
- [ ] The runtime allowlist is applied in memory via the event bus on session start and after every `ctx.reload()`; the adapter's persistent enable/disable storage (its default `.pi/mcp.json` overlay) is never written by profile activation.
- [ ] The built-in `default` profile without an `mcp` declaration uses the adapter's currently discovered and enabled servers in full.
- [ ] Unit tests cover detection, allowlist publication, and both failure modes against a fake event bus / adapter.
