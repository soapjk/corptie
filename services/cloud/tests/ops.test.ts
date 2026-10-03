import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cloudDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const control = join(cloudDirectory, "ops", "cloudctl.sh");

function environment(root: string, databasePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CORPTIE_CLOUD_ROOT: root,
    CORPTIE_CLOUD_DATABASE_PATH: databasePath,
    CORPTIE_CLOUD_SKIP_SERVICE: "1"
  };
}

test("deployment templates are locally valid", () => {
  const output = execFileSync("sh", [control, "validate-templates"], {
    cwd: cloudDirectory,
    encoding: "utf8"
  });
  assert.match(output, /templates are valid/);
});

test("runtime installation pins a verified Node 24 executable", {
  skip: !process.env.CORPTIE_TEST_NODE24
}, () => {
  const root = mkdtempSync("/private/tmp/corptie-cloud-ops-");
  try {
    const env = environment(root, join(root, "shared", "data", "cloud.sqlite"));
    const output = execFileSync("sh", [control, "install-runtime", process.env.CORPTIE_TEST_NODE24!], {
      cwd: cloudDirectory, env, encoding: "utf8"
    });
    assert.match(output, /^installed Node 24\./);
    const installed = join(root, "shared", "runtime", "node");
    assert.equal(execFileSync(installed, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8" }).trim(), "24");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configuration validator uses the production schema and refuses loose permissions", () => {
  const root = mkdtempSync("/private/tmp/corptie-cloud-ops-");
  try {
    const config = join(root, "cloud.env");
    let content = readFileSync(join(cloudDirectory, "ops", "cloud.env.example"), "utf8");
    content = content.replace(
      "/Volumes/T9/data/corptie-cloud/shared/data/cloud.sqlite",
      join(root, "shared", "data", "cloud.sqlite")
    );
    writeFileSync(config, content, { mode: 0o600 });
    const env = { ...environment(root, join(root, "shared", "data", "cloud.sqlite")), CORPTIE_CLOUD_CONFIG: config };
    const accepted = execFileSync("sh", [control, "validate-config"], { cwd: cloudDirectory, env, encoding: "utf8" });
    assert.match(accepted, /configuration shape is valid/);

    chmodSync(config, 0o644);
    const rejected = spawnSync("sh", [control, "validate-config"], { cwd: cloudDirectory, env, encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /permissions must be 0600/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup and explicitly confirmed restore preserve a consistent SQLite snapshot", () => {
  const root = mkdtempSync("/private/tmp/corptie-cloud-ops-");
  const database = join(root, "shared", "data", "cloud.sqlite");
  try {
    execFileSync("mkdir", ["-p", join(root, "shared", "data")]);
    execFileSync("sqlite3", [database, "CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('before');"]);
    const env = environment(root, database);
    const backup = execFileSync("sh", [control, "backup", "test"], {
      cwd: cloudDirectory, env, encoding: "utf8"
    }).trim();
    assert.equal(readFileSync(`${backup}.sha256`, "utf8").includes("cloud-test.sqlite"), true);

    execFileSync("sqlite3", [database, "UPDATE sample SET value = 'after';"]);
    const refused = spawnSync("sh", [control, "restore", backup], { cwd: cloudDirectory, env, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    execFileSync("sh", [control, "restore", backup, "--confirm-data-loss"], { cwd: cloudDirectory, env });
    const value = execFileSync("sqlite3", [database, "SELECT value FROM sample;"], { encoding: "utf8" }).trim();
    assert.equal(value, "before");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled backup path creates a checksummed encrypted secondary-volume copy", () => {
  const root = mkdtempSync("/private/tmp/corptie-cloud-ops-");
  const secondary = mkdtempSync("/private/tmp/corptie-cloud-secondary-");
  const database = join(root, "shared", "data", "cloud.sqlite");
  const key = join(secondary, "backup.key");
  try {
    execFileSync("mkdir", ["-p", join(root, "shared", "data")]);
    execFileSync("sqlite3", [database, "CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('encrypted');"]);
    writeFileSync(key, "test-only-backup-key-with-sufficient-entropy", { mode: 0o600 });
    const env = {
      ...environment(root, database),
      CORPTIE_CLOUD_SECONDARY_BACKUP_DIR: secondary,
      CORPTIE_CLOUD_BACKUP_KEY_FILE: key,
      CORPTIE_CLOUD_ALLOW_SAME_DEVICE_BACKUP: "1"
    };
    const encrypted = execFileSync("sh", [control, "backup-and-copy", "encrypted-test"], {
      cwd: cloudDirectory, env, encoding: "utf8"
    }).trim();
    assert.equal(encrypted, join(secondary, "cloud-encrypted-test.sqlite.enc"));
    assert.equal(readFileSync(`${encrypted}.sha256`, "utf8").includes("cloud-encrypted-test.sqlite.enc"), true);
    const decrypted = join(root, "decrypted.sqlite");
    execFileSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-md", "sha256",
      "-pass", `file:${key}`, "-in", encrypted, "-out", decrypted]);
    assert.equal(execFileSync("sqlite3", [decrypted, "SELECT value FROM sample;"], { encoding: "utf8" }).trim(), "encrypted");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(secondary, { recursive: true, force: true });
  }
});

test("scheduled backups retain fourteen daily and four weekly copies on both volumes", () => {
  const root = mkdtempSync("/private/tmp/corptie-cloud-ops-");
  const secondary = mkdtempSync("/private/tmp/corptie-cloud-secondary-");
  const database = join(root, "shared", "data", "cloud.sqlite");
  const backups = join(root, "shared", "backups");
  const key = join(secondary, "backup.key");
  try {
    execFileSync("mkdir", ["-p", join(root, "shared", "data"), backups]);
    execFileSync("sqlite3", [database, "CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('retained');"]);
    writeFileSync(key, "test-only-backup-key-with-sufficient-entropy", { mode: 0o600 });
    for (let index = 1; index <= 15; index += 1) {
      const suffix = String(index).padStart(2, "0");
      writeFileSync(join(backups, `cloud-daily-202501${suffix}T000000Z.sqlite`), "old");
      writeFileSync(join(secondary, `cloud-daily-202501${suffix}T000000Z.sqlite.enc`), "old");
    }
    for (let index = 1; index <= 5; index += 1) {
      const suffix = String(index).padStart(2, "0");
      writeFileSync(join(backups, `cloud-weekly-202501${suffix}T000000Z.sqlite`), "old");
      writeFileSync(join(secondary, `cloud-weekly-202501${suffix}T000000Z.sqlite.enc`), "old");
    }
    const env = {
      ...environment(root, database),
      CORPTIE_CLOUD_SECONDARY_BACKUP_DIR: secondary,
      CORPTIE_CLOUD_BACKUP_KEY_FILE: key,
      CORPTIE_CLOUD_ALLOW_SAME_DEVICE_BACKUP: "1"
    };
    execFileSync("sh", [control, "backup-and-copy"], { cwd: cloudDirectory, env });
    const localFiles = readdirSync(backups);
    const secondaryFiles = readdirSync(secondary);
    assert.equal(localFiles.filter((name) => /^cloud-daily-.*\.sqlite$/.test(name)).length, 14);
    assert.equal(localFiles.filter((name) => /^cloud-weekly-.*\.sqlite$/.test(name)).length, 4);
    assert.equal(secondaryFiles.filter((name) => /^cloud-daily-.*\.sqlite\.enc$/.test(name)).length, 14);
    assert.equal(secondaryFiles.filter((name) => /^cloud-weekly-.*\.sqlite\.enc$/.test(name)).length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(secondary, { recursive: true, force: true });
  }
});
