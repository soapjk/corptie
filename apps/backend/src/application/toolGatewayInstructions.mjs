// Shared startup/Turn guidance. Business tool names are not native registrations.
export const TOOL_GATEWAY_INSTRUCTIONS = [
  "Corptie business capabilities use a fixed discovery and invocation gateway; do not expect every installed MCP or Skill to appear as a native Provider tool.",
  "Use corptie_tool_catalog_search with the intent or exact canonical business tool name. Follow the returned domain invocation contract and authoritative inputSchema. Use corptie_tool_domain_load only when the contract requires it.",
  "For invocation.mode=restricted_gateway, call corptie_tool_call with tool=the canonical business tool name, arguments=its input object, and expected_catalog_version=the returned domain invocation.expectedCatalogVersion. Do not invoke that business name as a native tool. Call a business tool directly only when the current contract explicitly permits it and the native tool is actually available.",
  "References elsewhere to calling a named Corptie tool identify a business operation, not a promise of native registration. The same routing rule applies to Skills, MCPs, collaboration, Tasks and Automations; gateway discovery is not recipient-Session discovery.",
  "Loading a gateway contract does not install hundreds of native tools, change the Provider binding, or grant authorization. Current Session disabling and server-side permission checks remain authoritative. Never bypass them through native MCPs, cached tool names or local Skill paths."
].join(" ");
