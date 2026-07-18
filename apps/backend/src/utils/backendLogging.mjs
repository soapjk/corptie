import { createWriteStream, mkdirSync, openSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { format } from "node:util";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_BACKUP_COUNT = 5;
const originalConsole = Object.fromEntries(
  ["log", "info", "debug", "warn", "error"].map((method) => [method, console[method].bind(console)])
);

let installed = false;
let activeDirectory = null;
let mirrorToOriginalConsole = false;
let maxBytes = DEFAULT_MAX_BYTES;
let backupCount = DEFAULT_BACKUP_COUNT;
let outputs = null;

export function configureBackendLogging(directory, options = {}) {
  const rawDirectory = String(directory ?? "").trim();
  if (!rawDirectory) throw new Error("Log directory is required.");
  const nextDirectory = resolve(rawDirectory);

  mirrorToOriginalConsole = options.mirrorToOriginalConsole === true;
  maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  backupCount = positiveInteger(options.backupCount, DEFAULT_BACKUP_COUNT);

  if (!installed) installConsoleWriters();
  if (activeDirectory === nextDirectory && outputs) return logSettings();

  mkdirSync(nextDirectory, { recursive: true });
  closeOutputs();
  activeDirectory = nextDirectory;
  outputs = {
    stdout: openOutput(join(nextDirectory, "backend.out.log")),
    stderr: openOutput(join(nextDirectory, "backend.err.log"))
  };
  return logSettings();
}

export function logSettings() {
  return activeDirectory
    ? {
        directory: activeDirectory,
        stdoutPath: join(activeDirectory, "backend.out.log"),
        stderrPath: join(activeDirectory, "backend.err.log"),
        maxBytes,
        backupCount
      }
    : null;
}

function installConsoleWriters() {
  installed = true;
  console.log = (...args) => write("stdout", "log", args);
  console.info = (...args) => write("stdout", "info", args);
  console.debug = (...args) => write("stdout", "debug", args);
  console.warn = (...args) => write("stderr", "warn", args);
  console.error = (...args) => write("stderr", "error", args);
}

function write(outputName, consoleMethod, args) {
  const line = `${format(...args)}\n`;
  if (mirrorToOriginalConsole || !outputs?.[outputName]) {
    originalConsole[consoleMethod](...args);
  }
  const output = outputs?.[outputName];
  if (!output) return;

  const bytes = Buffer.byteLength(line);
  if (output.size + bytes > maxBytes) rotateOutput(outputName);
  outputs[outputName].stream.write(line);
  outputs[outputName].size += bytes;
}

function openOutput(path) {
  rotateIfOversized(path);
  const size = fileSize(path);
  const stream = createWriteStream(path, {
    fd: openSync(path, "a"),
    autoClose: true,
    encoding: "utf8"
  });
  stream.on("error", (error) => originalConsole.error(`[backend-logging] ${error.message}`));
  return { path, size, stream };
}

function rotateOutput(outputName) {
  const output = outputs[outputName];
  output.stream.end();
  rotateFiles(output.path);
  outputs[outputName] = openOutput(output.path);
}

function rotateIfOversized(path) {
  if (fileSize(path) >= maxBytes) rotateFiles(path);
}

function rotateFiles(path) {
  removeFile(`${path}.${backupCount}`);
  for (let index = backupCount - 1; index >= 1; index -= 1) {
    renameFile(`${path}.${index}`, `${path}.${index + 1}`);
  }
  renameFile(path, `${path}.1`);
}

function closeOutputs() {
  for (const output of Object.values(outputs ?? {})) output.stream.end();
  outputs = null;
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function renameFile(from, to) {
  try {
    renameSync(from, to);
  } catch (error) {
    if (error.code !== "ENOENT") originalConsole.error(`[backend-logging] ${error.message}`);
  }
}

function removeFile(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") originalConsole.error(`[backend-logging] ${error.message}`);
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
