import { detailV2Hash, canonicalDetailV2 } from "./detailSyncV2.mjs";
import { validateDetailContract, DETAIL_COMPONENT_KINDS } from "./detailDocumentContract.mjs";
import { DETAIL_COMPONENTS_PROFILE_1, DETAIL_COMPONENTS_PROFILE_2, DETAIL_NATIVE_COMPONENTS,
  detailPresentationCapabilities } from "./detailPresentationCatalog.mjs";

export const DETAIL_COMPONENTS_CATALOG = DETAIL_COMPONENTS_PROFILE_1;
export const DETAIL_COMPONENT_CAPABILITIES = DETAIL_NATIVE_COMPONENTS;
const invalid = () => { throw Object.assign(new Error("DETAIL_V2_CATALOG"), { code: "DETAIL_V2_CATALOG", status: 400 }); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const token = value => typeof value === "string" && /^[\x20-\x7e]{1,512}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 1;
const keys = (value, allowed, required = []) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
};
const text = value => {
  keys(value, ["fallback", "key", "parameters"], ["fallback"]);
  if (typeof value.fallback !== "string" || [...value.fallback].length > 4096 ||
      (value.key !== undefined && (typeof value.key !== "string" || [...value.key].length > 256))) invalid();
  if (value.parameters !== undefined && (!object(value.parameters) || Object.keys(value.parameters).length > 16 ||
      Object.values(value.parameters).some(v => typeof v !== "string" || [...v].length > 1024))) invalid();
};
function wireKeys(value, depth = 0) {
  if (depth > 32) invalid();
  if (object(value)) {
    if (!Object.keys(value).every(token)) invalid();
    Object.values(value).forEach(v => wireKeys(v, depth + 1));
  } else if (Array.isArray(value)) value.forEach(v => wireKeys(v, depth + 1));
}
export function detailV2CatalogOptions({ catalog = "native-v2", clientCapabilities } = {}) {
  if (catalog === "native-v2") {
    if (clientCapabilities !== undefined && (!Array.isArray(clientCapabilities) || clientCapabilities.length)) invalid();
    return { catalog, clientCapabilities: [] };
  }
  const registered = detailPresentationCapabilities(catalog);
  if (!registered || !Array.isArray(clientCapabilities) || clientCapabilities.length > registered.length ||
      clientCapabilities.some((v, i) => !registered.includes(v) || (i && clientCapabilities[i - 1] >= v))) invalid();
  return { catalog, clientCapabilities: [...clientCapabilities] };
}
export function detailV2TemplateID(structure) {
  if (!object(structure) || Object.hasOwn(structure, "templateId") || !/^[A-Za-z0-9_-]{1,64}$/.test(structure.card?.semanticKind ?? "")) invalid();
  return `native:${structure.card.semanticKind}:${detailV2Hash(structure).slice(7)}`;
}
export function validateDetailV2FieldMap(schema, values, depth = 0, schemaOnly = false) {
  if (depth > 32 || !object(schema) || Object.keys(schema).length > 64 || !Object.keys(schema).every(token) ||
      (!schemaOnly && (!object(values) || Object.keys(values).some(key => !Object.hasOwn(schema, key))))) invalid();
  for (const [name, field] of Object.entries(schema)) validateDetailV2Field(field,
    schemaOnly || !Object.hasOwn(values, name) ? undefined : values[name], depth + 1, schemaOnly);
}
export function validateDetailV2Field(schema, value, depth = 0, schemaOnly = false) {
  if (depth > 32 || !object(schema) || typeof schema.required !== "boolean") invalid();
  const allowed = { string: ["type", "required", "maxLength"], bool: ["type", "required"], integer: ["type", "required"],
    object: ["type", "required", "properties"], array: ["type", "required", "items", "maxItems"] }[schema.type];
  if (!allowed) invalid();
  keys(schema, allowed, ["type", "required"]);
  if (schema.maxLength !== undefined && (!revision(schema.maxLength) || schema.maxLength > 65536)) invalid();
  if (schema.type === "object") validateDetailV2FieldMap(schema.properties, undefined, depth + 1, true);
  if (schema.type === "array") {
    if (!revision(schema.maxItems) || schema.maxItems > 20) invalid();
    validateDetailV2Field(schema.items, undefined, depth + 1, true);
  }
  if (schemaOnly) return;
  if (value === undefined) { if (schema.required) invalid(); return; }
  switch (schema.type) {
    case "string": if (typeof value !== "string" || [...value].length > (schema.maxLength ?? 4096)) invalid(); break;
    case "bool": if (typeof value !== "boolean") invalid(); break;
    case "integer": if (!Number.isSafeInteger(value)) invalid(); break;
    case "object": validateDetailV2FieldMap(schema.properties, value, depth + 1); break;
    case "array":
      if (!Array.isArray(value) || value.length > schema.maxItems) invalid();
      value.forEach(item => validateDetailV2Field(schema.items, item, depth + 1)); break;
  }
}
function component(node, template, instance) {
  const props = node.props;
  const presentation = template.catalogProfile === DETAIL_COMPONENTS_PROFILE_2;
  const allowed = {
    "detail.keyValue": ["label"], "detail.image": ["label"], "detail.progress": ["label"],
    "detail.status": ["semantic"], "detail.dateTime": ["format"], "detail.resourceList": ["collection", "actionId", ...(presentation ? ["presentation", "itemBindings", "presentationRole"] : [])],
    "detail.button": ["actionId", ...(presentation ? ["presentationRole"] : [])], "detail.form": ["actionId", "controls"], "detail.markdown": [], "detail.chart": []
  }[node.kind];
  keys(props, allowed);
  if (props.presentationRole !== undefined && !["primary", "link", "secondary", "destructive"].includes(props.presentationRole)) invalid();
  if (props.label !== undefined) text(props.label);
  if (props.actionId !== undefined && (!token(props.actionId) || !Object.hasOwn(instance.actions, props.actionId))) invalid();
  if (node.kind === "detail.button") {
    if (!props.actionId || props.presentationRole !== undefined && !["primary", "link", "secondary", "destructive"].includes(props.presentationRole)) invalid();
    return;
  }
  if (node.kind === "detail.resourceList") {
    if (!token(props.collection) || !Object.hasOwn(template.collectionSchema, props.collection)) invalid();
    if (props.presentation !== undefined && !["plain", "disclosure"].includes(props.presentation)) invalid();
    if (props.presentation === "disclosure") {
      keys(props.itemBindings, ["preview", "body", "metadata"], ["preview", "body"]);
      const itemSchema = template.collectionSchema[props.collection].itemSchema;
      for (const binding of Object.values(props.itemBindings)) if (!token(binding) || itemSchema[binding]?.type !== "string") invalid();
    } else if (props.itemBindings !== undefined) invalid();
    for (const item of Object.values(Object.hasOwn(instance.collections, props.collection) ? instance.collections[props.collection].items : {})) {
      if (!token(item.resourceType) || !token(item.id) || typeof item.title !== "string" ||
          (item.actionId !== undefined && !Object.hasOwn(instance.actions, item.actionId))) invalid();
    }
    return;
  }
  if (node.kind === "detail.form") {
    if (!props.actionId || !Array.isArray(props.controls) || props.controls.length > 16 || new Set(props.controls.map(c => c.field)).size !== props.controls.length) invalid();
    for (const control of props.controls) {
      keys(control, ["field", "kind", "label", "options"], ["field", "kind", "label"]); text(control.label);
      const type = template.fieldSchema[control.field]?.type;
      if (control.kind === "text" || control.kind === "toggle") {
        if (type !== (control.kind === "text" ? "string" : "bool") || control.options !== undefined) invalid();
      } else if (control.kind === "picker") {
        if (type !== "string" || !Array.isArray(control.options) || control.options.length < 1 || control.options.length > 20 ||
            new Set(control.options.map(o => o.value)).size !== control.options.length) invalid();
        for (const option of control.options) { keys(option, ["value", "label"], ["value", "label"]); if (!token(option.value)) invalid(); text(option.label); }
        if (Object.hasOwn(instance.fields, control.field) && !control.options.some(o => o.value === instance.fields[control.field])) invalid();
      } else invalid();
    }
    return;
  }
  const binding = node.binding, schema = Object.hasOwn(template.fieldSchema, binding) ? template.fieldSchema[binding] : null;
  const value = Object.hasOwn(instance.fields, binding) ? instance.fields[binding] : undefined;
  if (!token(binding) || binding.includes(".") || !schema) invalid();
  if (node.kind === "detail.image") {
    if (schema.type !== "object" || (value !== undefined && (!token(value.resourceType) || !token(value.id)))) invalid();
  } else if (node.kind === "detail.progress") {
    if (schema.type !== "integer" || (value !== undefined && (value < 0 || value > 100))) invalid();
  } else {
    if (schema.type !== "string") invalid();
    if (node.kind === "detail.dateTime" && (!["date", "time", "dateTime"].includes(props.format ?? "dateTime") ||
        (value !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value) || value.length > 64 || !Number.isFinite(Date.parse(value)))))) invalid();
    if (node.kind === "detail.status" && !["neutral", "failure", "warning", "success", "retrying", "scheduled"].includes(props.semantic ?? "neutral")) invalid();
  }
}
export function validateDetailV2Components(template, instance, state, cardId, options) {
  wireKeys(template); wireKeys({ fields: instance.fields, actions: instance.actions, collections: instance.collections });
  keys(template, ["templateId", "templateVersion", "catalogProfile", "requiredCapabilities", "fieldSchema", "collectionSchema", "card"],
    ["templateId", "templateVersion", "catalogProfile", "requiredCapabilities", "fieldSchema", "collectionSchema", "card"]);
  const { templateId, ...structure } = template;
  if (templateId !== detailV2TemplateID(structure) || template.catalogProfile !== options.catalog || !detailPresentationCapabilities(template.catalogProfile) || !revision(template.templateVersion)) invalid();
  const capabilities = template.requiredCapabilities;
  detailV2CatalogOptions({ catalog: template.catalogProfile, clientCapabilities: capabilities });
  if (capabilities.some(c => !options.clientCapabilities.includes(c))) invalid();
  validateDetailV2FieldMap(template.fieldSchema, instance.fields);
  if (!object(template.collectionSchema) || Object.keys(template.collectionSchema).length > 64 || Object.keys(instance.collections).some(k => !Object.hasOwn(template.collectionSchema, k))) invalid();
  for (const [name, schema] of Object.entries(template.collectionSchema)) {
    keys(schema, ["maxItems", "itemSchema"], ["maxItems", "itemSchema"]);
    if (schema.maxItems !== 20) invalid(); validateDetailV2FieldMap(schema.itemSchema, undefined, 0, true);
    if (!Object.hasOwn(instance.collections, name)) continue;
    const page = instance.collections[name];
    keys(page, ["revision", "order", "items", "nextCursor"], ["revision", "order", "items", "nextCursor"]);
    if (!revision(page.revision) || !Array.isArray(page.order) || page.order.length > 20 || new Set(page.order).size !== page.order.length ||
        !object(page.items) || Object.keys(page.items).length !== page.order.length || page.order.some(id => !token(id) || !Object.hasOwn(page.items, id)) ||
        (page.nextCursor !== null && !token(page.nextCursor))) invalid();
    Object.values(page.items).forEach(item => validateDetailV2FieldMap(schema.itemSchema, item));
  }
  const card = template.card;
  const presentation = template.catalogProfile === DETAIL_COMPONENTS_PROFILE_2;
  keys(card, ["title", "titleBinding", "semanticKind", "rootNodeId", "nodes", "fallback", ...(presentation ? ["render"] : [])],
    ["title", "semanticKind", "rootNodeId", "nodes", "fallback", ...(presentation ? ["render"] : [])]);
  if (presentation) {
    if (card.render?.kind === "native") keys(card.render, ["kind"], ["kind"]);
    else if (card.render?.kind === "web") {
      keys(card.render, ["kind", "rendererId", "rendererVersion", "assetHash", "dataBinding", "bridgeVersion"],
        ["kind", "rendererId", "rendererVersion", "assetHash", "dataBinding", "bridgeVersion"]);
      if (!capabilities.includes("detail.web") || !token(card.render.rendererId) || !revision(card.render.rendererVersion)
        || typeof card.render.assetHash !== "string" || card.render.assetHash.length !== 71
        || !/^sha256:[0-9a-f]{64}$/.test(card.render.assetHash) || card.render.bridgeVersion !== 1
        || !token(card.render.dataBinding) || template.fieldSchema[card.render.dataBinding]?.type !== "object") invalid();
    } else invalid();
  }
  text(card.title); text(card.fallback);
  if (card.titleBinding !== undefined && template.fieldSchema[card.titleBinding]?.type !== "string") invalid();
  if (!Array.isArray(card.nodes)) invalid();
  const nodes = card.nodes.map(node => {
    keys(node, ["id", "kind", "props", "children", "binding"], ["id", "kind", "props", "children"]);
    if (!Array.isArray(node.children)) invalid();
    if (DETAIL_COMPONENT_CAPABILITIES.includes(node.kind)) {
      if (!capabilities.includes(node.kind) || node.children.length) invalid(); component(node, template, instance);
      // Reuse the frozen tree and action contract for graph checks; this
      // surrogate exists only in validation, never in a wire or render result.
      return { id: node.id, kind: "text", props: {}, children: [] };
    }
    if (!DETAIL_COMPONENT_KINDS.includes(node.kind)) invalid();
    const disclosure = presentation && node.kind === "disclosure";
    keys(node.props, ["text", "label", "semantic", "actionId", ...(disclosure ? ["previewBinding", "initiallyExpanded"] : [])]);
    for (const name of ["text", "label"]) if (node.props[name] !== undefined) text(node.props[name]);
    if (disclosure) {
      if (node.props.initiallyExpanded !== undefined && typeof node.props.initiallyExpanded !== "boolean") invalid();
      if (node.props.previewBinding !== undefined && (!token(node.props.previewBinding) || template.fieldSchema[node.props.previewBinding]?.type !== "string")) invalid();
      const { previewBinding, initiallyExpanded, ...props } = node.props;
      return { ...node, props };
    }
    return node;
  });
  const { titleBinding, render, ...definition } = card;
  validateDetailContract({ schemaVersion: 1, documentId: state.documentId, sessionId: state.sessionId, generation: state.generation,
    revision: state.revision, order: [cardId], cards: [{ ...definition, id: cardId, nodes, templateRevision: template.templateVersion,
      dataRevision: instance.hash, data: instance.fields, actions: Object.values(instance.actions) }] }, "Document");
}
export function validateDetailV2CollectionTransition(before, after) {
  for (const [name, next] of Object.entries(after)) {
    if (!Object.hasOwn(before, name)) continue;
    const old = before[name];
    const { revision: oldRevision, ...oldBody } = old, { revision: nextRevision, ...nextBody } = next;
    const unchanged = canonicalDetailV2(oldBody) === canonicalDetailV2(nextBody);
    if (unchanged ? nextRevision !== oldRevision : nextRevision <= oldRevision) invalid();
  }
}
