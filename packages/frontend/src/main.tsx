import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";

import { Alert, MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { token } from "./api";
import { Chat } from "./routes/Chat";
import { GlobalEntriesPage, ProjectEntriesPage } from "./routes/Entries";
import { Home, Layout } from "./routes/Layout";
import { ProjectPage } from "./routes/ProjectPage";
import { Settings } from "./routes/Settings";

const rootRoute = createRootRoute({ component: Layout });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/$sessionId",
    component: Chat,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId",
    component: ProjectPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId/files",
    component: ProjectEntriesPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/files",
    component: GlobalEntriesPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: Settings,
  }),
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");

createRoot(root).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <Notifications />
      <ModalsProvider>
        {token ? (
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        ) : (
          <Alert color="yellow" m="md" title="No backend token">
            Open the address the backend prints when it starts (it ends with
            #token=…).
          </Alert>
        )}
      </ModalsProvider>
    </MantineProvider>
  </StrictMode>,
);
