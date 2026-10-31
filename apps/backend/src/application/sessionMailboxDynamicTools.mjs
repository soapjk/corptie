const tool = (name, description, properties, required = []) => ({ name, description,
  inputSchema: { type: "object", properties, required, additionalProperties: false } });
export const sessionMailboxDynamicTools = [
  tool("corptie_mailbox_list", "List this Session's external inbox. Reading does not claim or consume messages.", {
    filter: { type: "string", enum: ["pending", "all", "abnormal"] },
    sourceType: { type: "string", enum: ["channel", "automation", "background", "system"] },
    beforeCursor: { type: "string", pattern: "^[1-9][0-9]*$" }, limit: { type: "integer", minimum: 1, maximum: 100 }
  }),
  tool("corptie_mailbox_get", "Read one inbox message with original provenance, without consuming its queued delivery.", {
    messageId: { type: "string", minLength: 1 }
  }, ["messageId"]),
  tool("corptie_mailbox_adopt", "Atomically adopt up to 8 unclaimed inbox messages into the current active turn. Returns their full contents; prevents a later duplicate delivery. Never use merely to mark messages read.", {
    messageIds: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1 } }
  }, ["messageIds"])
];
export function callSessionMailboxTool(service, { actorId, metadata, tool, arguments: args }) {
  const id = service.authorizeActor(actorId, metadata);
  if (tool === "corptie_mailbox_list") return service.rows(id, args);
  if (tool === "corptie_mailbox_get") return service.get(id, args.messageId);
  if (tool === "corptie_mailbox_adopt") return service.adopt(id, args.messageIds);
  throw new Error("MAILBOX_TOOL_UNSUPPORTED");
}
