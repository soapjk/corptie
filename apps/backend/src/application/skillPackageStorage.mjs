import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import https from "node:https";
import * as yauzl from "yauzl";
import { allowedMcpAddress, pinnedMcpAddress } from "./restrictedMcpFetch.mjs";

const excluded = new Set([".git", ".hg", ".svn", ".corptie"]);
const sensitive = /^(?:\.env(?:\..*)?|credentials\.json|id_rsa|id_ed25519|.*\.(?:p12|pfx|key))$/i;
const fail = (code, message) => Object.assign(new Error(message), { code });

export function validateSkillArchiveURL(source) {
  let target;
  try { target = new URL(source); } catch { throw fail("SKILL_URL_INVALID", "Use a public HTTPS ZIP URL."); }
  if (target.protocol !== "https:" || target.username || target.password || target.hash || target.search) {
    throw fail("SKILL_URL_INVALID", "Use a public HTTPS ZIP URL without embedded credentials or query tokens.");
  }
  return target;
}

// Package storage is provider-neutral. Original source coordinates never point
// here: this is an immutable installation snapshot, not a checkout cache.
export class SkillPackageStorage {
  constructor({ root, maxBytes = 500 * 1024 * 1024, maxFiles = 20_000 }) {
    this.root = resolve(root);
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
  }

  async acquireSource(source) {
    const directory = join(this.root, "downloads", randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const archive = join(directory, "package.zip");
      await this.downloadArchive(source, archive);
      const extracted = join(directory, "extracted");
      await this.extractZipSafely(archive, extracted);
      return { root: extracted, cleanupRoot: directory };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async downloadArchive(source, destination) {
    const signal = AbortSignal.timeout(60_000);
    let target = validateSkillArchiveURL(source);
    for (let redirects = 0; redirects <= 3; redirects++) {
      validateSkillArchiveURL(target.href);
      const address = await pinnedMcpAddress(target);
      if (!allowedMcpAddress(address.address, "public-download")) throw fail("SKILL_URL_ADDRESS_DENIED", "Skill URL must resolve to a public address.");
      const response = await new Promise((resolveResponse, reject) => {
        const request = https.get(target, { signal, agent: false, autoSelectFamily: false,
          headers: { Accept: "application/zip, application/octet-stream" },
          lookup: (_host, _options, callback) => callback(null, address.address, address.family)
        }, resolveResponse);
        request.on("error", reject);
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.destroy();
        if (!location || redirects === 3) throw fail("SKILL_URL_REDIRECT_LIMIT", "Skill download redirect limit exceeded.");
        target = new URL(location, target);
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw fail("SKILL_DOWNLOAD_FAILED", `Skill download returned HTTP ${response.statusCode}.`);
      }
      let output;
      try {
        output = await open(destination, "wx", 0o600);
        let total = 0;
        for await (const chunk of response) {
          total += chunk.length;
          if (total > 100 * 1024 * 1024) throw fail("PACKAGE_LIMIT_EXCEEDED", "Skill archive exceeds 100 MiB.");
          await output.writeFile(chunk);
        }
        await output.sync();
      } finally { response.destroy(); await output?.close(); }
      return;
    }
  }

  async extractZipSafely(archive, destination) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const zip = await new Promise((resolveZip, reject) => yauzl.open(archive,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, value) => error ? reject(error) : resolveZip(value)));
    let files = 0;
    let bytes = 0;
    const names = new Set();
    try {
      await new Promise((resolveZip, reject) => {
        zip.on("error", reject);
        zip.on("end", resolveZip);
        zip.on("entry", (entry) => {
          void (async () => {
            const name = entry.fileName;
            const normalized = name.normalize("NFC").toLowerCase().replace(/\/$/, "");
            const parts = name.replace(/\/$/, "").split("/");
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (!name || parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))
              || name.includes("\\") || name.startsWith("/") || parts.length > 64
              || names.has(normalized) || ![0, 0o100000, 0o040000].includes(mode)
              || entry.generalPurposeBitFlag & 1) throw fail("SKILL_ARCHIVE_UNSAFE", "ZIP contains an unsafe, duplicate, encrypted or special entry.");
            names.add(normalized);
            if (++files > this.maxFiles || (bytes += entry.uncompressedSize) > this.maxBytes) throw fail("PACKAGE_LIMIT_EXCEEDED", "Extracted Skill package exceeds limits.");
            const target = join(destination, ...parts);
            if (name.endsWith("/")) { await mkdir(target, { recursive: true, mode: 0o700 }); return; }
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            const stream = await new Promise((resolveStream, rejectStream) => zip.openReadStream(entry,
              (error, value) => error ? rejectStream(error) : resolveStream(value)));
            const file = await open(target, "wx", 0o600 | ((entry.externalFileAttributes >>> 16) & 0o111));
            try {
              let actual = 0;
              for await (const chunk of stream) {
                actual += chunk.length;
                if (actual > entry.uncompressedSize) throw fail("SKILL_ARCHIVE_UNSAFE", "ZIP entry size mismatch.");
                await file.writeFile(chunk);
              }
            } finally { stream.destroy(); await file.close(); }
          })().then(() => zip.readEntry(), reject);
        });
        zip.readEntry();
      });
    } finally { zip.close(); }
  }

  async #walk(root, copyTo = null) {
    const canonical = await realpath(root);
    const hash = createHash("sha256").update("corptie-skill-package-v1\0");
    let bytes = 0;
    let files = 0;
    let entries = 0;
    const visit = async (path, rel, parents = new Set()) => {
      if (rel && ++entries > this.maxFiles) throw fail("PACKAGE_LIMIT_EXCEEDED", "Skill package exceeds entry limit.");
      const resolved = await realpath(path);
      const inside = relative(canonical, resolved);
      if (inside === ".." || inside.startsWith(`..${sep}`)) throw fail("PACKAGE_RESOURCE_OUTSIDE_ROOT", `Package link escapes root: ${rel}`);
      const info = await lstat(resolved);
      if (info.isDirectory()) {
        if (parents.size > 64) throw fail("PACKAGE_LIMIT_EXCEEDED", "Skill package directory nesting exceeds limit.");
        if (parents.has(resolved)) throw fail("PACKAGE_LINK_CYCLE", `Package link cycle: ${rel}`);
        const nextParents = new Set([...parents, resolved]);
        if (copyTo) await mkdir(join(copyTo, rel), { recursive: true, mode: 0o700 });
        hash.update(JSON.stringify(["directory", rel]) + "\n");
        const entries = (await readdir(resolved)).sort();
        for (const name of entries) {
          if (excluded.has(name)) continue;
          if (sensitive.test(name) && ![".env.example", ".env.sample", ".env.template"].includes(name)) {
            throw fail("PACKAGE_CREDENTIAL_FILE", `Potential credential file requires review: ${join(rel, name)}`);
          }
          await visit(join(resolved, name), join(rel, name), nextParents);
        }
        return;
      }
      if (!info.isFile()) throw fail("PACKAGE_FILE_TYPE_UNSUPPORTED", `Unsupported package entry: ${rel}`);
      if (++files > this.maxFiles || (bytes += info.size) > this.maxBytes) throw fail("PACKAGE_LIMIT_EXCEEDED", "Skill package exceeds file or byte limit.");
      const executable = info.mode & 0o111;
      hash.update(JSON.stringify(["file", rel, info.size, executable]) + "\n");
      const input = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      let output;
      try {
        const before = await input.stat();
        if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) throw fail("PACKAGE_SOURCE_CHANGED", `Source changed: ${rel}`);
        if (copyTo) {
          await mkdir(dirname(join(copyTo, rel)), { recursive: true, mode: 0o700 });
          output = await open(join(copyTo, rel), "wx", 0o600 | executable);
        }
        let count = 0;
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          count += chunk.length;
          if (count > info.size) throw fail("PACKAGE_SOURCE_CHANGED", `Source changed: ${rel}`);
          hash.update(chunk);
          if (output) await output.writeFile(chunk);
        }
        const after = await input.stat();
        if (count !== info.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail("PACKAGE_SOURCE_CHANGED", `Source changed: ${rel}`);
        if (output) await output.sync();
      } finally {
        await output?.close();
        await input.close();
      }
      if (copyTo) await chmod(join(copyTo, rel), 0o600 | executable);
      hash.update("\0");
    };
    await visit(canonical, "");
    return { packageHash: hash.digest("hex"), fileCount: files, byteCount: bytes };
  }

  async stagePackage({ packageRoot, skillRoot }) {
    const canonical = await realpath(packageRoot);
    const selected = await realpath(skillRoot);
    const skillSubpath = relative(canonical, selected);
    if (skillSubpath === ".." || skillSubpath.startsWith(`..${sep}`)) throw fail("PACKAGE_RESOURCE_OUTSIDE_ROOT", "Skill entry escapes package.");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const storageRoot = await realpath(this.root);
    const storageRel = relative(canonical, storageRoot);
    if (!storageRel || (storageRel !== ".." && !storageRel.startsWith(`..${sep}`))) {
      throw fail("PACKAGE_DESTINATION_INVALID", "Managed package storage cannot be inside the source package.");
    }
    const revisionId = randomUUID();
    const temporary = join(this.root, "staging", revisionId);
    const destination = join(this.root, "installed", revisionId, "package");
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    try {
      const copied = await this.#walk(canonical, temporary);
      const [sourceAfter, copyAfter] = await Promise.all([this.#walk(canonical), this.#walk(temporary)]);
      if (sourceAfter.packageHash !== copied.packageHash || copyAfter.packageHash !== copied.packageHash) throw fail("PACKAGE_SOURCE_CHANGED", "Skill package changed while preparing its snapshot.");
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await rename(temporary, destination);
      return { managedPackagePath: destination, managedSkillSubpath: skillSubpath,
        packageRevision: revisionId, ...copied };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async inspectStagedPackage(path) {
    const canonical = await realpath(path);
    const root = await realpath(join(this.root, "installed"));
    const rel = relative(root, canonical);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw fail("PACKAGE_RESOURCE_OUTSIDE_ROOT", "Managed package is outside installation storage.");
    return this.#walk(canonical);
  }
}
