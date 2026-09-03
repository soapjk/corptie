import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";

export const CHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export class ChatResourceService {
  constructor(options = {}) {
    this.store = options.store ?? null;
    this.idFactory = options.idFactory ?? randomUUID;
    this.environmentRoot = options.environmentRoot ?? null;
  }

  async initialize() {
    this.environmentRoot ??= this.store?.layout?.environmentRoot ?? null;
    if (!this.environmentRoot) throw new TypeError("ChatResourceService requires an environment root.");
    await mkdir(join(this.environmentRoot, "chat-resources"), { recursive: true, mode: 0o700 });
  }

  async useDataRoot(layout) {
    if (!layout?.environmentRoot) throw new TypeError("ChatResourceService requires a data root layout.");
    this.environmentRoot = layout.environmentRoot;
    await this.initialize();
  }

  async importImage(reference, input = {}) {
    const sourcePath = requiredAbsolutePath(input.sourcePath, "sourcePath");
    const source = await realpath(sourcePath);
    const info = await stat(source);
    if (!info.isFile()) throw resourceError("CHAT_IMAGE_NOT_FILE", "The selected image is not a regular file.");
    if (info.size <= 0 || info.size > CHAT_IMAGE_MAX_BYTES) {
      throw resourceError("CHAT_IMAGE_SIZE_INVALID", "Images must be between 1 byte and 20 MB.");
    }
    const handle = await open(source, "r");
    const header = Buffer.alloc(32);
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(header, 0, header.length, 0));
    } finally {
      await handle.close();
    }
    const imageType = detectedImageType(header.subarray(0, bytesRead), extname(source));
    if (!imageType) throw resourceError("CHAT_IMAGE_FORMAT_UNSUPPORTED", "Supported image formats are PNG, JPEG, GIF, WebP, and HEIC.");
    const relativeDirectory = this.#relativeDirectory(reference);
    const fileName = `${this.idFactory()}.${imageType.extension}`;
    const managedPath = `${relativeDirectory}/${fileName}`;
    const destination = this.#safePath(managedPath);
    await mkdir(join(this.environmentRoot, relativeDirectory), { recursive: true, mode: 0o700 });
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    const preservesOriginal = input.preserveOriginal !== false;
    return Object.freeze({
      managedPath,
      originalPath: preservesOriginal ? source : null,
      fileName: basename(source),
      mimeType: imageType.mimeType,
      byteLength: info.size
    });
  }

  async readImage(reference, managedPath) {
    this.#assertOwned(reference, managedPath);
    const path = this.#safePath(managedPath);
    const info = await stat(path).catch((error) => {
      if (error?.code === "ENOENT") throw resourceError("CHAT_IMAGE_MISSING", "The image file is missing.", 404);
      throw error;
    });
    if (!info.isFile()) throw resourceError("CHAT_IMAGE_MISSING", "The image file is missing.", 404);
    const data = await readFile(path);
    const type = detectedImageType(data.subarray(0, 32), extname(path));
    if (!type) throw resourceError("CHAT_IMAGE_FORMAT_UNSUPPORTED", "The stored image format is unsupported.", 415);
    return { data, path, mimeType: type.mimeType, byteLength: info.size };
  }

  async removeUnsentImage(reference, managedPath) {
    this.#assertOwned(reference, managedPath);
    await unlink(this.#safePath(managedPath)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return { removed: true };
  }

  resolveAbsolutePath(reference, managedPath) {
    this.#assertOwned(reference, managedPath);
    return this.#safePath(managedPath);
  }

  async exists(reference, managedPath) {
    try {
      await access(this.resolveAbsolutePath(reference, managedPath));
      return true;
    } catch {
      return false;
    }
  }

  missingImagePath(reference, identifier = "missing") {
    return `${this.#relativeDirectory(reference)}/${safeSegment(identifier, "missing")}.missing`;
  }

  #relativeDirectory(reference) {
    const session = reference?.metadata?.session ?? {};
    const logicalSessionId = safeSegment(reference?.logicalSessionId ?? reference?.sessionId, "session");
    if (session.taskId) {
      return `chat-resources/tasks/${safeSegment(session.taskId, "task")}/${logicalSessionId}/images`;
    }
    if (session.workId) {
      return `chat-resources/works/${safeSegment(session.workId, "work")}/${logicalSessionId}/images`;
    }
    return `chat-resources/sessions/${logicalSessionId}/images`;
  }

  #assertOwned(reference, managedPath) {
    const normalized = String(managedPath ?? "").replaceAll("\\", "/");
    const prefix = `${this.#relativeDirectory(reference)}/`;
    if (!normalized.startsWith(prefix)) {
      throw resourceError("CHAT_IMAGE_FORBIDDEN", "The image does not belong to this Session.", 403);
    }
  }

  #safePath(managedPath) {
    const root = resolve(this.environmentRoot);
    const candidate = resolve(root, String(managedPath ?? ""));
    if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
      throw resourceError("CHAT_IMAGE_PATH_INVALID", "The image path escapes the Corptie data root.");
    }
    return candidate;
  }
}

function detectedImageType(header, extension = "") {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  if (header.length >= 6 && ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) {
    return { extension: "gif", mimeType: "image/gif" };
  }
  if (header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF"
      && header.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: "webp", mimeType: "image/webp" };
  }
  if (header.length >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = header.subarray(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return { extension: ["heic", "heif"].includes(extension.slice(1).toLowerCase()) ? extension.slice(1).toLowerCase() : "heic", mimeType: "image/heic" };
    }
  }
  return null;
}

function requiredAbsolutePath(value, field) {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path || !isAbsolute(path)) throw resourceError("CHAT_IMAGE_PATH_INVALID", `${field} must be an absolute path.`);
  return path;
}

function safeSegment(value, fallback) {
  const normalized = String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
  return normalized || fallback;
}

function resourceError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
