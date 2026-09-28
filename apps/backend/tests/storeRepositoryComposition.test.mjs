import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { createStoreRepositories } from "../src/store/createStoreRepositories.mjs";
import { storeRepositoryDelegateMap } from "../src/store/storeRepositoryDelegates.mjs";

test("Store facade preserves every repository delegate as a live method", () => {
  const store = new CorptieStore({ manageProcessEnvironment: false });
  const sentinel = Object.freeze({ delegated: true });
  for (const [repositoryKey, methods] of Object.entries(storeRepositoryDelegateMap)) {
    const repository = store[repositoryKey];
    assert.ok(repository, `missing repository ${repositoryKey}`);
    for (const method of methods) {
      assert.equal(typeof repository[method], "function", `${repositoryKey}.${method}`);
      const original = repository[method];
      const args = ["first", "second"];
      repository[method] = (...actual) => {
        assert.deepEqual(actual, args, `${repositoryKey}.${method} arguments`);
        return sentinel;
      };
      try {
        assert.equal(store[method](...args), sentinel, `Store.${method}`);
      } finally {
        repository[method] = original;
      }
    }
  }
});

test("repository composition is lazy and all connection consumers follow replacement", () => {
  let database = null;
  let sshWorkspaces = null;
  let reads = 0;
  const repositories = createStoreRepositories({
    getDatabase: () => { reads += 1; return database; },
    getSshWorkspaces: () => sshWorkspaces,
    environmentName: "test",
    ports: {},
    bound: {}
  });
  assert.equal(reads, 0, "composition must not acquire a connection");
  assert.equal(Object.keys(repositories).length, 34);
  const connectionConsumers = Object.values(repositories).filter((repository) => repository.getDatabase);
  assert.ok(connectionConsumers.length > 20);
  for (const next of [{ id: "original" }, { id: "replacement" }, null]) {
    database = next;
    for (const repository of connectionConsumers) assert.equal(repository.db, next);
  }
  sshWorkspaces = { id: "first" };
  assert.equal(repositories.workspaceRepository.getSshWorkspaces(), sshWorkspaces);
  sshWorkspaces = { id: "replacement" };
  assert.equal(repositories.workspaceRepository.getSshWorkspaces(), sshWorkspaces);
});

test("Store composition preserves live ports and previously captured callbacks", () => {
  class InstrumentedStore extends CorptieStore {
    selectOne(...args) { return { receiver: this, source: "captured", args }; }
  }
  const store = new InstrumentedStore({ manageProcessEnvironment: false });
  store.selectOne = function (...args) { return { receiver: this, source: "live", args }; };
  const args = ["SELECT fixture", ["session"]];
  assert.deepEqual(store.sessionCapabilityRepository.selectOne(...args), {
    receiver: store, source: "live", args
  });
  assert.deepEqual(store.feishuRepository.selectOne(...args), {
    receiver: store, source: "captured", args
  });
  assert.equal(store.db, null);
});

test("recovery and workspace transition share the live tool-catalog insertion bridge", () => {
  const store = new CorptieStore({ manageProcessEnvironment: false });
  const calls = [];
  const receipt = { id: "catalog-receipt" };
  store.sessionToolCatalogRepository.insertAppliedSessionToolCatalogMaterialization = (...args) => {
    calls.push(args);
    return receipt;
  };
  const input = { logicalSessionId: "logical-session", catalog: [] };
  assert.equal(store.sessionRecoveryRepository.insertAppliedSessionToolCatalogMaterialization(input), receipt);
  const options = { createdAt: "2026-09-27T00:00:00.000Z" };
  assert.equal(store.workspaceTransitionRepository.insertAppliedSessionToolCatalogMaterialization(input, options), receipt);
  assert.deepEqual(calls, [[input, {}], [input, options]]);
});
