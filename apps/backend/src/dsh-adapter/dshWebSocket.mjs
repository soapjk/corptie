// DSH 前端实时事件下行通道（WebSocket downlink）。
//
// DSH web 前端的 ConnectionController 在 boot 时会建立两个单向下行 WebSocket：
//   - /api/events.mux  —— MuxFrame（session 事件、approval/question/queue/projection/jobs）
//   - /api/events.host —— HostFrame（session-added/removed/status、agent-error）
//
// 这两个通道是「实时增量事件」的载体；其「onOpen」是 ConnectionController 严格就绪握手
// 的组成部分——若 WebSocket 无法建立，前端会在 3s streamOpenTimeoutMs 后 abort 当前
// generation，陷入 reconnecting 死循环，永不进入稳定的 connected 态，也就不会渲染会话数据。
//
// 本模块提供一个最小可行实现：正确完成 WebSocket 握手（Sec-WebSocket-Accept），然后
// 保持连接打开（downlink-only，不发任何业务帧；客户端消息是协议违规）。这足以满足前端
// 的「onOpen 建立」要求，让握手越过、进入稳定 connected。后续如需实时事件推送，可在此
// 基础上接入 Corptie 的事件溯源（store 的 sessionEventListeners），把事件映射成 MuxFrame/HostFrame
// 推送给已连接的 socket。
//
// 不依赖 `ws` 包：用 Node 内置 crypto 完成握手 + 手动帧编码。因是 downlink-only，
// 无需解析客户端帧；但为稳健起见，收到客户端消息时按协议违规关闭（close code 1008）。

import { createHash, randomUUID } from "node:crypto";

/** WebSocket GUID（RFC 6455 固定值），用于 Sec-WebSocket-Accept 计算。 */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const muxSockets = new Set();
const hostSockets = new Set();

/** 计算 Sec-WebSocket-Accept 响应头。 */
function acceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/**
 * 编码一个文本帧（FIN=1, opcode=0x1）。载荷 < 126 字节时用 7-bit 长度；
 * < 65536 用 126 + 16-bit；否则 127 + 64-bit。服务端→客户端帧不 mask。
 */
function encodeTextFrame(payload) {
  const text = Buffer.from(payload, "utf8");
  const len = text.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, text]);
}

/**
 * 处理一个 DSH WebSocket 升级请求（mux 或 host）。
 * 在 socket 上完成握手后保持连接打开（downlink-only）。
 *
 * @param {object} deps
 * @param {object} deps.socket  - node:net 的 socket（upgrade 事件的第二个参数）
 * @param {object} deps.request - node:http IncomingMessage（upgrade 事件的第一个参数）
 * @param {Buffer} deps.head    - 升级后已读取的字节（upgrade 事件的第三个参数）
 * @returns {boolean} 是否接管了该升级请求（false 表示非本模块路径）
 */
export function handleDshWebSocketUpgrade({ socket, request, head }) {
  const pathname = (request.url ?? "").split("?")[0];
  if (pathname !== "/api/events.mux" && pathname !== "/api/events.host") {
    return false;
  }

  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"
    );
    return true;
  }

  // 完成握手响应。
  const accept = acceptKey(key);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${accept}\r\n`
    + "\r\n"
  );

  const sockets = pathname === "/api/events.mux" ? muxSockets : hostSockets;
  sockets.add(socket);

  // downlink-only：收到客户端消息视为协议违规，关闭（1008 policy violation）。
  const onData = () => {
    const closeFrame = Buffer.from([0x88, 0x02, 0x03, 0xf0]); // 1008 = 0x03F0
    socket.write(closeFrame);
    socket.end();
  };
  socket.on("data", onData);
  socket.on("error", () => {
    /* 连接异常：静默清理，交由 close 处理。 */
  });
  socket.on("close", () => {
    sockets.delete(socket);
    socket.removeListener("data", onData);
  });

  // 若 head 里带有已读取的字节，说明客户端在升级后立即发了数据（协议违规）。
  if (head && head.length > 0) onData();

  return true;
}

function broadcast(sockets, payload) {
  const envelope = JSON.stringify({
    type: "server-request",
    rpcId: randomUUID(),
    method: payload.type,
    payload,
  });
  const frame = encodeTextFrame(envelope);
  for (const socket of sockets) {
    if (!socket.destroyed && socket.writable) socket.write(frame);
  }
}

/** 向所有 DSH mux 下行连接广播一个已符合 DSH schema 的 MuxFrame。 */
export function broadcastDshMuxFrame(payload) {
  broadcast(muxSockets, payload);
}

/** 向所有 DSH host 下行连接广播一个已符合 DSH schema 的 HostFrame。 */
export function broadcastDshHostFrame(payload) {
  broadcast(hostSockets, payload);
}

/** 供测试/调试：暴露帧编码。 */
export { encodeTextFrame };
