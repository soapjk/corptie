import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageImageGeometry } from "./messageImageGeometry.mjs";

const run = promisify(execFile);
const failure = () => Object.assign(new Error("Image preview unavailable."), { code: "IMAGE_PREVIEW_UNAVAILABLE", statusCode: 415 });
let active = 0;
const queue = [];
export function imageVariant(query) {
  const values = query.getAll("variant");
  if (values.length > 1 || (values.length && !["preview", "original"].includes(values[0]))) {
    throw Object.assign(new Error("Invalid image variant."), { statusCode: 400, code: "INVALID_QUERY" });
  }
  return values[0] ?? "original";
}

// Gate the authorized read as well as decoding, so queued requests retain no original bytes.
export async function deliverImageVariant(variant, read) {
  if (variant !== "preview") return read();
  if (queue.length >= 24) throw Object.assign(failure(), { statusCode: 429 });
  if (active >= 2) await new Promise(resolve => queue.push(resolve));
  else active++;
  let directory;
  try {
    const resource = await read();
    let geometry = messageImageGeometry(resource.data);
    if (!resource.data.length || resource.data.length > 20 * 1024 * 1024) throw failure();
    directory = await mkdtemp(join(tmpdir(), "corptie-preview-"));
    const input = join(directory, "input"), output = join(directory, "preview.jpg");
    await writeFile(input, resource.data, { mode: 0o600 });
    if (!geometry.pixelWidth || !geometry.pixelHeight) {
      // HEIC and some WebP headers need native metadata; this does not rasterize.
      const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", input],
        { timeout: 5000, maxBuffer: 4096 });
      geometry = { pixelWidth: Number(stdout.match(/pixelWidth: (\d+)/)?.[1]),
        pixelHeight: Number(stdout.match(/pixelHeight: (\d+)/)?.[1]) };
    }
    if (!geometry.pixelWidth || !geometry.pixelHeight || geometry.pixelWidth * geometry.pixelHeight > 32_000_000) throw failure();
    // macOS ImageIO via sips: background process, transformed first frame only.
    for (const [edge, quality] of [[1024, "60"], [512, "40"]]) {
      await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", quality,
        "-Z", String(edge), input, "--out", output], { timeout: 15000, maxBuffer: 4096 });
      const data = await readFile(output);
      const dimensions = messageImageGeometry(data);
      if (data.length <= 300 * 1024 && dimensions.pixelWidth && dimensions.pixelHeight
          && Math.max(dimensions.pixelWidth, dimensions.pixelHeight) <= 1024) {
        return { data, mimeType: "image/jpeg", contentType: "image/jpeg", byteLength: data.length,
          fileName: "preview.jpg", ...dimensions };
      }
    }
    throw failure();
  } catch (error) {
    if (error.statusCode) throw error;
    throw failure();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    const next = queue.shift();
    if (next) next(); else active--;
  }
}
