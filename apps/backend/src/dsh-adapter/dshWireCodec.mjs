// DSH Session RPC 适配层：wire 信封编解码。
//
// 实现 DSH web 前端使用的 fetch 载体的四象限消息信封（client-request /
// server-response / server-request / client-response）。这里只实现 Corptie
// 作为「服务端」需要的两个方向：
//   - 解析前端发来的 ClientRequest  { type:'client-request', rpcId, method, payload }
//   - 构造返回给前端的 ServerResponse { type:'server-response', rpcId, result:{ok, value|error} }
//
// 不引入任何 DSH 依赖；字段命名与 DSH 的 rpc.schema.ts 严格一致，以保证
// DSH 前端（AbstractApiClient / serverResponseSchema）能原样解析。
//
// 参考（DSH 侧源码）：
//   packages/host/apiproxy/src/api/rpc.ts       —— RpcId / RpcResult / RpcError
//   packages/host/apiproxy/src/api/rpc.schema.ts —— serverResponseSchema / clientRequestSchema

/** 生成一个 rpcId（DSH 用 crypto.randomUUID()，此处等价）。 */
export function mintRpcId() {
  // Node 18+ 全局 crypto；无需 import。
  return crypto.randomUUID();
}

/** 解析前端发来的请求体，返回归一化的 { rpcId, method, payload }，非法时返回 null。 */
export function parseClientRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (body.type !== "client-request") return null;
  const rpcId = typeof body.rpcId === "string" && body.rpcId ? body.rpcId : null;
  const method = typeof body.method === "string" && body.method ? body.method : null;
  if (!rpcId || !method) return null;
  return { rpcId, method, payload: body.payload ?? {} };
}

/** 构造成功响应。 */
export function okResponse(rpcId, value) {
  return {
    type: "server-response",
    rpcId,
    result: { ok: true, value },
  };
}

/** 构造业务失败响应（code 取自 DSH 的 RpcErrorCode 集合）。 */
export function errorResponse(rpcId, code, message, details = {}) {
  return {
    type: "server-response",
    rpcId,
    result: { ok: false, error: { code, message, details } },
  };
}

// 常用错误码（DSH rpc.ts 的 RpcErrorDetailsMap 子集）。
export const RpcErrorCode = Object.freeze({
  BAD_REQUEST: "bad-request",
  SESSION_NOT_FOUND: "session-not-found",
  INTERNAL: "internal",
});
