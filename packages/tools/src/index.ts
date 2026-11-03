import type { Tool } from "@harness/core";
import { agentTools } from "./agents.js";
import { askUser } from "./ask-user.js";
import { currentDate, currentTime } from "./clock.js";
import { copyTools } from "./copy.js";
import { entryTools } from "./entries.js";
import { projectTools } from "./projects.js";
import { skillTools } from "./skills.js";
import { webSearch, readWebpage, readWiki } from "./web.js";

export { askUser, currentDate, currentTime };
export * from "./entries.js";
export * from "./copy.js";
export * from "./projects.js";
export * from "./agents.js";
export * from "./skills.js";

/** Every tool. Each session gets all of them for now (tools design 6.11). */
export const allTools: readonly Tool[] = [
  currentDate,
  currentTime,
  webSearch,
  readWebpage,
  askUser,
  readWiki,
  ...entryTools,
  ...copyTools,
  ...projectTools,
  ...agentTools,
  ...skillTools,
];
