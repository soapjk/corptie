import { DatabaseWorkerPool } from "./databaseWorkerPool.mjs";

// Compatibility facade for interactive timeline/search callers.
export class TimelineReadPool extends DatabaseWorkerPool {}
