import { DETAIL_COMPONENTS_PROFILE_2, DETAIL_NATIVE_COMPONENTS } from "../../src/application/detailPresentationCatalog.mjs";
import { detailV2TemplateID } from "../../src/application/detailV2Catalog.mjs";
import { detailV2Hash, detailV2StateHash, diffDetailV2 } from "../../src/application/detailSyncV2.mjs";

export const presentationProfile = { catalog: DETAIL_COMPONENTS_PROFILE_2, clientCapabilities: [...DETAIL_NATIVE_COMPONENTS] };
export function rehashPresentation(state) {
  const templates = {};
  for (const cardID of state.manifest.order) {
    const ref = state.manifest.cards[cardID], template = state.templates[ref.templateHash];
    const { templateId, ...structure } = template;
    template.templateId = detailV2TemplateID(structure);
    const hash = detailV2Hash(template); templates[hash] = template;
    ref.templateHash = hash; ref.templateId = template.templateId;
    const instance = state.instances[cardID];
    instance.hash = detailV2Hash({ fields: instance.fields, collections: instance.collections, actions: instance.actions });
  }
  state.templates = templates;
  state.manifest.hash = detailV2Hash({ cards: state.manifest.cards, order: state.manifest.order });
  state.stateHash = detailV2StateHash(state); return state;
}
export function presentationFixture() {
  const string = maxLength => ({ type: "string", required: true, maxLength });
  const structure = { templateVersion: 1, catalogProfile: presentationProfile.catalog,
    requiredCapabilities: ["detail.button", "detail.markdown", "detail.resourceList"],
    fieldSchema: { title: string(512), preview: string(512), body: string(16000),
      webData: { type: "object", required: true, properties: { headline: string(512) } } },
    collectionSchema: { resources: { maxItems: 20, itemSchema: { resourceType: string(512), id: string(512),
      title: string(512), preview: string(512), body: string(16000), metadata: string(512) } } },
    card: { title: { fallback: "Presentation" }, titleBinding: "title", semanticKind: "information", rootNodeId: "root",
      render: { kind: "native" }, fallback: { fallback: "Unavailable" }, nodes: [
        { id: "root", kind: "column", props: {}, children: ["section", "resources", "manage"] },
        { id: "section", kind: "disclosure", props: { label: { fallback: "Description" }, previewBinding: "preview", initiallyExpanded: false }, children: ["body"] },
        { id: "body", kind: "detail.markdown", binding: "body", props: {}, children: [] },
        { id: "resources", kind: "detail.resourceList", props: { collection: "resources", presentation: "disclosure",
          itemBindings: { preview: "preview", body: "body", metadata: "metadata" } }, children: [] },
        { id: "manage", kind: "detail.button", props: { actionId: "manage", presentationRole: "primary" }, children: [] }
      ] } };
  const template = { ...structure, templateId: detailV2TemplateID(structure) }, hash = detailV2Hash(template);
  const instance = title => ({ revision: 1, hash: "", fields: { title, preview: "Compact preview", body: "Complete body", webData: { headline: title } },
    collections: { resources: { revision: 1, order: ["memory:1"], nextCursor: null,
      items: { "memory:1": { resourceType: "memory", id: "memory:1", title: "Preference", preview: "A preview", body: "Full memory", metadata: "Trusted" } } } },
    actions: { manage: { id: "manage", kind: "navigation", operation: "editor.open", label: { fallback: "Manage" }, available: true, target: { resourceType: "task", id: "task:1" } } } });
  const snapshot = rehashPresentation({ protocolVersion: 2, documentId: "detail:fixture", sessionId: "session:fixture", generation: "presentation:1",
    revision: 1, stateHash: "", manifest: { revision: 1, hash: "", order: ["a", "b"],
      cards: { a: { templateId: template.templateId, templateHash: hash }, b: { templateId: template.templateId, templateHash: hash } } },
    templates: { [hash]: template }, instances: { a: instance("Task"), b: instance("Unchanged") } });
  const expectedState = structuredClone(snapshot);
  expectedState.revision = 2; expectedState.instances.a.revision = 2;
  expectedState.instances.a.fields.body = "Updated complete body";
  expectedState.instances.a.collections.resources.revision = 2;
  expectedState.instances.a.collections.resources.items["memory:1"].body = "Updated full memory";
  rehashPresentation(expectedState);
  return { profile: presentationProfile, snapshot, commit: diffDetailV2(snapshot, expectedState, presentationProfile), expectedState };
}
