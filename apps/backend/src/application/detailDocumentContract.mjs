import { readFileSync } from "node:fs";
import Ajv from "ajv";

export const DETAIL_CATALOG_PROFILE = "native-v1";
export const DETAIL_COMPONENT_KINDS = Object.freeze(["column", "row", "section", "text", "markdown", "divider", "disclosure"]);
export const detailSchema = JSON.parse(readFileSync(new URL("../contracts/detail-v1.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: false });
ajv.addSchema(detailSchema);
const validators = Object.fromEntries(["Document", "Patch", "ActionRequest"].map(kind =>
  [kind, ajv.compile({ $ref: `${detailSchema.$id}#/definitions/${kind}` })]));
const invalid = () => Object.assign(new Error("Invalid Detail contract"), { code: "DETAIL_CONTRACT_INVALID", status: 400 });
export function validateDetailContract(value, kind) {
  if (!validators[kind]?.(value) || Buffer.byteLength(JSON.stringify(value)) > (kind === "ActionRequest" ? 64 : 256) * 1024) throw invalid();
  if (kind === "Document") {
    const ids = value.cards.map(card => card.id);
    if (new Set(ids).size !== ids.length || ids.length !== value.order.length || value.order.some(id => !ids.includes(id)) ||
        value.cards.reduce((n, card) => n + card.nodes.length, 0) > 500) throw invalid();
  }
  if (kind === "Patch" && (value.revision <= value.baseRevision ||
      new Set(value.upsertCards.map(card => card.id)).size !== value.upsertCards.length ||
      value.upsertCards.some(card => value.removeCardIds.includes(card.id)))) throw invalid();
  for (const card of value.cards ?? value.upsertCards ?? []) {
    if (new Set(card.actions.map(action => action.id)).size !== card.actions.length) throw invalid();
    const nodes = new Map(card.nodes.map(node => [node.id, node]));
    if (nodes.size !== card.nodes.length || !nodes.has(card.rootNodeId)) throw invalid();
    const seen = new Set();
    const walk = (id, depth) => {
      const node = nodes.get(id);
      if (!node || seen.has(id) || depth > 6) throw invalid();
      seen.add(id);
      if (DETAIL_COMPONENT_KINDS.includes(node.kind) && node.props.actionId && !card.actions.some(action => action.id === node.props.actionId)) throw invalid();
      for (const child of node.children) walk(child, depth + 1);
    };
    walk(card.rootNodeId, 1);
    if (seen.size !== nodes.size) throw invalid();
  }
  return value;
}
