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
import { api, token } from "./api";
import { useAppearance } from "./stores/appearance";
import { setCurrentProfile } from "./stores/profile";
import { Layout } from "./routes/workbench/Layout";
import { useWorkbench } from "./stores/workbench";

import "@gfazioli/mantine-led/styles.css";

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

function App() {
  const primaryColor = useAppearance((s) => s.primaryColor);
  return (
    <MantineProvider defaultColorScheme="auto" theme={{ primaryColor }}>
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
  );
}

async function start(container: HTMLElement) {
  if (token) {
    try {
      const listing = await api.listProfiles();
      setCurrentProfile(listing.active);
      useWorkbench.getState().reload();
      useAppearance.getState().reload();
    } catch {
      // backend not reachable yet: the app opens on the Default profile and the event stream corrects it once it connects
    }
  }
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start(root);
