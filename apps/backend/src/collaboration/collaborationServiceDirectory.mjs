import { serviceFromRow, agentFromRow } from "./collaborationRecordProjection.mjs";
import { requiredId, requiredText, optionalText, domainError } from "./collaborationValidation.mjs";

export class CollaborationServiceDirectory {
  constructor({ store, clock, requireAgent }) {
    this.store = store;
    this.clock = clock;
    this.requireAgent = requireAgent;
  }

  registerService(input) {
    const serviceId = requiredId(input.serviceId, "serviceId");
    const owner = this.requireAgent(input.ownerAgentId);
    const timestamp = this.clock();
    const existing = this.getService(serviceId);
    if (existing && existing.ownerAgentId !== owner.agentId) {
      throw domainError("SERVICE_OWNER_MISMATCH", "Service ownership transfer requires a separate explicit workflow.");
    }
    const status = input.status ?? existing?.status ?? "unknown";
    if (!["unknown", "stopped", "starting", "running", "degraded", "failed", "inactive"].includes(status)) {
      throw domainError("INVALID_SERVICE_STATUS", `Unsupported service status: ${status}`);
    }
    this.store.db.run(
      `INSERT INTO services (
        service_id, name, description, owner_agent_id, current_version, status, endpoint,
        repository_root, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        current_version = excluded.current_version,
        status = excluded.status,
        endpoint = excluded.endpoint,
        repository_root = excluded.repository_root,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
      [
        serviceId,
        requiredText(input.name, "name"),
        optionalText(input.description) ?? "",
        owner.agentId,
        optionalText(input.currentVersion),
        status,
        optionalText(input.endpoint),
        optionalText(input.repositoryRoot),
        JSON.stringify(input.metadata ?? {}),
        existing?.createdAt ?? timestamp,
        timestamp
      ]
    );
    this.store.scheduleSave();
    return this.getService(serviceId);
  }

  updateService(serviceId, actorAgentId, patch = {}) {
    const service = this.#requireService(serviceId);
    if (service.ownerAgentId !== actorAgentId) {
      throw domainError("SERVICE_OWNER_REQUIRED", `Only ${service.ownerAgentId} may update service ${serviceId}.`);
    }
    return this.registerService({
      serviceId,
      ownerAgentId: service.ownerAgentId,
      name: patch.name ?? service.name,
      description: patch.description ?? service.description,
      currentVersion: patch.currentVersion ?? service.currentVersion,
      status: patch.status ?? service.status,
      endpoint: patch.endpoint ?? service.endpoint,
      repositoryRoot: patch.repositoryRoot ?? service.repositoryRoot,
      metadata: patch.metadata ?? service.metadata
    });
  }

  getService(serviceId) {
    const row = this.store.selectOne("SELECT * FROM services WHERE service_id = ?", [serviceId]);
    return row ? serviceFromRow(row) : null;
  }

  listServices(options = {}) {
    const conditions = [];
    const params = [];
    if (options.ownerAgentId) {
      conditions.push("owner_agent_id = ?");
      params.push(options.ownerAgentId);
    }
    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.store.selectAll(`SELECT * FROM services ${where} ORDER BY name ASC`, params).map(serviceFromRow);
  }

  addServiceConsumer(serviceId, agentId) {
    this.#requireService(serviceId);
    this.requireAgent(agentId);
    this.store.db.run(
      "INSERT OR IGNORE INTO service_consumers (service_id, agent_id, created_at) VALUES (?, ?, ?)",
      [serviceId, agentId, this.clock()]
    );
    this.store.scheduleSave();
    return this.listServiceConsumers(serviceId);
  }

  listServiceConsumers(serviceId) {
    return this.store.selectAll(
      `SELECT a.* FROM agents a
       JOIN service_consumers c ON c.agent_id = a.agent_id
       WHERE c.service_id = ? ORDER BY a.name ASC`,
      [serviceId]
    ).map((row) => agentFromRow(row, this.store));
  }

  #requireService(serviceId) {
    const service = this.getService(requiredId(serviceId, "serviceId"));
    if (!service) throw domainError("SERVICE_NOT_FOUND", `Service ${serviceId} was not found.`);
    return service;
  }
}
