import { messageResourceLinks } from "./messageResources.mjs";

const unavailable = () => Object.assign(new Error("Message image is unavailable."),
  { code: "MESSAGE_IMAGE_UNAVAILABLE", statusCode: 404 });

/** An authored Markdown image reference is the provider-neutral delivery intent.
 * Tool inspection alone never grants a reply attachment. No filesystem paths or
 * provider-specific heuristics are used to associate an image with a reply.
 */
export async function readDeliveredMessageImage({ store, artifacts, reference, itemId, destination, readImage }) {
  if (typeof destination !== "string" || destination.length > 4096
      || typeof itemId !== "string" || itemId.length > 512) throw unavailable();
  const sessionId = reference.sessionId ?? reference.logicalSessionId;
  const item = store.getSessionItem(sessionId, itemId);
  if (!item || !["agentMessage", "userMessage"].includes(item.type)
      || !messageResourceLinks(item.text).includes(destination)) throw unavailable();
  if (destination.startsWith("corptie-image:")) {
    const sourceID = destination.slice("corptie-image:".length);
    const source = store.getSessionItem(sessionId, sourceID);
    let metadata;
    try { metadata = JSON.parse(source?.rawMetadataJSON ?? "{}"); } catch { throw unavailable(); }
    const images = source?.images ?? metadata.images;
    if (!Array.isArray(images) || images.length !== 1 || !images[0]?.managedPath) throw unavailable();
    const resource = await readImage(images[0].managedPath);
    return { ...resource, fileName: images[0].fileName ?? "image" };
  }
  let url;
  try { url = new URL(destination); } catch { throw unavailable(); }
  if (url.protocol !== "artifact:" || url.hash || url.host
      || [...url.searchParams.keys()].some(key => !["version", "hash"].includes(key) || url.searchParams.getAll(key).length !== 1)) throw unavailable();
  const artifactId = `artifact:${url.pathname}`;
  if (!/^artifact:[A-Za-z0-9:_-]+$/.test(artifactId)) throw unavailable();
  const requestedVersion = url.searchParams.get("version"), hash = url.searchParams.get("hash");
  if ((requestedVersion == null) !== (hash == null)
      || (requestedVersion != null && (!/^[1-9][0-9]*$/.test(requestedVersion)
        || !Number.isSafeInteger(Number(requestedVersion)) || !/^[a-f0-9]{64}$/.test(hash)))) throw unavailable();
  const session = reference.metadata?.session ?? store.getSession(sessionId);
  if (!session || !artifacts) throw unavailable();
  return artifacts.readMessageImage({ session, sessionId, artifactId,
    version: requestedVersion == null ? null : Number(requestedVersion), contentHash: hash,
    messageCreatedAt: item.createdAt });
}
