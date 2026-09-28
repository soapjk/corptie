import { BenchmarkControlPlane } from "../benchmark/controlPlane.mjs";
import { createArtifactEvidencePort } from "../benchmark/ports.mjs";
import { createBenchmarkProductionPorts } from "../benchmark/productionPorts.mjs";
import { ProviderNeutralCodeTaskExecutionService } from "./providerNeutralCodeTaskExecutionService.mjs";

export function createBenchmarkControlPlaneComposition({
  store, artifactService, sessionApplicationService, turnObservability,
  runIsolationCoordinator, projectToolsetProduction,
  projectCodeStartupReceipts, projectCodeApplicationService
}) {
  const artifactEvidencePort = createArtifactEvidencePort(artifactService);
  const codeTaskExecution = new ProviderNeutralCodeTaskExecutionService({
    sessionService: sessionApplicationService,
    store,
    observabilityService: turnObservability
  });
  const ports = runIsolationCoordinator && projectToolsetProduction
    ? createBenchmarkProductionPorts({
      store,
      artifactEvidencePort,
      startupReceipts: projectCodeStartupReceipts,
      projectCodeApplicationService,
      projectToolsetProduction,
      runIsolationCoordinator,
      observabilityService: turnObservability,
      codeTaskExecutionService: codeTaskExecution
    })
    : { artifactEvidencePort };
  return new BenchmarkControlPlane({ store, ports });
}
