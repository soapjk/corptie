// Versioned presentation vocabulary only. No transport, hash, or host gates.
export const DETAIL_COMPONENTS_PROFILE_1 = "native-v2-components-1";
export const DETAIL_COMPONENTS_PROFILE_2 = "native-v2-components-2";
export const DETAIL_NATIVE_COMPONENTS = Object.freeze([
  "detail.button", "detail.chart", "detail.dateTime", "detail.form", "detail.image",
  "detail.keyValue", "detail.markdown", "detail.progress", "detail.resourceList", "detail.status"
]);
const profiles = Object.freeze({
  [DETAIL_COMPONENTS_PROFILE_1]: DETAIL_NATIVE_COMPONENTS,
  [DETAIL_COMPONENTS_PROFILE_2]: Object.freeze([...DETAIL_NATIVE_COMPONENTS, "detail.web"])
});
export const DETAIL_PRESENTATION_PROFILES = Object.freeze(Object.keys(profiles));
export const detailPresentationCapabilities = profile => Object.hasOwn(profiles, profile) ? profiles[profile] : null;
export const isDetailPresentationProfile = profile => detailPresentationCapabilities(profile) !== null;
