export const ARTIFACT_DOMAIN_ID = "artifacts";

export class ArtifactDomainRequirements {
  static forSessionRole({ sessionKind, roleCapabilities = [], taskContract = null } = {}) {
    const canManage = roleCapabilities.includes("artifact:manage")
      || roleCapabilities.includes("work:manage_artifacts");
    if (sessionKind === "worker") {
      return Object.freeze({
        requiredBeforeFirstTurn: Object.freeze([Object.freeze({
          domainId: ARTIFACT_DOMAIN_ID,
          minimumDomainVersion: 2,
          reason: taskContract?.artifactDeliveryRequired === false
            ? "Worker Artifact evidence and pinned-reference reads"
            : "Worker Task delivery contract requires Artifact tools"
        })]),
        onDemandDomains: Object.freeze([])
      });
    }
    if (sessionKind === "workChat" && canManage) {
      return Object.freeze({
        requiredBeforeFirstTurn: Object.freeze([]),
        onDemandDomains: Object.freeze([Object.freeze({
          domainId: ARTIFACT_DOMAIN_ID,
          minimumDomainVersion: 2,
          reason: "Work Artifact management requested through Tool Host search/load"
        })])
      });
    }
    return Object.freeze({ requiredBeforeFirstTurn: Object.freeze([]), onDemandDomains: Object.freeze([]) });
  }
}
