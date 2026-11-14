import { useFaviconIndicator } from "../../hooks/useFaviconIndicator";
import { useAppEvents } from "../../hooks/useAppEvents";
import { Workbench } from "./components/Workbench";

/*
 * The whole app is the workbench (chat workbench design). The routes are the
 * addresses of its tabs; they render nothing themselves.
 */
export function Layout() {
  // Agent changes from any window (agents plan, P7).
  useAppEvents();
  // A blue dot on the tab icon while a chat has a reply not yet seen.
  useFaviconIndicator();
  return <Workbench />;
}
