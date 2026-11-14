import { useFaviconIndicator } from "../../hooks/useFaviconIndicator";
import { useAppEvents } from "../../hooks/useAppEvents";
import { Workbench } from "./components/Workbench";

export function Layout() {
  useAppEvents();
  useFaviconIndicator();

  return <Workbench />;
}
