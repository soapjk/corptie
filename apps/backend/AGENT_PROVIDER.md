# Agent Provider integration

Corptie treats Codex, Claude Code, OpenClacky, and third-party runtimes as adapters behind one product contract. Product code uses capabilities and canonical Session models; it does not branch on a Provider name.

## Provider shape

Create a Provider with `CallbackAgentProvider` (or implement the same object shape directly):

```js
import {
  AGENT_PROVIDER_CAPABILITIES as C,
  CallbackAgentProvider
} from "./src/agent-provider/index.mjs";

export function createAgentProvider(context) {
  const runtime = new MyRuntime({ onEvent: context.onEvent });
  return new CallbackAgentProvider({
    id: "acme-agent",
    displayName: "Acme Agent",
    transport: "http-websocket",
    aliases: ["acme"],
    runtime: { lifecycle: "external" },
    configuration: {
      fields: [{ id: "baseURL", type: "url", label: "Server URL", required: true }]
    },
    capabilities: [C.SESSION_CREATE, C.CONVERSATION_SEND]
  }, {
    listSessions: (options) => runtime.list(options),
    readSession: (reference) => runtime.read(reference.providerSessionId),
    createSession: (input, requestContext) => runtime.create(input, requestContext),
    send: (reference, message) => runtime.send(reference.providerSessionId, message)
  });
}
```

`listSessions` is synchronous because the unified sidebar reads a cached snapshot. Network-backed adapters refresh their cache in the background and emit a change event. Other operations may be asynchronous.

## Registration

Register the Provider or factory through `additionalProviders`:

```js
createAgentProviderRuntimeRegistry({
  claudeProvider,
  codexOperations,
  additionalProviders: [createAgentProvider]
});
```

Factories receive `providerContext`, so protocol clients can consume shared event, persistence, and diagnostics ports without importing product services. Once registered, the Provider appears in `GET /providers`; macOS renders the new-Session and Agent selectors dynamically. The common `POST /sessions` endpoint accepts its canonical id or any declared alias.

## Canonical Sessions and capabilities

A Session summary includes `id`, `title`, `status`, `updatedAt`, and routing fields under `external`:

```js
external: {
  provider: "acme-agent",
  sessionId: nativeSessionId,
  threadId: nativeSessionId,
  cwd
}
```

Use `running`, `blocked`, `complete`, `failed`, or `cancelled`. Details also supply `createdAt`, `turnCount`, and canonical timeline items such as `userMessage`, `agentMessage`, `commandExecution`, `reasoning`, `choice`, and `system`.

Only declare a capability when its operation is implemented; registration rejects invalid adapters. Frontends inspect capabilities for model, reasoning, approval, interruption, and lifecycle controls. Before shipping, run the backend contract/boundary suite and add protocol fixture tests covering create, history mapping, live events, interruption, approval, and failure diagnostics.

## OpenClacky

The built-in adapter uses OpenClacky's native local server protocol:

- REST for session CRUD/history and model configuration
- WebSocket for subscribe, message, confirmation, interrupt, and live events
- default endpoint `http://127.0.0.1:7070`
- overrides `OPENCLACKY_BASE_URL` and `OPENCLACKY_ACCESS_KEY`

OpenClacky remains an external runtime; Corptie does not silently launch a PTY fallback when its server is unavailable.
