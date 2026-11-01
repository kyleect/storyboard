import type { Tool } from "@harness/core";
import { currentDate, currentTime } from "./clock.js";
import { entryTools } from "./entries.js";
import { webSearch, readWebpage } from "./web.js";

export { currentDate, currentTime };
export * from "./entries.js";

/** Every tool. Each session gets all of them for now (tools design 6.11). */
export const allTools: readonly Tool[] = [
  currentDate,
  currentTime,
  webSearch,
  readWebpage,
  ...entryTools,
];
