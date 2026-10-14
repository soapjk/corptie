/** Application-owned rollout; wire requests never select these switches.
 * Preview snapshots may show the new rail, but remain non-executable. */
import { parseDetailWebCards } from "./detailWebPresentation.mjs";

export function detailMigrationConfiguration({ developmentPreview, webCardIDs = [] }) {
  if (typeof developmentPreview !== "boolean") throw new TypeError("DETAIL_PREVIEW_CONFIGURATION_REQUIRED");
  const selected = parseDetailWebCards(webCardIDs);
  return Object.freeze({ richReadEnabled: true, richNativeEditorsEnabled: true,
    richWritesEnabled: !developmentPreview, detailWritesAllowed: !developmentPreview,
    ...(selected.length ? { webCardIDs: Object.freeze(selected) } : {}) });
}
