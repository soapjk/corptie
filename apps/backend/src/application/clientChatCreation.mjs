import { deviceError } from "./clientDeviceAuthority.mjs";
import { executeClientCommand } from "./clientEntityCommands.mjs";

export async function clientChatCreationOptions(api) {
  if (!api.chatCreation) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
  const options = await api.chatCreation.options();
  return { schemaVersion: 1,
    agents: api.store.listAgents().map(agent => ({ id: agent.agentId, name: agent.name })),
    providers: options.providers, defaultProviderId: options.defaultProviderId };
}

export async function createClientChat(api, identity, input, revalidateIdentity) {
  if (!api.chatCreation) throw deviceError("CAPABILITY_UNSUPPORTED", 409);
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["requestId", "title", "agentId", "providerId"].includes(key))
      || typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)
      || ["title", "agentId", "providerId"].some(key => typeof input[key] !== "string"
        || !input[key].trim() || input[key].length > 512)) throw deviceError("INVALID_CHAT_CREATION", 400);
  const fields = { title: input.title.trim(), agentId: input.agentId, providerId: input.providerId };
  // Validate inside the receipt operation: a replay remains readable even if
  // its Agent or Provider was subsequently removed or disabled.
  return executeClientCommand(api, identity, revalidateIdentity, { kind: "chat_create", entityId: "chats",
    requestId: input.requestId, fields, uncertainCode: "CHAT_CREATION_UNCERTAIN", run: async () => {
      const agent = api.store.getAgent(fields.agentId);
      if (!agent) throw deviceError("AGENT_NOT_FOUND", 404);
      const options = await api.chatCreation.options();
      if (!options.providers.some(provider => provider.id === fields.providerId && provider.available)) {
        throw deviceError("PROVIDER_CAPABILITY_UNAVAILABLE", 409);
      }
      const session = await api.chatCreation.create({ agent, providerId: fields.providerId, title: fields.title });
      if (!session?.id) throw deviceError("CHAT_CREATION_UNCERTAIN", 503);
      return { sessionId: session.id, title: session.title ?? fields.title };
    } });
}
