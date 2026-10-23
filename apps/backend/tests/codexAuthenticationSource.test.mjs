import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  codexKeychainAccount, readCodexAuthenticationSource, readCodexKeychainCredential
} from "../src/runtime/codexAuthenticationSource.mjs";

async function fixture(run) {
  const home = await mkdtemp(join(tmpdir(), "codex-auth-source-test-"));
  const authPath = join(home, "auth.json");
  try { await run({ home, authPath }); }
  finally { await rm(home, { recursive: true, force: true }); }
}
const fileAuth = JSON.stringify({ OPENAI_API_KEY: "test-file-key" });
const keychainAuth = JSON.stringify({ tokens: { access_token: "test-keychain-token" } });

test("file authentication works without reading Keychain or importing native configuration", async () => {
  await fixture(async ({ home, authPath }) => {
    await writeFile(authPath, fileAuth);
    const nativeConfig = '# User settings\nmodel = "native-model"\n';
    await writeFile(join(home, "config.toml"), nativeConfig);
    const auth = await readCodexAuthenticationSource(authPath, {
      platform: "darwin", allowKeychainRead: true, readKeychainCredential: () => assert.fail("unexpected Keychain access")
    });
    assert.equal(auth.source, "copied");
    assert.deepEqual(JSON.parse(auth.content), JSON.parse(fileAuth));
    assert.equal(await readFile(join(home, "config.toml"), "utf8"), nativeConfig);
    assert.equal(await readFile(authPath, "utf8"), fileAuth);
  });
});

for (const preference of ["keyring", "auto"]) {
  test(`${preference} uses Keychain instead of a stale auth.json`, async () => {
    await fixture(async ({ home, authPath }) => {
      await writeFile(authPath, fileAuth);
      await writeFile(join(home, "config.toml"), `cli_auth_credentials_store = '${preference}' # login\n`);
      const auth = await readCodexAuthenticationSource(authPath, {
        platform: "darwin", allowKeychainRead: true, readKeychainCredential: async ({ service, account }) => {
          assert.equal(service, "Codex Auth");
          assert.equal(account, await codexKeychainAccount(home));
          return keychainAuth;
        }
      });
      assert.equal(auth.source, "keychain");
      assert.deepEqual(JSON.parse(auth.content), JSON.parse(keychainAuth));
      assert.equal(await readFile(authPath, "utf8"), fileAuth);
    });
  });
}

test("missing file authentication reuses an existing Keychain login", async () => {
  await fixture(async ({ authPath }) => {
    const auth = await readCodexAuthenticationSource(authPath, {
      platform: "darwin", allowKeychainRead: true, readKeychainCredential: async () => keychainAuth
    });
    assert.equal(auth.source, "keychain");
  });
});

test("unavailable Keychain falls back to existing file authentication", async () => {
  await fixture(async ({ home, authPath }) => {
    await writeFile(authPath, fileAuth);
    await writeFile(join(home, "config.toml"), 'cli_auth_credentials_store = "auto"\n');
    const auth = await readCodexAuthenticationSource(authPath, {
      platform: "darwin", allowKeychainRead: true, readKeychainCredential: async () => { throw new Error("secret diagnostic"); }
    });
    assert.equal(auth.source, "copied");
  });
});

test("explicit keyring selection never falls back to a stale file account", async () => {
  await fixture(async ({ home, authPath }) => {
    await writeFile(authPath, fileAuth);
    await writeFile(join(home, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    await assert.rejects(readCodexAuthenticationSource(authPath, {
      platform: "darwin", allowKeychainRead: true, readKeychainCredential: async () => { throw new Error("access denied"); }
    }), /钥匙串/);
    assert.equal(await readCodexAuthenticationSource(authPath, {
      platform: "darwin", allowKeychainRead: true, readKeychainCredential: async () => null
    }), null);
  });
});

test("empty authentication files do not mark an unauthenticated installation as logged in", async () => {
  await fixture(async ({ authPath }) => {
    await writeFile(authPath, '{}\n');
    assert.equal(await readCodexAuthenticationSource(authPath, {
      platform: "darwin", allowKeychainRead: true, readKeychainCredential: async () => null
    }), null);
    assert.equal((await readCodexAuthenticationSource(authPath, {
      platform: "darwin", allowKeychainRead: true, readKeychainCredential: async () => keychainAuth
    })).source, "keychain");
  });
});

test("explicit file and ephemeral selection cannot import a residual Keychain login", async () => {
  await fixture(async ({ home, authPath }) => {
    for (const preference of ["file", "ephemeral"]) {
      await writeFile(join(home, "config.toml"), `cli_auth_credentials_store = "${preference}"\n`);
      assert.equal(await readCodexAuthenticationSource(authPath, {
        platform: "darwin", allowKeychainRead: true, readKeychainCredential: () => assert.fail("unexpected residual Keychain login")
      }), null);
    }
  });
});

test("table-scoped settings do not switch the native account", async () => {
  await fixture(async ({ home, authPath }) => {
    await writeFile(authPath, fileAuth);
    await writeFile(join(home, "config.toml"), '[profiles.other]\ncli_auth_credentials_store = "keyring"\n');
    const auth = await readCodexAuthenticationSource(authPath, {
      platform: "darwin", allowKeychainRead: true, readKeychainCredential: () => assert.fail("unexpected Keychain access")
    });
    assert.equal(auth.source, "copied");
  });
});

test("Keychain account follows Codex's canonical-home hash including symlinks", async () => {
  await fixture(async ({ home }) => {
    const nativeHome = join(home, "native");
    await mkdir(nativeHome);
    const alias = join(home, "alias");
    await symlink(nativeHome, alias);
    const expected = `cli|${createHash("sha256").update(await realpath(nativeHome)).digest("hex").slice(0, 16)}`;
    assert.equal(await codexKeychainAccount(alias), expected);
    assert.equal(await codexKeychainAccount(nativeHome), expected);
  });
});

test("missing login returns null and unsupported hosts never invoke macOS security", async () => {
  await fixture(async ({ authPath }) => {
    assert.equal(await readCodexAuthenticationSource(authPath, {
      platform: "darwin", allowKeychainRead: true, readKeychainCredential: async () => null
    }), null);
    assert.equal(await readCodexAuthenticationSource(authPath, {
      platform: "linux", readKeychainCredential: () => assert.fail("unexpected macOS command")
    }), null);
  });
});

test("invalid credential JSON and Keychain diagnostics never leak credential material", async () => {
  await fixture(async ({ authPath }) => {
    for (const reader of [async () => "test-secret-invalid-json", async () => {
      throw Object.assign(new Error("test-secret"), { stdout: "test-secret" });
    }]) {
      await assert.rejects(readCodexAuthenticationSource(authPath, {
        platform: "darwin", allowKeychainRead: true, readKeychainCredential: reader
      }), error => !error.message.includes("test-secret") && error.cause == null);
    }
  });
});

test("security lookup targets only the exact Codex service and account without a shell", async () => {
  const result = await readCodexKeychainCredential({ service: "Codex Auth", account: "cli|abc" }, async (command, args, options) => {
    assert.equal(command, "/usr/bin/security");
    assert.deepEqual(args, ["find-generic-password", "-s", "Codex Auth", "-a", "cli|abc", "-w"]);
    assert.equal(options.timeout, 10_000);
    assert.equal(options.maxBuffer, 256 * 1024);
    return { stdout: keychainAuth };
  });
  assert.equal(result, keychainAuth);
  assert.equal(await readCodexKeychainCredential({ service: "Codex Auth", account: "cli|abc" }, async () => {
    throw Object.assign(new Error("not found"), { code: 44 });
  }), null);
  await assert.rejects(readCodexKeychainCredential({ service: "Codex Auth", account: "cli|abc" }, async () => {
    throw Object.assign(new Error("test-secret"), { code: 36, stdout: "test-secret" });
  }), error => !error.message.includes("test-secret") && error.cause == null);
});


test("default import never probes the system store and keyring needs explicit consent", async () => {
  await fixture(async ({home, authPath}) => {
    let calls=0;
    assert.equal(await readCodexAuthenticationSource(authPath,{platform:"darwin",readKeychainCredential:()=>{calls++;}}),null);
    await writeFile(join(home,"config.toml"),'cli_auth_credentials_store = "keyring"\n');
    await assert.rejects(readCodexAuthenticationSource(authPath,{platform:"darwin",readKeychainCredential:()=>{calls++;}}),
      {code:"PROVIDER_AUTH_IMPORT_REQUIRES_CONFIRMATION"});
    assert.equal(calls,0);
  });
});
