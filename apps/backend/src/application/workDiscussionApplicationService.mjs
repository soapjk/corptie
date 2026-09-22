/** Shared Work discussion creation, independent of client layout and Provider implementation.
 * Transport authentication remains at the caller. Agent IDs identify resources, not actors.
 * One service instance per backend serializes creation per Work, including startup repair.
 * This is not a durable command receipt; device transports still need their own journal.
 */
export class WorkDiscussionApplicationService {
  constructor({ workService, launch }) {
    this.workService = workService;
    this.launch = launch;
    this.pending = new Map();
  }

  validate({ workId, agentId, providerId }) {
    const work = this.workService.getWork(workId);
    if (typeof agentId !== "string" || !agentId.trim()) throw coded("INVALID_INPUT", "agentId is required.", 400);
    const agent = this.workService.store.getAgent(agentId.trim());
    if (!agent) throw coded("AGENT_NOT_FOUND", "Agent not found.", 404);
    if (!(work.contributorAgentIds ?? []).includes(agent.agentId)) {
      throw coded("AGENT_OUTSIDE_WORK", "只有挂载在当前 Work 下的 Agent 才能创建 Work Chat Session。", 403);
    }
    if (typeof providerId !== "string" || !providerId.trim()) throw coded("INVALID_INPUT", "providerId is required.", 400);
    return { work, agent, providerId: providerId.trim() };
  }

  async open(input) {
    this.validate(input);
    const pending = this.pending.get(input.workId);
    if (pending) {
      // Never let an overlapping click become a second launch, even on failure.
      const result = await pending;
      this.validate(input);
      return { session: result.session, created: false };
    }
    // Defer launch until the promise is registered, including synchronous callbacks.
    const operation = Promise.resolve().then(async () => {
      const context = this.validate(input);
      const existing = this.workService.store.getWorkChatSession(input.workId);
      if (existing) return { session: existing, created: false };
      if (typeof this.launch !== "function") throw coded("CAPABILITY_UNAVAILABLE", "Work discussion creation is unavailable.", 503);
      const session = await this.launch({
        ...context,
        title: optionalText(input.title),
        prompt: optionalText(input.prompt)
      });
      return { session, created: true };
    });
    this.pending.set(input.workId, operation);
    try { return await operation; }
    finally { if (this.pending.get(input.workId) === operation) this.pending.delete(input.workId); }
  }

  async ensure(workId, providerId) {
    const work = this.workService.getWork(workId);
    const existing = this.workService.store.getWorkChatSession(workId);
    if (existing) return existing;
    const agent = (work.contributorAgentIds ?? []).map(id => this.workService.store.getAgent(id)).find(Boolean);
    if (!agent) throw coded("WORK_CONTRIBUTOR_REQUIRED", "创建 Work Chat 需要至少一个有效的 Contributor Agent。", 400);
    return (await this.open({ workId, agentId: agent.agentId, providerId, title: `${work.name}_Chat` })).session;
  }
}

function optionalText(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function coded(code, message, statusCode) { return Object.assign(new Error(message), { code, statusCode }); }
