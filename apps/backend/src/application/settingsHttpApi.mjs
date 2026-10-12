import { resolve } from "node:path";
import { TaskCreationSettingsService } from "./taskCreationSettingsService.mjs";

export function handleSettingsReadHttpRequest({ request, response, url, store, developmentPreview, dataRootMigrationCoordinator, sendJson,
  agentProviderRegistry, sessionApplicationService, readJson }) {
  if (url.pathname === "/settings/task-creation" && ["GET", "PUT"].includes(request.method)) {
    const service = new TaskCreationSettingsService({ store, registry: agentProviderRegistry,
      sessions: sessionApplicationService, readOnly: developmentPreview });
    const operation = request.method === "GET" ? service.read(url.searchParams.get("providerId"))
      : readJson(request).then(input => service.save(input));
    operation.then(value => sendJson(response, 200, value))
      .catch(error => sendJson(response, error.statusCode ?? 500, { code: error.code ?? "TASK_DEFAULTS_UNAVAILABLE" }));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/settings") {
    sendJson(response, 200, {
      ...store.settings(),
      developmentPreview,
      dataRootMigration: dataRootMigrationCoordinator.status()
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/data-root-migrations/current") {
    sendJson(response, 200, { operation: dataRootMigrationCoordinator.status() });
    return true;
  }

  return false;
}

export function handleSettingsUpdateHttpRequest({
  request, response, url, store, dataRootMigrationCoordinator,
  onSettingsSaved, configureChoiceParserRuntime, readJson, sendJson, errorStatus
}) {
  if (request.method === "PATCH" && url.pathname === "/settings") {
    readJson(request)
      .then(async (input) => {
        const before = store.settings();
        if (Object.hasOwn(input, "dataRoot")
          && (typeof input.dataRoot !== "string" || !input.dataRoot.trim())) {
          const error = new TypeError("Data Root must be a non-empty absolute path.");
          error.code = "DATA_ROOT_INVALID";
          throw error;
        }
        const requestedDataRoot = typeof input.dataRoot === "string" ? input.dataRoot.trim() : null;
        if (Object.hasOwn(input, "expectedSourceDataRoot")
          && (typeof input.expectedSourceDataRoot !== "string" || !input.expectedSourceDataRoot.trim())) {
          const error = new TypeError("Expected source Data Root must be a non-empty absolute path.");
          error.code = "DATA_ROOT_INVALID";
          throw error;
        }
        const expectedSourceDataRoot = typeof input.expectedSourceDataRoot === "string"
          ? input.expectedSourceDataRoot.trim()
          : null;
        const activeDataRoot = store.settings().dataRoot;
        const dataRootChangeRequested = requestedDataRoot
          && resolve(requestedDataRoot) !== resolve(activeDataRoot);
        if (dataRootChangeRequested && expectedSourceDataRoot
          && resolve(expectedSourceDataRoot) !== resolve(activeDataRoot)) {
          const error = new Error("The active Data Root changed after the settings form was loaded. Reload settings before migrating.");
          error.code = "DATA_ROOT_SOURCE_CHANGED";
          error.statusCode = 409;
          error.details = { activeDataRoot };
          throw error;
        }
        const { expectedSourceDataRoot: _expectedSourceDataRoot, ...settingsInput } = input;
        const settingsPatch = { ...settingsInput, dataRoot: activeDataRoot };
        const settings = await store.updateSettings(settingsPatch);
        await onSettingsSaved(before, settings);
        const operation = dataRootChangeRequested
          ? await dataRootMigrationCoordinator.migrate(requestedDataRoot)
          : null;
        return {
          ...settings,
          dataRootMigration: operation ?? dataRootMigrationCoordinator.status()
        };
      })
      .then((settings) => {
        configureChoiceParserRuntime({
          ...(settings.choiceParser ?? {}),
          agentProxy: settings.agentProxy
        });
        sendJson(response, 200, settings);
      })
      .catch((error) => {
        sendJson(response, errorStatus(error, 400), {
          error: error.message,
          code: error.code ?? "SETTINGS_UPDATE_FAILED",
          details: error.details ?? null,
          operation: dataRootMigrationCoordinator.status()
        });
      });
    return true;
  }

  return false;
}
