/** Application-owned rollout; wire requests never select these switches.
 * Preview snapshots may show the new rail, but remain non-executable. */
export function detailMigrationConfiguration({ developmentPreview }) {
  if (typeof developmentPreview !== "boolean") throw new TypeError("DETAIL_PREVIEW_CONFIGURATION_REQUIRED");
  return Object.freeze({ richReadEnabled: true, richNativeEditorsEnabled: true,
    richWritesEnabled: !developmentPreview, detailWritesAllowed: !developmentPreview });
}
