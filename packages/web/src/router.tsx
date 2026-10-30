// Rutas del front end (TanStack Router, definidas en código). Las páginas leen sus parámetros con
// getRouteApi para no importar este módulo.
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { Layout } from "./components/layout.tsx";
import { BoardPage } from "./pages/board.tsx";
import { InboxPage } from "./pages/inbox.tsx";
import { NewTaskPage } from "./pages/new-task.tsx";
import { ProjectsPage } from "./pages/projects.tsx";
import { QueuePage } from "./pages/queue.tsx";
import { TaskDetailPage } from "./pages/task-detail.tsx";

type RouterContext = { queryClient: QueryClient };

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Layout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/queue" });
  },
});

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  component: QueuePage,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxPage,
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectsPage,
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: BoardPage,
});

export type NewTaskSearch = { projectId?: string };

const newTaskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/new",
  validateSearch: (search: Record<string, unknown>): NewTaskSearch =>
    typeof search.projectId === "string" ? { projectId: search.projectId } : {},
  component: NewTaskPage,
});

const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId",
  component: TaskDetailPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  queueRoute,
  inboxRoute,
  projectsRoute,
  boardRoute,
  newTaskRoute,
  taskRoute,
]);

export function createAppRouter({
  queryClient,
  history,
}: {
  queryClient: QueryClient;
  history?: RouterHistory;
}) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    ...(history ? { history } : {}),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
