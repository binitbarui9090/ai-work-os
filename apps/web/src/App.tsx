/**
 * Routing and the auth gate.
 *
 * Three states, handled explicitly rather than implicitly: loading the
 * session, signed out, and signed in with no workspace yet (which happens
 * after leaving the last one).
 */
import { Suspense, lazy, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell.js";
import { CenteredSpinner, ToastProvider } from "./components/ui/index.js";
import { RealtimeProvider } from "./lib/realtime.js";
import { SessionProvider, useSession } from "./lib/session.js";
import { AcceptInvitePage } from "./pages/AcceptInvitePage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { RegisterPage } from "./pages/RegisterPage.js";
import { CreateWorkspacePage } from "./pages/CreateWorkspacePage.js";
import { HomePage } from "./pages/HomePage.js";
import { MyTasksPage } from "./pages/MyTasksPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { ProjectPage } from "./pages/ProjectPage.js";
import { TaskPage } from "./pages/TaskPage.js";
import { DocumentsPage } from "./pages/DocumentsPage.js";
import { DocumentPage } from "./pages/DocumentPage.js";
import { MeetingsPage } from "./pages/MeetingsPage.js";
import { MeetingPage } from "./pages/MeetingPage.js";
import { ActivityPage } from "./pages/ActivityPage.js";
import { InsightsPage } from "./pages/InsightsPage.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";

// The AI screens pull in the richest components; loading them on demand keeps
// the first paint of the board and dashboard fast.
const AiChatPage = lazy(() => import("./pages/AiChatPage.js").then((m) => ({ default: m.AiChatPage })));
const AiPlanPage = lazy(() => import("./pages/AiPlanPage.js").then((m) => ({ default: m.AiPlanPage })));
const AiActionsPage = lazy(() =>
  import("./pages/AiActionsPage.js").then((m) => ({ default: m.AiActionsPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage.js").then((m) => ({ default: m.SettingsPage })),
);

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <SessionProvider>
          <AppRoutes />
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<AnonymousOnly><LoginPage /></AnonymousOnly>} />
      <Route path="/register" element={<AnonymousOnly><RegisterPage /></AnonymousOnly>} />
      {/* The invite page works signed in or out: it tells you which it needs. */}
      <Route path="/invite/:token" element={<AcceptInvitePage />} />

      <Route
        path="/workspaces/new"
        element={
          <RequireAuth>
            <CreateWorkspacePage />
          </RequireAuth>
        }
      />

      <Route
        element={
          <RequireWorkspace>
            <RealtimeProvider>
              <AppShell />
            </RealtimeProvider>
          </RequireWorkspace>
        }
      >
        <Route path="/" element={<HomePage />} />
        <Route path="/my-tasks" element={<MyTasksPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectPage />} />
        <Route path="/tasks/:taskId" element={<TaskPage />} />
        <Route path="/docs" element={<DocumentsPage />} />
        <Route path="/docs/:documentId" element={<DocumentPage />} />
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/meetings/:meetingId" element={<MeetingPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/insights" element={<InsightsPage />} />

        <Route
          path="/ai"
          element={
            <Suspense fallback={<CenteredSpinner />}>
              <AiChatPage />
            </Suspense>
          }
        />
        <Route
          path="/ai/plan"
          element={
            <Suspense fallback={<CenteredSpinner />}>
              <AiPlanPage />
            </Suspense>
          }
        />
        <Route
          path="/ai/actions"
          element={
            <Suspense fallback={<CenteredSpinner />}>
              <AiActionsPage />
            </Suspense>
          }
        />
        <Route
          path="/settings/*"
          element={
            <Suspense fallback={<CenteredSpinner />}>
              <SettingsPage />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const location = useLocation();

  if (status === "loading") return <FullPageLoader />;
  if (status === "anonymous") {
    // Remember where they were headed so sign-in can return them.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

function RequireWorkspace({ children }: { children: ReactNode }) {
  const { status, workspace, workspaces } = useSession();
  const location = useLocation();

  if (status === "loading") return <FullPageLoader />;
  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  // Signed in but with nothing to show: send them to create a workspace
  // rather than rendering an empty shell.
  if (!workspace || workspaces.length === 0) {
    return <Navigate to="/workspaces/new" replace />;
  }
  return <>{children}</>;
}

function AnonymousOnly({ children }: { children: ReactNode }) {
  const { status } = useSession();
  if (status === "loading") return <FullPageLoader />;
  if (status === "authenticated") return <Navigate to="/" replace />;
  return <>{children}</>;
}

function FullPageLoader() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <CenteredSpinner label="Loading your workspace" />
    </div>
  );
}
