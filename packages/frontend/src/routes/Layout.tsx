import { useAppEvents } from "../live";
import { Workbench } from "./Workbench";

/*
 * The whole app is the workbench (chat workbench design). The routes are the
 * addresses of its tabs; they render nothing themselves.
 */
export function Layout() {
  // Agent changes from any window (agents plan, P7).
  useAppEvents();
  return <Workbench />;
}
