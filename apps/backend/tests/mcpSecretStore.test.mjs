import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpSecretStore } from "../src/application/mcpSecretStore.mjs";
const account = 'mcp:00000000-0000-4000-8000-000000000001:1';
const second = 'mcp:00000000-0000-4000-8000-000000000002:1';
async function fixture(run) {
 const root = await mkdtemp(join(tmpdir(), 'mcp-files-test-'));
 try { await run(root); } finally { await rm(root, {recursive:true, force:true}); }
}
test('file secrets persist before completion, isolate roots and retain independent updates', async () => fixture(async root => {
 const store = createMcpSecretStore({dataRoot:root, native:new Proxy({}, {get(){assert.fail('must not load Keychain');}})});
 await store.initialize();
 await Promise.all([store.put(account,{headers:{Authorization:'synthetic'}}),store.put(second,{env:{TOKEN:'other'}})]);
 const reopened = createMcpSecretStore({dataRoot:root});await reopened.initialize();
 assert.deepEqual(reopened.get(account),{headers:{Authorization:'synthetic'}});
 assert.deepEqual(reopened.get(second),{env:{TOKEN:'other'}});
 const copy=store.get(account);copy.headers.Authorization='changed';assert.equal(store.get(account).headers.Authorization,'synthetic');
 assert.equal((await stat(join(root,'security','mcp-secrets.v1.json'))).mode & 0o777, 0o600);
 assert.equal((await stat(join(root,'security'))).mode & 0o777, 0o700);
 await assert.rejects(store.put(account,{headers:{Authorization:'overwrite'}}),{code:'MCP_CREDENTIAL_STORAGE_CONFLICT'});
 await store.delete(account);const third=createMcpSecretStore({dataRoot:root});await third.initialize();assert.equal(third.get(account),null);
 const isolated=createMcpSecretStore({dataRoot:join(root,'other')});await isolated.initialize();assert.equal(isolated.get(second),null);
}));
test('corrupt files never become an empty store and symlinks cannot redirect reads', async () => fixture(async root => {
 const first=createMcpSecretStore({dataRoot:root});await first.initialize();
 const path=join(root,'security','mcp-secrets.v1.json');await writeFile(path,'broken');
 const broken=createMcpSecretStore({dataRoot:root});await assert.rejects(broken.initialize());
 await assert.rejects(broken.put(account,{headers:{Authorization:'synthetic'}}));assert.equal(await readFile(path,'utf8'),'broken');
 await rm(path);const target=join(root,'unchanged');await writeFile(target,'unchanged');await symlink(target,path);
 const link=createMcpSecretStore({dataRoot:root});await assert.rejects(link.initialize());assert.equal(await readFile(target,'utf8'),'unchanged');
}));
test('preview secrets never touch the filesystem and invalid values are redacted', async () => fixture(async root => {
 const store=createMcpSecretStore({dataRoot:join(root,'never-created'),ephemeral:true});await store.initialize();
 await store.put(account,{headers:{Authorization:'synthetic'}});
 await assert.rejects(stat(join(root,'never-created')),{code:'ENOENT'});
 assert.throws(()=>store.put('bad',{headers:{Authorization:'synthetic'}}),e=>!e.message.includes('synthetic'));
 assert.throws(()=>store.put(account,{headers:{Authorization:'line\nbreak'}}));
}));
