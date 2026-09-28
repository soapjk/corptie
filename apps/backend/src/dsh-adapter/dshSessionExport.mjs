import { deflateRawSync } from "node:zlib";

/**
 * 最小 ZIP 写入器（无第三方依赖），用 node:zlib 的 deflateRawSync 压缩每个条目，
 * 手写 CRC32 与 local/central directory。仅支持 store 或 deflate 的普通文件条目，
 * 足够满足 session.export 返回一个含 JSON 的 ZIP 的需求。
 */
function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let k = 0; k < 8; k++) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };

  const u16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xffff, 0);
    return b;
  };
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
  };

  const dosDateTime = () => {
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  };

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.data, "utf8");
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const { time, date } = dosDateTime();

    // local file header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    parts.push(local, nameBuf, compressed);
    const localSize = 30 + nameBuf.length + compressed.length;

    // central directory entry
    const cent = Buffer.alloc(46);
    cent.writeUInt32LE(0x02014b50, 0);
    cent.writeUInt16LE(20, 4); // version made by
    cent.writeUInt16LE(20, 6); // version needed
    cent.writeUInt16LE(0x0800, 8);
    cent.writeUInt16LE(8, 10);
    cent.writeUInt16LE(time, 12);
    cent.writeUInt16LE(date, 14);
    cent.writeUInt32LE(crc, 16);
    cent.writeUInt32LE(compressed.length, 20);
    cent.writeUInt32LE(data.length, 24);
    cent.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/attrs zero
    cent.writeUInt32LE(offset, 42); // local header offset

    central.push(cent, nameBuf);
    offset += localSize;
  }

  const centralOffset = offset;
  const centralBuf = Buffer.concat(central);
  const centralSize = centralBuf.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with cd
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...parts, centralBuf, end]);
}

/**
 * 处理 DSH session.export（HEAD/GET），返回包含 session 时间线与会话记录的 ZIP。
 *
 * 前端契约（dsh-session-log-export）：HEAD 必须 200（response.ok），随后 GET 下载
 * ZIP。query 带 sessionId 与 includeDescendants。文件名由前端生成，后端无需设置
 * content-disposition 的文件名，但设置也无害。ZIP 内容为 JSON 导出（对话 + 工具轨迹），
 * 对用户有用的同时满足「可下载的合法 zip」这一前端唯一硬性要求。
 */
export function handleSessionExport({ request, response, url, readStoredSessionConversation, readStoredSessionTimeline, now, sendJson }) {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  if (!sessionId) {
    sendJson(response, 400, { error: "session.export requires sessionId" });
    return;
  }

  Promise.all([
    readStoredSessionConversation(sessionId).catch(() => []),
    readStoredSessionTimeline(sessionId).catch(() => [])
  ]).then(([conversation, timeline]) => {
    const payload = JSON.stringify(
      {
        sessionId,
        exportedAt: now(),
        conversation: conversation ?? [],
        timeline: timeline ?? []
      },
      null,
      2
    );

    const zip = buildZip([
      { name: "session.json", data: payload }
    ]);

    // HEAD 只回状态头（无 body），GET 回完整 ZIP。
    if (request.method === "HEAD") {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": zip.length
      });
      response.end();
      return;
    }

    response.writeHead(200, {
      "content-type": "application/zip",
      "content-length": zip.length,
      "content-disposition": `attachment; filename="dsh-session-${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.zip"`
    });
    response.end(zip);
  }).catch((error) => {
    console.error("[dsh-adapter] session.export error:", error?.message ?? error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "session.export failed" });
    }
  });
}
