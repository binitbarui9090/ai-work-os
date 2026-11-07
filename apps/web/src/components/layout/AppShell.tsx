/**
 * Authenticated application shell.
 *
 * Owns the sidebar, topbar, command palette and notification panel. Live data
 * that the chrome itself shows (unread count, pending AI approvals, presence)
 * is refreshed from realtime events rather than polled.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import type { Notification, PresenceEntry, ProjectSummary } from "@workos/shared";
import { api } from "../../lib/api.js";
import { relativeTime, useAsync, useShortcut } from "../../lib/hooks.js";
import { useRealtime, useRealtimeEvent } from "../../lib/realtime.js";
import { useSession } from "../../lib/session.js";
import { Avatar, Icon, Spinner, useToast, type IconName } from "../ui/index.js";
import { CommandPalette } from "./CommandPalette.js";
import styles from "./layout.module.css";

export function AppShell() {
  const { user, workspace, workspaces, switchWorkspace, logout, theme, setTheme } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { state: connection } = useRealtime();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const [unread, setUnread] = useState(0);
  const [pendingAi, setPendingAi] = useState(0);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);

  useShortcut({ key: "k", meta: true }, () => setPaletteOpen(true), { allowInInput: true });
  useShortcut({ key: "/" }, () => setPaletteOpen(true));

  // Close transient surfaces on navigation.
  useEffect(() => {
    setSidebarOpen(false);
    setNotificationsOpen(false);
    setWorkspaceMenuOpen(false);
    setUserMenuOpen(false);
  }, [location.pathname]);

  const projects = useAsync(() => api.projects.list(), [workspace?.id]);
  const capabilities = useAsync(() => api.ai.capabilities(), [workspace?.id]);

  // Initial counts; realtime keeps them current from here.
  useEffect(() => {
    if (!workspace) return;
    let active = true;
    void api.notifications
      .list({ limit: 1 })
      .then((r) => active && setUnread(r.unreadCount))
      .catch(() => {});
    void api.ai
      .actions({ status: "pending_approval", limit: 1 })
      .then((r) => active && setPendingAi(r.pendingCount))
      .catch(() => {});
    void api.workspaces
      .presence()
      .then((r) => active && setPresence(r.entries))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [workspace?.id]);

  useRealtimeEvent("presence", (event) => setPresence(event.entries));

  useRealtimeEvent("notification", (event) => {
    setUnread((n) => n + 1);
    // A mention or an approval request is worth interrupting for.
    if (event.notification.type === "mention" || event.notification.type === "ai_approval_requested") {
      toast.info(event.notification.title, event.notification.body ?? undefined);
    }
  });

  useRealtimeEvent("ai.action.created", () => setPendingAi((n) => n + 1));
  useRealtimeEvent("ai.action.decided", () => setPendingAi((n) => Math.max(0, n - 1)));

  useRealtimeEvent(["project.created", "project.updated"], () => projects.reload());

  const aiEnabled = capabilities.data?.capabilities.chatEnabled ?? false;
  const otherPresence = useMemo(
    () => presence.filter((entry) => entry.userId !== user?.id),
    [presence, user?.id],
  );

  if (!workspace || !user) return null;

  const activeProjects = (projects.data?.projects ?? []).filter(
    (project) => project.status === "active" || project.status === "planning",
  );

  return (
    <div className={styles.shell}>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      {sidebarOpen && <div className={styles.scrim} onClick={() => setSidebarOpen(false)} />}

      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""}`}>
        <div className={`${styles.sidebarHeader} ${styles.menuAnchor}`}>
          <button
            type="button"
            className={styles.workspaceButton}
            onClick={() => setWorkspaceMenuOpen((open) => !open)}
            aria-expanded={workspaceMenuOpen}
            aria-haspopup="menu"
          >
            <span className={styles.workspaceMark}>
              {workspace.name.slice(0, 2).toUpperCase()}
            </span>
            <span className={styles.workspaceMeta}>
              <span className={styles.workspaceName}>{workspace.name}</span>
              <span className={styles.workspaceRole}>{workspace.role}</span>
            </span>
            <Icon name="chevron-down" size={14} style={{ color: "var(--text-tertiary)" }} />
          </button>

          {workspaceMenuOpen && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 30 }}
                onClick={() => setWorkspaceMenuOpen(false)}
              />
              <div className={`menu ${styles.workspaceMenu}`} role="menu">
                <div className="menu-label">Workspaces</div>
                {workspaces.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    aria-selected={candidate.id === workspace.id}
                    onClick={() => {
                      switchWorkspace(candidate.id);
                      setWorkspaceMenuOpen(false);
                      navigate("/");
                    }}
                  >
                    <span className="truncate" style={{ flex: 1 }}>
                      {candidate.name}
                    </span>
                    {candidate.id === workspace.id && <Icon name="check" size={14} />}
                  </button>
                ))}
                <div className="menu-separator" />
                <Link to="/workspaces/new" className="menu-item" role="menuitem">
                  <Icon name="plus" size={14} />
                  Create workspace
                </Link>
                <Link to="/settings" className="menu-item" role="menuitem">
                  <Icon name="settings" size={14} />
                  Workspace settings
                </Link>
              </div>
            </>
          )}
        </div>

        <nav className={styles.sidebarScroll} aria-label="Main navigation">
          <div className={styles.navSection}>
            <NavItem to="/" icon="home" label="Home" end />
            <NavItem to="/my-tasks" icon="list" label="My tasks" />
            <NavItem to="/projects" icon="board" label="Projects" />
            <NavItem to="/docs" icon="doc" label="Documents" />
            <NavItem to="/meetings" icon="mic" label="Meetings" />
            <NavItem to="/activity" icon="activity" label="Activity" />
          </div>

          <div className={styles.navSection}>
            <div className={styles.navLabel}>Intelligence</div>
            <NavItem to="/ai" icon="sparkle" label="Ask AI" />
            <NavItem to="/ai/plan" icon="layers" label="Plan from brief" />
            <NavItem to="/insights" icon="activity" label="Insights" />
            <NavItem
              to="/ai/actions"
              icon="shield"
              label="Approvals"
              count={pendingAi > 0 ? pendingAi : undefined}
              alert={pendingAi > 0}
            />
          </div>

          <div className={styles.navSection}>
            <div className={styles.navLabel}>
              Projects
              <Link to="/projects?new=1" className={styles.navLabelAction} title="New project">
                <Icon name="plus" size={13} />
              </Link>
            </div>
            {projects.loading ? (
              <div style={{ padding: "var(--space-2)" }}>
                <Spinner />
              </div>
            ) : activeProjects.length === 0 ? (
              <Link to="/projects?new=1" className={styles.navItem}>
                <Icon name="plus" size={15} className={styles.navIcon} />
                <span className={styles.navText}>Create your first project</span>
              </Link>
            ) : (
              activeProjects.slice(0, 10).map((project) => (
                <ProjectNavItem key={project.id} project={project} />
              ))
            )}
          </div>
        </nav>

        <div className={`${styles.sidebarFooter} ${styles.menuAnchor}`}>
          <button
            type="button"
            className={styles.userButton}
            onClick={() => setUserMenuOpen((open) => !open)}
            aria-expanded={userMenuOpen}
            aria-haspopup="menu"
          >
            <Avatar user={user} size={26} online />
            <span className={styles.userMeta}>
              <span className={styles.userName}>{user.name}</span>
              <span className={styles.userEmail}>{user.email}</span>
            </span>
            <Icon name="chevron-down" size={14} style={{ color: "var(--text-tertiary)" }} />
          </button>

          {userMenuOpen && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 30 }}
                onClick={() => setUserMenuOpen(false)}
              />
              <div className={`menu ${styles.userMenu}`} role="menu">
                <Link to="/settings/profile" className="menu-item" role="menuitem">
                  <Icon name="user" size={14} />
                  Your profile
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                >
                  <Icon name={theme === "dark" ? "sun" : "moon"} size={14} />
                  {theme === "dark" ? "Light theme" : "Dark theme"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => setTheme("system")}
                >
                  <Icon name="settings" size={14} />
                  Match system theme
                </button>
                <div className="menu-separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item menu-item-danger"
                  onClick={() => void logout()}
                >
                  <Icon name="logout" size={14} />
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.menuToggle}`}
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <Icon name="menu" size={17} />
          </button>

          <button type="button" className={styles.searchTrigger} onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={14} />
            <span className={styles.searchTriggerText}>Search or jump to…</span>
            <kbd>⌘K</kbd>
          </button>

          <div className={styles.topbarActions}>
            {connection !== "open" && (
              <span className={styles.connection} title="Live updates are temporarily unavailable">
                <span className="spinner" style={{ width: 10, height: 10 }} />
                {connection === "connecting" ? "Connecting" : "Reconnecting"}
              </span>
            )}

            {otherPresence.length > 0 && (
              <div className={styles.presence}>
                {otherPresence.slice(0, 4).map((entry) => (
                  <Avatar
                    key={entry.userId}
                    user={{ id: entry.userId, name: entry.name, avatarUrl: entry.avatarUrl }}
                    size={22}
                    online
                  />
                ))}
                {otherPresence.length > 4 && (
                  <span className="text-xs text-tertiary">+{otherPresence.length - 4}</span>
                )}
              </div>
            )}

            {aiEnabled && (
              <Link to="/ai" className={styles.iconButton} title="Ask the AI">
                <Icon name="sparkle" size={17} />
              </Link>
            )}

            <div className={styles.panelAnchor}>
              <button
                type="button"
                className={`${styles.iconButton} ${notificationsOpen ? styles.iconButtonActive : ""}`}
                onClick={() => setNotificationsOpen((open) => !open)}
                aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
                aria-expanded={notificationsOpen}
              >
                <Icon name="bell" size={17} />
                {unread > 0 && <span className={styles.badgeDot}>{unread > 9 ? "9+" : unread}</span>}
              </button>
              {notificationsOpen && (
                <NotificationPanel
                  onClose={() => setNotificationsOpen(false)}
                  onUnreadChange={setUnread}
                />
              )}
            </div>

            <Link to="/settings" className={styles.iconButton} title="Settings">
              <Icon name="settings" size={17} />
            </Link>
          </div>
        </header>

        <main id="main-content" className={styles.content}>
          <div className={styles.contentNarrow}>
            <Outlet />
          </div>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        canUseAi={aiEnabled}
      />
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
  count,
  alert,
  end,
}: {
  to: string;
  icon: IconName;
  label: string;
  count?: number;
  alert?: boolean;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `${styles.navItem} ${isActive ? styles.navItemActive : ""}`
      }
    >
      <Icon name={icon} size={15} className={styles.navIcon} />
      <span className={styles.navText}>{label}</span>
      {count !== undefined && (
        <span className={`${styles.navCount} ${alert ? styles.navCountAlert : ""}`}>{count}</span>
      )}
    </NavLink>
  );
}

function ProjectNavItem({ project }: { project: ProjectSummary }) {
  const openCount = project.openTaskCount;
  return (
    <NavLink
      to={`/projects/${project.id}`}
      className={({ isActive }) => `${styles.navItem} ${isActive ? styles.navItemActive : ""}`}
    >
      <span className={styles.projectDot} style={{ background: project.color }} />
      <span className={styles.navText}>{project.name}</span>
      {project.overdueTaskCount > 0 ? (
        <span className={`${styles.navCount} ${styles.navCountAlert}`} title="Overdue tasks">
          {project.overdueTaskCount}
        </span>
      ) : openCount > 0 ? (
        <span className={styles.navCount}>{openCount}</span>
      ) : null}
    </NavLink>
  );
}

function NotificationPanel({
  onClose,
  onUnreadChange,
}: {
  onClose: () => void;
  onUnreadChange: (count: number) => void;
}) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    api.notifications
      .list({ limit: 25 })
      .then((response) => {
        if (!active) return;
        setItems(response.items);
        onUnreadChange(response.unreadCount);
        setLoading(false);
      })
      .catch(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [onUnreadChange]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    };
    // Deferred so the click that opened the panel does not immediately close it.
    const timer = window.setTimeout(
      () => document.addEventListener("mousedown", onPointerDown),
      0,
    );
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [onClose]);

  const markAllRead = async () => {
    const result = await api.notifications.markRead().catch(() => null);
    if (!result) return;
    setItems((prev) => prev.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    onUnreadChange(result.unreadCount);
  };

  const open = async (notification: Notification) => {
    if (!notification.readAt) {
      const result = await api.notifications.markRead([notification.id]).catch(() => null);
      if (result) onUnreadChange(result.unreadCount);
    }
    onClose();
    if (notification.url) navigate(notification.url);
  };

  const unreadCount = items.filter((item) => !item.readAt).length;

  return (
    <div className={styles.dropdown} ref={panelRef} role="dialog" aria-label="Notifications">
      <div className={styles.dropdownHeader}>
        <span className={styles.dropdownTitle}>Notifications</span>
        {unreadCount > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void markAllRead()}>
            Mark all read
          </button>
        )}
      </div>
      <div className={styles.dropdownBody}>
        {loading ? (
          <div style={{ padding: "var(--space-6)", display: "flex", justifyContent: "center" }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <div
            style={{ padding: "var(--space-8) var(--space-4)", textAlign: "center" }}
            className="text-sm text-secondary"
          >
            You are all caught up.
          </div>
        ) : (
          items.map((notification) => (
            <button
              key={notification.id}
              type="button"
              className={`${styles.notificationItem} ${
                notification.readAt ? "" : styles.notificationUnread
              }`}
              onClick={() => void open(notification)}
            >
              <Avatar user={notification.actor} size={26} />
              <span className={styles.notificationBody}>
                <span className={styles.notificationTitle}>{notification.title}</span>
                {notification.body && (
                  <span className={styles.notificationDetail}>{notification.body}</span>
                )}
                <span className={styles.notificationTime}>
                  {relativeTime(notification.createdAt)}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
