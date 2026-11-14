import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { BUILTIN_ROLE_AVATAR_IDS, BUILTIN_ROLE_AVATAR_PREFIX, builtinRoleAvatarId, defaultRoleAvatarReference, validateRoleAvatarReference } from "../src/domain/builtinRoleAvatar.mjs";

test("built-in avatar references are versioned, validated, and stable across clients", () => {
  assert.equal(new Set(BUILTIN_ROLE_AVATAR_IDS).size, 6);
  assert.equal(defaultRoleAvatarReference("assistant"), BUILTIN_ROLE_AVATAR_PREFIX + "cartoon-dog");
  assert.equal(defaultRoleAvatarReference("a"), BUILTIN_ROLE_AVATAR_PREFIX + "ink-boy");
  for (let index = 1; index <= 16; index++) {
    const reference = BUILTIN_ROLE_AVATAR_PREFIX + `robot-${String(index).padStart(2, "0")}`;
    assert.ok(BUILTIN_ROLE_AVATAR_IDS.includes(builtinRoleAvatarId(reference)));
    assert.equal(validateRoleAvatarReference(reference), reference, "stored aliases remain valid without rewriting");
  }
  for (const id of BUILTIN_ROLE_AVATAR_IDS) {
    assert.equal(builtinRoleAvatarId(BUILTIN_ROLE_AVATAR_PREFIX + id), id);
  }
  assert.equal(builtinRoleAvatarId(BUILTIN_ROLE_AVATAR_PREFIX + "robot-17"), null);
  assert.throws(() => validateRoleAvatarReference(BUILTIN_ROLE_AVATAR_PREFIX + "../unknown"), { code: "INVALID_INPUT" });
  assert.equal(validateRoleAvatarReference("/tmp/upload.png"), "/tmp/upload.png");
});

test("random and selected avatar references persist across store restart and idempotent replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-role-avatar-store-"));
  const options = { dbPath: join(directory, "store.sqlite"), configPath: join(directory, "config.json"), manageProcessEnvironment: false };
  let store = new CorptieStore(options);
  try {
    await store.initialize({ resolveDataPath: false });
    const request = { idempotencyKey: "avatar-once", requestHash: "avatar-hash", requestId: "avatar-request" };
    const created = store.createRoleWithRegistrySkillsIdempotently({ name: "Avatar" }, [], request);
    assert.ok(builtinRoleAvatarId(created.role.avatarPath));
    const selected = store.createRole({ name: "Selected", avatarPath: BUILTIN_ROLE_AVATAR_PREFIX + "cartoon-dog" });
    const uploaded = store.createRole({ name: "Uploaded", avatarPath: "/tmp/existing-custom.png" });
    await store.close();
    store = new CorptieStore(options);
    await store.initialize({ resolveDataPath: false });
    assert.equal(store.getRole(created.role.roleId).avatarPath, created.role.avatarPath);
    assert.equal(store.getRole(selected.roleId).avatarPath, selected.avatarPath);
    assert.equal(store.getRole(uploaded.roleId).avatarPath, uploaded.avatarPath);
    const replay = store.createRoleWithRegistrySkillsIdempotently({ name: "Avatar" }, [], request);
    assert.equal(replay.replayed, true);
    assert.equal(replay.role.avatarPath, created.role.avatarPath);
    assert.equal(replay.role.roleId, created.role.roleId);
    store.db.run("UPDATE agents SET avatar_path=NULL WHERE agent_id=?", [selected.roleId]);
    const revision = store.stateRevision();
    assert.equal(store.getRole(selected.roleId).avatarPath, defaultRoleAvatarReference(selected.roleId));
    assert.equal(store.getRole(selected.roleId).avatarPath, store.listRoles().find(item => item.roleId === selected.roleId).avatarPath);
    assert.equal(store.selectOne("SELECT avatar_path FROM agents WHERE agent_id=?", [selected.roleId]).avatar_path, null);
    assert.equal(store.stateRevision(), revision, "legacy display must not write the DB");
    assert.equal(store.updateRole(uploaded.roleId, { name: "Renamed" }).avatarPath, "/tmp/existing-custom.png");
    assert.equal(store.updateRole(uploaded.roleId, { avatarPath: null }).avatarPath, defaultRoleAvatarReference(uploaded.roleId));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
