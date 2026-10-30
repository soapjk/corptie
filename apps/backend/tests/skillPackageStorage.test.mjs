import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillPackageStorage, validateSkillArchiveURL } from "../src/application/skillPackageStorage.mjs";

// Minimal stored ZIP fixture, including deliberately unsafe names/types that
// ordinary archive creators sanitize. No executable helpers or network needed.
function zipFixture(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, text = "instructions", mode = 0o100600 } of entries) {
    const filename = Buffer.from(name), data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28); record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42); central.push(record, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test("ZIP acquisition preserves complete package and rejects unsafe archives", async (t) => {
  const { root, storage } = await fixture(t);
  const archive = join(root, "fixture.zip");
  await writeFile(archive, zipFixture([{ name: "bundle/SKILL.md" }, { name: "bundle/scripts/run.sh", text: "exit 0", mode: 0o100700 }]));
  const extracted = join(root, "extracted");
  await storage.extractZipSafely(archive, extracted);
  const snapshot = await storage.stagePackage({ packageRoot: join(extracted, "bundle"), skillRoot: join(extracted, "bundle") });
  assert.equal(await readFile(join(snapshot.managedPackagePath, "scripts/run.sh"), "utf8"), "exit 0");
  const cases = [
    [{ name: "../escape" }], [{ name: "/absolute" }], [{ name: "a\\b" }],
    [{ name: "link", mode: 0o120777 }], [{ name: "pipe", mode: 0o010600 }],
    [{ name: "SKILL.md" }, { name: "skill.md" }], [{ name: "x/../escape" }]
  ];
  for (const [index, entries] of cases.entries()) {
    await writeFile(archive, zipFixture(entries));
    await assert.rejects(storage.extractZipSafely(archive, join(root, `unsafe-${index}`)));
  }
  await writeFile(archive, zipFixture([{ name: "large", text: "123" }]));
  const limited = new SkillPackageStorage({ root: storage.root, maxBytes: 2 });
  await assert.rejects(limited.extractZipSafely(archive, join(root, "oversized")), { code: "PACKAGE_LIMIT_EXCEEDED" });
});

test("URL validation rejects credentials and non-HTTPS before fetching", async (t) => {
  const { root, storage } = await fixture(t);
  for (const source of ["invalid", "file:///tmp/x.zip", "http://example.com/x.zip", "https://user:secret@example.com/a.zip", "https://example.com/a.zip?token=secret", "https://example.com/a.zip#secret"]) {
    assert.throws(() => validateSkillArchiveURL(source), { code: "SKILL_URL_INVALID" });
  }
  await assert.rejects(storage.downloadArchive("https://127.0.0.1/a.zip", join(root, "download.zip")), { code: "SKILL_URL_ADDRESS_DENIED" });
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "corptie-package-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "instructions");
  return { root, source, storage: new SkillPackageStorage({ root: join(root, "managed"), ...options }) };
}

test("managed snapshot is independent, hashes scripts and executable permission, and preserves nested entry", async (t) => {
  const { source, storage } = await fixture(t);
  await mkdir(join(source, "skills", "one"), { recursive: true });
  await writeFile(join(source, "skills", "one", "SKILL.md"), "nested");
  await writeFile(join(source, "server.sh"), "exit 0");
  const input = { packageRoot: source, skillRoot: join(source, "skills", "one") };
  const first = await storage.stagePackage(input);
  assert.equal(first.managedSkillSubpath, "skills/one");
  assert.equal((await storage.stagePackage(input)).packageHash, first.packageHash);
  await chmod(join(source, "server.sh"), 0o700);
  assert.notEqual((await storage.stagePackage(input)).packageHash, first.packageHash);
  await writeFile(join(source, "server.sh"), "exit 1");
  assert.notEqual((await storage.stagePackage(input)).packageHash, first.packageHash);
  await rm(source, { recursive: true });
  assert.equal(await readFile(join(first.managedPackagePath, "server.sh"), "utf8"), "exit 0");
  assert.equal((await storage.inspectStagedPackage(first.managedPackagePath)).packageHash, first.packageHash);
});

test("internal links become independent files, external links and cycles are rejected", async (t) => {
  const { root, source, storage } = await fixture(t);
  await symlink("SKILL.md", join(source, "alias.md"));
  const result = await storage.stagePackage({ packageRoot: source, skillRoot: source });
  assert.equal(await readFile(join(result.managedPackagePath, "alias.md"), "utf8"), "instructions");
  await writeFile(join(root, "secret"), "secret");
  await symlink("../secret", join(source, "escape"));
  await assert.rejects(storage.stagePackage({ packageRoot: source, skillRoot: source }), { code: "PACKAGE_RESOURCE_OUTSIDE_ROOT" });
  await rm(join(source, "escape"));
  await symlink(".", join(source, "loop"));
  await assert.rejects(storage.stagePackage({ packageRoot: source, skillRoot: source }), { code: "PACKAGE_LINK_CYCLE" });
});

test("credential files, size limits, and storage inside source fail closed", async (t) => {
  const { source, storage } = await fixture(t);
  await writeFile(join(source, ".env"), "TOKEN=secret");
  await assert.rejects(storage.stagePackage({ packageRoot: source, skillRoot: source }), { code: "PACKAGE_CREDENTIAL_FILE" });
  await rm(join(source, ".env"));
  const limited = new SkillPackageStorage({ root: storage.root, maxBytes: 2 });
  await assert.rejects(limited.stagePackage({ packageRoot: source, skillRoot: source }), { code: "PACKAGE_LIMIT_EXCEEDED" });
  const nested = new SkillPackageStorage({ root: join(source, "managed") });
  await assert.rejects(nested.stagePackage({ packageRoot: source, skillRoot: source }), { code: "PACKAGE_DESTINATION_INVALID" });
});
