import { ArtifactDomainRequirements } from "./artifactDomainRequirements.mjs";

export const PROJECT_CODE_DOMAIN_ID = "project-code";

export function requiredToolDomainsForSession(context = {}, options = {}) {
  const required = ArtifactDomainRequirements
    .forSessionRole({
      sessionKind: context.sessionKind,
      roleCapabilities: context.roleCapabilities ?? []
    })
    .requiredBeforeFirstTurn.map((requirement) => requirement.domainId);
  if (options.projectCodeRecommendationEnabled === true && context.sessionKind === "worker") {
    required.push(PROJECT_CODE_DOMAIN_ID);
  }
  return Object.freeze([...new Set(required)].sort());
}
