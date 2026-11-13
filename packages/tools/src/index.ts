import type { Tool } from "@harness/core";
import { agentTools } from "./agents.js";
import { askUser } from "./ask-user.js";
import { currentDate, currentTime } from "./clock.js";
import { copyTools } from "./copy.js";
import { fileTools } from "./files.js";
import { projectTools } from "./projects.js";
import { schemaDataTools } from "./schemas-data.js";
import { skillTools } from "./skills.js";
import { subagentTools } from "./subagents.js";
import { workspaceTools } from "./workspaces.js";
import { webSearch, readWebpage, readWiki } from "./web.js";

export { askUser, currentDate, currentTime };
export * from "./files.js";
export * from "./copy.js";
export * from "./projects.js";
export * from "./agents.js";
export * from "./skills.js";
export * from "./subagents.js";
export * from "./schemas-data.js";
export * from "./workspaces.js";

/** Every tool. Each session gets all of them for now (tools design 6.11). */
export const allTools: readonly Tool[] = [
  currentDate,
  currentTime,
  webSearch,
  readWebpage,
  askUser,
  readWiki,
  ...fileTools,
  ...copyTools,
  ...projectTools,
  ...agentTools,
  ...subagentTools,
  ...skillTools,
  ...schemaDataTools,
  ...workspaceTools,
];
