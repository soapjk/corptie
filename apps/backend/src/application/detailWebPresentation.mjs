// Host-selected, bundled renderer. This is not a remote HTML/plugin loader.
export const DETAIL_WEB_RENDERER = Object.freeze({ rendererId: "detail.sections.v1", rendererVersion: 1,
  assetHash: "sha256:c858c8f7d8993429a2090d11662bf41ea5259888105da8d1ce254614edf8563f", bridgeVersion: 1 });
export const DETAIL_WEB_CARD_IDS = Object.freeze(["task-information", "work-overview"]);
export function parseDetailWebCards(value) {
  if (value == null || value === "") return [];
  const ids = typeof value === "string" ? value.split(",").map(v => v.trim()).sort() : value;
  if (!Array.isArray(ids) || ids.length > 2 || new Set(ids).size !== ids.length || ids.some(id => !DETAIL_WEB_CARD_IDS.includes(id))) {
    throw new TypeError("DETAIL_WEB_CARDS_INVALID");
  }
  return [...ids];
}
export function selectWebPresentation(card) {
  const source = card.id === "task-information"
    ? [["description", "描述"], ["acceptanceCriteria", "验收标准"], ["verificationCriteria", "验证标准"]]
    : [["body", "概述"]];
  const sections = source.map(([id, title]) => ({ id, title, body: card.fields[id] ?? "",
    preview: card.fields[id + "Preview"] ?? Array.from(String(card.fields[id] ?? "").replace(/\s+/g, " ")).slice(0, 400).join("") }));
  const string = maxLength => ({ type: "string", required: true, maxLength });
  const structure = { templateVersion: 1, catalogProfile: card.template.catalogProfile,
    requiredCapabilities: ["detail.web", ...(Object.keys(card.actions ?? {}).length ? ["detail.button"] : [])].sort(),
    fieldSchema: { title: string(512), state: string(1024), webData: { type: "object", required: true, properties: {
      sections: { type: "array", required: true, maxItems: 20, items: { type: "object", required: true,
        properties: { id: string(512), title: string(512), body: string(65536), preview: string(512) } } }
    } } }, collectionSchema: {},
    card: { title: card.template.card.title, titleBinding: "title", semanticKind: card.template.card.semanticKind,
      fallback: card.template.card.fallback, rootNodeId: "root",
      render: { kind: "web", ...DETAIL_WEB_RENDERER, dataBinding: "webData" },
      nodes: [{ id: "root", kind: "column", props: {}, children: [] }] } };
  card.fields = { title: card.fields.title, state: card.fields.state, webData: { sections } };
  return structure;
}
