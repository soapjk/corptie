import net from "node:net";
import { randomUUID } from "node:crypto";
import { contractError } from "./receiptContracts.mjs";

export class PortBroker {
  constructor() { this.handles = new Map(); }

  async reserve({ runId, host = "127.0.0.1" }) {
    if (!["127.0.0.1", "::1"].includes(host)) throw contractError("RUN_PORT_UNAVAILABLE", "Only loopback addresses are allowed.");
    const server = net.createServer({ pauseOnConnect: true });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host, port: 0, exclusive: true }, resolve); });
    const address = server.address();
    const handleId = `server_handle:${randomUUID()}`;
    const reservation = { handleId, runId, host, port: address.port, socketNonce: randomUUID(), listenFD: server._handle?.fd ?? null, server };
    if (!Number.isInteger(reservation.listenFD) || reservation.listenFD < 0) { server.close(); throw contractError("RUN_PORT_UNAVAILABLE", "Listening FD is unavailable."); }
    this.handles.set(handleId, reservation);
    return Object.freeze({ ...reservation, server: undefined });
  }

  server(handleId) { return this.handles.get(handleId)?.server ?? null; }
  isOpen(handleId) { return Boolean(this.handles.get(handleId)?.server?.listening); }
  async release(handleId) { const entry=this.handles.get(handleId); if(!entry)return; await new Promise((resolve)=>entry.server.close(resolve)); this.handles.delete(handleId); }
  async close() { for (const handleId of [...this.handles.keys()]) await this.release(handleId); }
}
