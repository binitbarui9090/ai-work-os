/**
 * Home dashboard.
 *
 * Every number on this screen is a live query result. The AI panels degrade
 * explicitly: blocker detection is deterministic and always present, while the
 * model-written commentary appears only when a provider is configured and says
 * so when it is not.
 */
import { Link } from "react-router-dom";
import type { Blocker, Task } from "@workos/shared";
import { api } from "../lib/api.js";
import { pluralise, relativeTime, useAsync, useMutation } from "../lib/hooks.js";
import { useRealtimeEvent } from "../lib/realtime.js";
import { useCurrentUser, useWorkspace } from "../lib/session.js";
import { PageHeader, SectionHeader, Stat } from "../components/PageHeader.js";
import { TaskList } from "../components/TaskViews.js";
import {
  Avatar,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRows,
  Notice,
  ProgressBar,
  Spinner,
} from "../components/ui/index.js";
import styles from "./pages.module.css";

export function HomePage() {
  const user = useCurrentUser();
  const workspace = useWorkspace();
  const dashboard = useAsync((signal) => api.dashboard.get(signal), [workspace.id]);

  // The dashboard is the one screen where a stale number is visible, so it
  // reloads on any task or project change anywhere in the workspace.
  useRealtimeEvent(
    ["task.created", "task.updated", "task.deleted", "project.created", "project.updated"],
    () => dashboard.reload(),
  );

  const toggleDone = useMutation(async (task: Task) => {
    await api.tasks.update(task.id, { status: task.status === "done" ? "todo" : "done" });
    dashboard.reload();
  });

  if (dashboard.loading && !dashboard.data) {
    return (
      <>
        <PageHeader title={greeting(user.name)} />
        <LoadingRows rows={6} />
      </>
    );
  }

  if (dashboard.error || !dashboard.data) {
    return (
      <>
        <PageHeader title={greeting(user.name)} />
        <ErrorState error={dashboard.error} onRetry={dashboard.reload} />
      </>
    );
  }

  const data = dashboard.data;
  const totalOpen = data.projects.reduce((sum, project) => sum + project.openTaskCount, 0);
  const totalOverdue = data.projects.reduce((sum, project) => sum + project.overdueTaskCount, 0);
  const totalBlocked = data.projects.reduce((sum, project) => sum + project.blockedTaskCount, 0);

  return (
    <div className="fade-in">
      <PageHeader
        title={greeting(user.name)}
        subtitle={`${workspace.name} · ${pluralise(data.projects.length, "active project")}`}
        actions={
          <>
            <Link to="/ai/plan" className="btn btn-secondary">
              <Icon name="sparkle" size={14} />
              Plan from a brief
            </Link>
            <Link to="/projects?new=1" className="btn btn-primary">
              <Icon name="plus" size={14} />
              New project
            </Link>
          </>
        }
      />

      {data.pendingAiActions > 0 && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <Notice
            tone="info"
            title={`${pluralise(data.pendingAiActions, "AI action")} waiting for approval`}
            action={
              <Link to="/ai/actions" className="btn btn-secondary btn-sm">
                Review
              </Link>
            }
          >
            Nothing has been changed yet. Approve or reject each proposal to decide.
          </Notice>
        </div>
      )}

      <div className={styles.statGrid}>
        <Stat
          label="Assigned to you"
          value={data.myTasks.length}
          icon="user"
          meta={
            data.myTasks.filter((t) => t.isBlocked).length > 0
              ? `${data.myTasks.filter((t) => t.isBlocked).length} blocked`
              : "Nothing blocked"
          }
          to="/my-tasks"
        />
        <Stat
          label="Overdue"
          value={totalOverdue}
          icon="clock"
          alert={totalOverdue > 0}
          meta={totalOverdue > 0 ? "Needs re-dating or re-scoping" : "On schedule"}
        />
        <Stat
          label="Blocked"
          value={totalBlocked}
          icon="blocked"
          alert={totalBlocked > 0}
          meta={totalBlocked > 0 ? "Waiting on upstream work" : "Nothing waiting"}
        />
        <Stat label="Open tasks" value={totalOpen} icon="list" meta="Across all projects" />
      </div>

      <div className={styles.twoColumn}>
        <div className="stack gap-6">
          {data.overdue.length > 0 && (
            <section>
              <SectionHeader
                title={
                  <span className="row gap-2">
                    <Icon name="alert" size={14} style={{ color: "var(--danger)" }} />
                    Overdue
                  </span>
                }
              />
              <TaskList tasks={data.overdue} onToggleDone={(task) => void toggleDone.run(task)} />
            </section>
          )}

          <section>
            <SectionHeader
              title="Your tasks"
              action={
                <Link to="/my-tasks" className={styles.sectionLink}>
                  View all
                </Link>
              }
            />
            {data.myTasks.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon="check"
                  title="Nothing assigned to you"
                  body="When someone assigns you a task it will show up here."
                  compact
                />
              </div>
            ) : (
              <TaskList tasks={data.myTasks} onToggleDone={(task) => void toggleDone.run(task)} />
            )}
          </section>

          {data.dueSoon.length > 0 && (
            <section>
              <SectionHeader title="Due in the next week" />
              <TaskList tasks={data.dueSoon} onToggleDone={(task) => void toggleDone.run(task)} />
            </section>
          )}

          <section>
            <SectionHeader
              title="Projects"
              action={
                <Link to="/projects" className={styles.sectionLink}>
                  All projects
                </Link>
              }
            />
            {data.projects.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon="board"
                  title="No projects yet"
                  body="Create one, or paste a brief and let the planner draft it for you."
                  action={
                    <>
                      <Link to="/projects?new=1" className="btn btn-primary btn-sm">
                        New project
                      </Link>
                      <Link to="/ai/plan" className="btn btn-secondary btn-sm">
                        Plan from a brief
                      </Link>
                    </>
                  }
                  compact
                />
              </div>
            ) : (
              <div className={styles.cardGrid}>
                {data.projects.slice(0, 6).map((project) => (
                  <Link key={project.id} to={`/projects/${project.id}`} className={styles.projectCard}>
                    <div className={styles.projectCardTop}>
                      <span className={styles.projectSwatch} style={{ background: project.color }}>
                        {project.key.slice(0, 2)}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className={styles.projectName}>{project.name}</div>
                        <div className={styles.projectKey}>{project.key}</div>
                      </div>
                      {project.overdueTaskCount > 0 && (
                        <span className="badge badge-danger">{project.overdueTaskCount} late</span>
                      )}
                    </div>

                    <ProgressBar percent={project.progressPercent} color={project.color} />

                    <div className={styles.projectFooter}>
                      <span>{project.progressPercent}% done</span>
                      <span>·</span>
                      <span>{pluralise(project.openTaskCount, "open task")}</span>
                      {project.lead && (
                        <>
                          <span className="spacer" />
                          <Avatar user={project.lead} size={18} />
                        </>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="stack gap-5">
          <BlockerPanel blockers={data.blockers} />
          <NextActionsPanel />

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">Recent activity</span>
              <Link to="/activity" className={styles.sectionLink}>
                All
              </Link>
            </div>
            <div className="panel-body">
              {data.recentActivity.length === 0 ? (
                <p className="text-sm text-secondary">Nothing has happened yet.</p>
              ) : (
                <div className={styles.feed}>
                  {data.recentActivity.slice(0, 8).map((event) => (
                    <div key={event.id} className={styles.feedItem}>
                      <Avatar user={event.actor} size={22} />
                      <span className={styles.feedText}>
                        <span className={styles.feedActor}>
                          {event.actor?.name ?? (event.actorType === "ai" ? "AI agent" : "System")}
                        </span>{" "}
                        {event.actorType === "ai" && (
                          <span className={styles.aiActorChip}>AI</span>
                        )}{" "}
                        {event.summary}
                      </span>
                      <span className={styles.feedTime}>{relativeTime(event.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function BlockerPanel({ blockers }: { blockers: Blocker[] }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title row gap-2">
          <Icon name="blocked" size={14} />
          What is stuck
        </span>
        {blockers.length > 0 && <span className="badge">{blockers.length}</span>}
      </div>
      {blockers.length === 0 ? (
        <div className="panel-body">
          <p className="text-sm text-secondary">
            Nothing overdue, blocked or stalled. This is computed from your tasks and dependencies,
            not estimated.
          </p>
        </div>
      ) : (
        <div>
          {blockers.slice(0, 5).map((blocker) => (
            <div key={blocker.taskId} className={styles.blockerCard}>
              <span
                className={`${styles.severityBar} ${
                  {
                    critical: styles.severityCritical,
                    high: styles.severityHigh,
                    medium: styles.severityMedium,
                    low: styles.severityLow,
                  }[blocker.severity]
                }`}
              />
              <div className={styles.blockerBody}>
                <div className={styles.blockerTitle}>
                  <Link to={`/tasks/${blocker.taskId}`} style={{ color: "inherit" }}>
                    <span className="mono text-xs text-tertiary">{blocker.reference}</span>{" "}
                    {blocker.title}
                  </Link>
                </div>
                <div className={styles.blockerReasons}>
                  {blocker.reasons.slice(0, 2).map((reason, index) => (
                    <span key={index} className={styles.blockerReason}>
                      <Icon name="dot" size={6} style={{ marginTop: 5, flexShrink: 0 }} />
                      {reason}
                    </span>
                  ))}
                </div>
                {blocker.aiExplanation && (
                  <div className={styles.blockerExplanation}>{blocker.aiExplanation}</div>
                )}
              </div>
            </div>
          ))}
          <div style={{ padding: "var(--space-3)" }}>
            <Link to="/insights" className="btn btn-secondary btn-sm btn-block">
              See all blockers and risks
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * "What next" suggestions.
 *
 * Scored deterministically on the server, and every suggestion shows the
 * reasons behind its score so it can be disagreed with.
 */
function NextActionsPanel() {
  const workspace = useWorkspace();
  const suggestions = useAsync(() => api.ai.nextActions({ limit: 4 }), [workspace.id]);

  return (
    <section className="panel">
      <div className="panel-header">
        <span className="panel-title row gap-2">
          <Icon name="arrow-right" size={14} />
          Suggested next
        </span>
      </div>
      <div className="panel-body">
        {suggestions.loading ? (
          <Spinner />
        ) : suggestions.error ? (
          <ErrorState error={suggestions.error} onRetry={suggestions.reload} compact />
        ) : (suggestions.data?.suggestions.length ?? 0) === 0 ? (
          <p className="text-sm text-secondary">
            Nothing unblocked and unassigned to suggest right now.
          </p>
        ) : (
          <div className="stack gap-3">
            {suggestions.data!.suggestions.map((suggestion) => (
              <Link
                key={suggestion.taskId}
                to={`/tasks/${suggestion.taskId}`}
                className="stack gap-1"
                style={{ color: "inherit" }}
              >
                <span className="text-sm medium">{suggestion.title}</span>
                <span className="text-xs text-tertiary">
                  {suggestion.reference} · {suggestion.projectName}
                </span>
                <span className="text-xs text-secondary">{suggestion.reasons[0]}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function greeting(name: string): string {
  const hour = new Date().getHours();
  const firstName = name.split(/\s+/)[0] ?? name;
  if (hour < 12) return `Good morning, ${firstName}`;
  if (hour < 18) return `Good afternoon, ${firstName}`;
  return `Good evening, ${firstName}`;
}
