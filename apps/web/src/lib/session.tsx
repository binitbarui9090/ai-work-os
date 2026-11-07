/**
 * Session and workspace context.
 *
 * Holds the signed-in user, the workspaces they belong to, and which one is
 * active. The active workspace is persisted so a reload lands where the user
 * left off, and is validated against the server's list so a stale id cannot
 * wedge the app.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CurrentUser, WorkspaceSummary } from "@workos/shared";
import {
  ApiRequestError,
  api,
  setActiveWorkspace,
  setUnauthorizedHandler,
  type SessionResponse,
} from "./api.js";

const WORKSPACE_KEY = "workos.workspaceId";

export type Theme = "light" | "dark" | "system";

interface SessionState {
  status: "loading" | "authenticated" | "anonymous";
  user: CurrentUser | null;
  workspaces: WorkspaceSummary[];
  workspace: WorkspaceSummary | null;
}

interface SessionContextValue extends SessionState {
  login(email: string, password: string): Promise<void>;
  register(input: {
    email: string;
    password: string;
    name: string;
    workspaceName?: string;
    inviteToken?: string;
  }): Promise<void>;
  logout(): Promise<void>;
  switchWorkspace(id: string): void;
  createWorkspace(name: string): Promise<WorkspaceSummary>;
  /** Re-reads the session; used after invitations and settings changes. */
  refresh(): Promise<void>;
  updateUser(user: CurrentUser): void;
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme(theme: Theme): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function readStoredWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

function storeWorkspace(id: string | null): void {
  try {
    if (id) localStorage.setItem(WORKSPACE_KEY, id);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // Private browsing; the app still works for this session.
  }
}

function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem("workos.theme");
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // Fall through to the default.
  }
  return "system";
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({
    status: "loading",
    user: null,
    workspaces: [],
    workspace: null,
  });
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Follow the OS when the preference is "system".
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  const resolvedTheme: "light" | "dark" =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    try {
      localStorage.setItem("workos.theme", theme);
    } catch {
      // Not fatal.
    }
  }, [theme, resolvedTheme]);

  const applySession = useCallback((response: SessionResponse) => {
    const workspaces = response.workspaces;
    const preferred = response.workspaceId ?? readStoredWorkspace();
    // A stored id from a workspace the user has left must not win.
    const workspace =
      workspaces.find((w) => w.id === preferred) ?? workspaces[0] ?? null;

    setActiveWorkspace(workspace?.id ?? null);
    storeWorkspace(workspace?.id ?? null);

    setState({
      status: "authenticated",
      user: response.user,
      workspaces,
      workspace,
    });

    if (response.user.theme) setThemeState(response.user.theme);
  }, []);

  const signOutLocally = useCallback(() => {
    setActiveWorkspace(null);
    storeWorkspace(null);
    setState({ status: "anonymous", user: null, workspaces: [], workspace: null });
  }, []);

  // Any 401 anywhere in the app lands here.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (mounted.current) signOutLocally();
    });
  }, [signOutLocally]);

  const refresh = useCallback(async () => {
    try {
      applySession(await api.auth.me());
    } catch (err) {
      if (err instanceof ApiRequestError && err.isAuthError) signOutLocally();
      else if (mounted.current) {
        setState((prev) => (prev.status === "loading" ? { ...prev, status: "anonymous" } : prev));
      }
    }
  }, [applySession, signOutLocally]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionContextValue>(
    () => ({
      ...state,
      theme,
      resolvedTheme,
      setTheme: (next) => {
        setThemeState(next);
        // Persisted server-side too, so the preference follows the account.
        if (state.status === "authenticated") {
          void api.auth.updateProfile({ theme: next }).catch(() => {});
        }
      },

      async login(email, password) {
        applySession(await api.auth.login(email, password));
      },

      async register(input) {
        applySession(await api.auth.register(input));
      },

      async logout() {
        try {
          await api.auth.logout();
        } finally {
          signOutLocally();
        }
      },

      switchWorkspace(id) {
        const workspace = state.workspaces.find((w) => w.id === id);
        if (!workspace) return;
        setActiveWorkspace(id);
        storeWorkspace(id);
        setState((prev) => ({ ...prev, workspace }));
      },

      async createWorkspace(name) {
        const { workspace } = await api.workspaces.create({ name });
        setActiveWorkspace(workspace.id);
        storeWorkspace(workspace.id);
        setState((prev) => ({
          ...prev,
          workspaces: [...prev.workspaces, workspace],
          workspace,
        }));
        return workspace;
      },

      refresh,

      updateUser(user) {
        setState((prev) => ({ ...prev, user }));
      },
    }),
    [state, theme, resolvedTheme, applySession, signOutLocally, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside a SessionProvider");
  return context;
}

/** Narrowed accessor for screens that run behind the authenticated layout. */
export function useWorkspace(): WorkspaceSummary {
  const { workspace } = useSession();
  if (!workspace) throw new Error("useWorkspace used outside an active workspace");
  return workspace;
}

export function useCurrentUser(): CurrentUser {
  const { user } = useSession();
  if (!user) throw new Error("useCurrentUser used while unauthenticated");
  return user;
}
