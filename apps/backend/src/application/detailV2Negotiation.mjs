import { detailV2Hash } from "./detailSyncV2.mjs";
import { DETAIL_COMPONENTS_PROFILE_1, DETAIL_NATIVE_COMPONENTS, DETAIL_PRESENTATION_PROFILES,
  detailPresentationCapabilities } from "./detailPresentationCatalog.mjs";

export const DETAIL_COMPONENTS_CATALOG = DETAIL_COMPONENTS_PROFILE_1;
// Keep rich routes closed until the scoped service and strict schema are
// integrated and accepted together; recognizing a header is not enablement.
export const DETAIL_TRANSPORT_CATALOGS = Object.freeze(["native-v2"]);
export const DETAIL_REGISTERED_CAPABILITIES = new Set(DETAIL_NATIVE_COMPONENTS);
const reject = () => { throw Object.assign(new Error("DETAIL_CAPABILITIES_INVALID"), { code: "DETAIL_CAPABILITIES_INVALID", status: 400, statusCode: 400 }); };

/** Transport normalization only; authority and schema stay in their services. */
export function detailV2Negotiation(catalog, clientCapabilities) {
  if (catalog === "native-v2") {
    if (clientCapabilities !== undefined) reject();
    return { catalog, clientCapabilities: [], capabilityDigest: detailV2Hash([]) };
  }
  const registered = detailPresentationCapabilities(catalog);
  if (!registered || !Array.isArray(clientCapabilities) || clientCapabilities.length > 32) reject();
  for (let index = 0; index < clientCapabilities.length; index++) {
    const token = clientCapabilities[index];
    if (typeof token !== "string" || token.length > 64 || !/^[\x21-\x7e]+$/.test(token) ||
        !registered.includes(token) || (index > 0 && clientCapabilities[index - 1] >= token)) reject();
  }
  return { catalog, clientCapabilities: [...clientCapabilities], capabilityDigest: detailV2Hash(clientCapabilities) };
}

export function detailV2GetNegotiation(request) {
  if (request.headers.accept === "application/json; corptie-detail=native-v2") return detailV2Negotiation("native-v2");
  const catalog = DETAIL_PRESENTATION_PROFILES.find(profile => request.headers.accept === `application/json; corptie-detail=${profile}`);
  if (!catalog) return null;
  const header = request.headers["x-corptie-detail-capabilities"];
  if (typeof header !== "string" || header.length > 2048) reject();
  const tokens = header === "" ? [] : header.split(",").map(token => token.trim());
  return detailV2Negotiation(catalog, tokens);
}

export function detailV2ServiceOptions(identity, negotiation) {
  // The authoritative digest is computed by the service, never supplied as
  // trusted input from the transport or a client's request fields.
  return { identity, catalog: negotiation.catalog, clientCapabilities: [...negotiation.clientCapabilities] };
}

/** Pin trusted HTTP authority while optional compression yields. Scope must
 * perform Session permission checks, not merely parse the requested ID. */
export function detailV2PinnedAuthenticate(authenticate, scope, identity, canonicalSessionId) {
  const invalid = code => { throw Object.assign(new Error(code), { code, status: 403, statusCode: 403 }); };
  const authority = value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.then === "function" ||
        (!value.principalId && !value.deviceId)) invalid("DETAIL_IDENTITY_INVALID");
    return ["serverId", "accountId", "principalId", "deviceId"].map(name => {
      const field = value[name];
      if (field != null && (typeof field !== "string" || !field.length || field.length > 512)) invalid("DETAIL_IDENTITY_INVALID");
      return field ?? null;
    });
  };
  const pinned = authority(identity);
  return () => {
    const current = authenticate(), next = authority(current);
    if (next.some((value, index) => value !== pinned[index]) || scope(current) !== canonicalSessionId) invalid("DETAIL_SCOPE_CHANGED");
    return current;
  };
}
