import { messageImageGeometry } from "./messageImageGeometry.mjs";

const unsupported = () => Object.assign(new Error("This image preview is unsupported."),
  { code: "MESSAGE_IMAGE_FORMAT_UNSUPPORTED", statusCode: 415 });

/** Never send executable SVG to a client image view. Legacy screenshot Artifacts
 * wrapped one PNG in an SVG; extract only that exact inert wrapper, without XML
 * entities, external references, scripts, styles or a general SVG interpreter.
 */
export function messageImageBytes(bytes, mimeType) {
  if (mimeType === "image/svg+xml") {
    const text = bytes.toString("utf8");
    const match = text.match(/^\s*<svg\s+xmlns="http:\/\/www\.w3\.org\/2000\/svg"\s+width="[0-9.]+"\s+height="[0-9.]+"\s+viewBox="[0-9. ]+"\s*>\s*<image\s+width="[0-9.]+"\s+height="[0-9.]+"\s+href="data:image\/png;base64,([A-Za-z0-9+/]+={0,2})"\s*\/?>\s*(?:<\/image>\s*)?<\/svg>\s*$/);
    if (!match) throw unsupported();
    bytes = Buffer.from(match[1], "base64");
    if (bytes.toString("base64") !== match[1]) throw unsupported();
    mimeType = "image/png";
  }
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  const webp = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  const heic = bytes.subarray(4, 8).toString() === "ftyp"
    && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(bytes.subarray(8, 12).toString());
  if (!({ "image/png": png, "image/jpeg": jpeg, "image/gif": gif, "image/webp": webp, "image/heic": heic })[mimeType]) throw unsupported();
  const geometry = messageImageGeometry(bytes);
  // Bound raster cost before the client decoder sees a compressed image.
  if (geometry.pixelWidth && geometry.pixelHeight && geometry.pixelWidth * geometry.pixelHeight > 100_000_000) throw unsupported();
  return { data: bytes, mimeType, byteLength: bytes.length, ...geometry };
}
