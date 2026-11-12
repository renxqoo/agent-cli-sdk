/**
 * Supported low-level composition API for custom runtimes and transports.
 * These exports follow SemVer, but callers own lifecycle ordering and process I/O.
 * Ordinary business commands should use the package root and CommandContext.
 */
export { createFetchAdapter, throwForResponse, type CreateFetchAdapterOptions } from "./request.js";
export { createContext, createStderrLog, type CreateContextOptions } from "./context.js";
export { createPipeReader, emptyPipe } from "./pipe.js";
export { runCommand, type RunCommandOptions } from "./pipeline.js";
export {
  sortPlugins,
  setupPlugins,
  runOnAppRun,
  runAfterAppRun,
  runBeforeCommand,
  observeInput,
  beforeRequest,
  observeRequest,
  handleUnauthorized,
  transformOutput,
  observeError,
  handleError,
} from "./plugin.js";
