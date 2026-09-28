import { join } from "node:path";
import { ProjectCodeSearchApplicationService } from "../project-code/projectCodeApplicationService.mjs";
import { ProjectCodeIndexStore } from "../project-code/projectCodeIndexStore.mjs";
import { ProjectCodeSearchService } from "../project-code/projectCodeSearchService.mjs";
import { ProjectCodeSourceRevisionMonitor } from "../project-code/projectCodeSourceRevisionMonitor.mjs";
import { ProjectCodeRunIsolationPort } from "../project-code/projectCodeRunIsolationPort.mjs";
import { RepositorySourceSnapshotBuilder } from "../project-code/projectCodeSnapshot.mjs";
import { ProjectCodeStartupReceiptRepository } from "../project-code/projectCodeStartupReceiptRepository.mjs";
import { createProjectToolsetProductionComposition } from "./projectToolsetProductionComposition.mjs";
import { disabledProjectToolsetInitializer } from "./projectToolsetAuthority.mjs";

export function createProjectCodeProductionComposition({
  store, runIsolationCoordinator, backgroundAgentService,
  environmentName, emitEvent
}) {
  const projectCodeStartupReceipts = new ProjectCodeStartupReceiptRepository({ store });
  const snapshotBuilder = new RepositorySourceSnapshotBuilder();
  const projectCodeIndexStore = new ProjectCodeIndexStore({
    dataRoot: join(store.dataRoot, "project-code-index")
  });
  const projectCodeFreshnessMonitor = new ProjectCodeSourceRevisionMonitor();
  void projectCodeIndexStore.initialize().catch((error) => {
    console.warn(`[project-code] index store unavailable: ${error?.code ?? "DATA_ROOT_UNAVAILABLE"}`);
  });
  const projectCodeRunIsolationPort = runIsolationCoordinator
    ? new ProjectCodeRunIsolationPort({
        coordinator: runIsolationCoordinator,
        capabilities: {
          localSemantic: true,
          networkAccess: false,
          languages: [
            "swift", "work-c", "work-cpp", "javascript", "typescript", "python", "rust",
            "go", "java", "kotlin", "c", "cpp", "json", "markdown", "text"
          ]
        }
      })
    : null;
  const searchService = new ProjectCodeSearchService({
    snapshotBuilder,
    indexStore: projectCodeIndexStore,
    runIsolationPort: projectCodeRunIsolationPort,
    nonBlockingIndexWarmup: true
  });
  let projectToolsetProduction = null;
  const projectCodeApplicationService = new ProjectCodeSearchApplicationService({
    store,
    startupReceipts: projectCodeStartupReceipts,
    snapshotBuilder,
    searchService,
    freshnessMonitor: projectCodeFreshnessMonitor,
    toolsetReceipts: {
      require: ({ receiptId }) => projectToolsetProduction?.resolveToolsetReceipt(receiptId) ?? null
    }
  });
  let projectToolsetInitializer;
  let runAuthorityResolver = null;
  if (runIsolationCoordinator) {
    projectToolsetProduction = createProjectToolsetProductionComposition({
      store,
      startupReceipts: projectCodeStartupReceipts,
      projectCodeApplicationService,
      runIsolationCoordinator,
      backgroundAgentService,
      dataRoot: store.dataRoot,
      environment: environmentName,
      onEvent: (type, payload) => emitEvent(type, payload)
    });
    projectToolsetInitializer = projectToolsetProduction.initializer;
    runAuthorityResolver = projectToolsetProduction.runAuthorityResolver;
  } else {
    projectToolsetInitializer = disabledProjectToolsetInitializer();
  }
  return {
    projectCodeStartupReceipts, projectCodeIndexStore,
    projectCodeFreshnessMonitor, projectCodeRunIsolationPort,
    projectCodeApplicationService, projectToolsetProduction,
    projectToolsetInitializer, runAuthorityResolver
  };
}
