/** Range reads are allowed only after the caller authenticates and resolves the exact message. */
export function messageImageResponse(request, resource, destination) {
  const headers = { "content-type": resource.mimeType, "content-length": resource.data.length,
    "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(resource.fileName ?? "image")}` };
  let url;
  try { url = new URL(destination); } catch { /* ordinary resource */ }
  const hash = url?.protocol === "artifact:" && /^[1-9][0-9]*$/.test(url.searchParams.get("version") ?? "")
    && /^[a-f0-9]{64}$/.test(url.searchParams.get("hash") ?? "") ? url.searchParams.get("hash") : null;
  if (!hash) return { status: 200, headers, data: resource.data };
  headers.etag = `"${hash}"`; headers["accept-ranges"] = "bytes";
  const range = request.headers?.range;
  if (!range || request.headers?.["if-range"] !== headers.etag) return { status: 200, headers, data: resource.data };
  const match = /^bytes=(\d+)-$/.exec(range);
  const offset = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= resource.data.length) {
    return { status: 416, headers: { ...headers, "content-length": 0, "content-range": `bytes */${resource.data.length}` }, data: Buffer.alloc(0) };
  }
  const data = resource.data.subarray(offset);
  return { status: 206, headers: { ...headers, "content-length": data.length,
    "content-range": `bytes ${offset}-${resource.data.length - 1}/${resource.data.length}` }, data };
}
