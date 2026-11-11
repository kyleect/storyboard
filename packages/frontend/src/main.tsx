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
  redirect,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { token } from "./api";
import { Layout } from "./routes/Layout";

// The routes are the addresses of the workbench's tabs. The workbench, drawn
// by the root route, shows the tab; the routes themselves render nothing.
const Page = () => null;

const rootRoute = createRootRoute({ component: Layout });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Page }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/$sessionId",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId/files",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId/agents",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId/skills",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId/data",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/files",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/data",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces",
    component: Page,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/errors",
    component: Page,
  }),
  // The tabs are in the address: /settings/<area>/<section>. Every page is
  // this one route, so changing tabs does not remount the page.
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    beforeLoad: () => {
      throw redirect({
        to: "/settings/$",
        params: { _splat: "general/models" },
        replace: true,
      });
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$",
    component: Page,
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
