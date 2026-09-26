import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SceneApplicationService } from "../src/scenes/sceneApplicationService.mjs";
import { callSceneDynamicTool, sceneDynamicTools } from "../src/scenes/sceneDynamicTools.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("scene Tool Host domain only exposes bound scenes and commits exact previews", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-scene-tools-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"), configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.upsertSession({ id: "session:bound", title: "Bound", agent: "Codex",
      provider: "codex-app-server", status: "complete" });
    store.upsertSession({ id: "session:other", title: "Other", agent: "Codex",
      provider: "codex-app-server", status: "complete" });
    const service = new SceneApplicationService({ store });
    service.createScene({ instanceId: "scene:bound", templateId: "daily-checklist", name: "Bound", timezone: "UTC" });
    service.createScene({ instanceId: "scene:hidden", templateId: "daily-checklist", name: "Hidden", timezone: "UTC" });
    service.bindSession("scene:bound", "session:bound");

    assert.deepEqual(sceneDynamicTools.map((tool) => tool.name), [
      "corptie_scene_list", "corptie_scene_read_view",
      "corptie_scene_preview_command", "corptie_scene_commit_preview"
    ]);
    const context = { metadata: { sessionId: "session:bound" } };
    const listed = callSceneDynamicTool(service, { ...context, tool: "corptie_scene_list", arguments: {} });
    assert.deepEqual(listed.scenes.map((scene) => scene.instanceId), ["scene:bound"]);
    assert.throws(() => callSceneDynamicTool(service, { ...context,
      tool: "corptie_scene_read_view", arguments: { instance_id: "scene:hidden", view_id: "checklist" }
    }), { code: "SCENE_ACCESS_DENIED" });

    const preview = callSceneDynamicTool(service, { ...context,
      tool: "corptie_scene_preview_command", arguments: {
        instance_id: "scene:bound", command: "createRecord", payload: {
          recordId: "list:tool", recordType: "List", data: { title: "Tool", archived: false }
        }
      }
    });
    assert.equal(service.getRecord("scene:bound", "list:tool"), null);
    const committed = callSceneDynamicTool(service, { ...context,
      tool: "corptie_scene_commit_preview", arguments: {
        preview_token: preview.previewToken, idempotency_key: "tool-commit"
      }
    });
    assert.equal(committed.instanceRevision, 1);
    assert.equal(service.getRecord("scene:bound", "list:tool").data.title, "Tool");
  } finally {
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
