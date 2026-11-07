/**
 * Project detail: board, list and calendar views over the same task set.
 *
 * Task mutations are optimistic where the outcome is predictable (a board drag)
 * and reconciled from the server response, so a rejected move snaps back
 * instead of leaving the UI lying about where the card is.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Milestone, Task, TaskStatus } from "@workos/shared";
import { api } from "../lib/api.js";
import {
  errorMessage,
  formatDate,
  pluralise,
  useAsync,
  useMutation,
} from "../lib/hooks.js";
import { useChannel, useRealtimeEvent } from "../lib/realtime.js";
import { useWorkspace } from "../lib/session.js";
import { PageHeader, SectionHeader } from "../components/PageHeader.js";
import { KanbanBoard, TaskList } from "../components/TaskViews.js";
import {
  AvatarGroup,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRows,
  ProgressBar,
  SegmentedControl,
  useToast,
} from "../components/ui/index.js";
import { CreateTaskDialog } from "./TaskDialog.js";
import styles from "./pages.module.css";

type View = "board" | "list" | "calendar";

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const workspace = useWorkspace();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const view = (searchParams.get("view") as View | null) ?? "board";
  const setView = (next: View) => {
    const params = new URLSearchParams(searchParams);
    params.set("view", next);
    setSearchParams(params, { replace: true });
  };

  const [tasks, setTasks] = useState<Task[]>([]);
  const [createStatus, setCreateStatus] = useState<TaskStatus | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [showDone, setShowDone] = useState(true);

  const project = useAsync(() => api.projects.get(projectId), [projectId]);
  const taskData = useAsync(
    () => api.tasks.list({ projectId, includeDone: true, limit: 500 }),
    [projectId],
  );
  const members = useAsync(() => api.workspaces.members(), [workspace.id]);

  useEffect(() => {
    if (taskData.data) setTasks(taskData.data.tasks);
  }, [taskData.data]);

  useChannel(`project:${projectId}`);

  useRealtimeEvent("task.created", (event) => {
    if (event.task.projectId !== projectId) return;
    setTasks((prev) => (prev.some((t) => t.id === event.task.id) ? prev : [...prev, event.task]));
  });

  useRealtimeEvent("task.updated", (event) => {
    if (event.task.projectId !== projectId) return;
    setTasks((prev) => prev.map((t) => (t.id === event.task.id ? event.task : t)));
  });

  useRealtimeEvent("task.deleted", (event) => {
    setTasks((prev) => prev.filter((t) => t.id !== event.taskId));
  });

  useRealtimeEvent("project.updated", (event) => {
    if (event.project.id === projectId) project.reload();
  });

  const move = useMutation(
    async (
      task: Task,
      status: TaskStatus,
      neighbours: { beforeTaskId: string | null; afterTaskId: string | null },
    ) => {
      // Optimistic: move the card immediately, then reconcile.
      const previous = tasks;
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status } : t)));
      try {
        const result = await api.tasks.move(task.id, { status, ...neighbours });
        setTasks((prev) => prev.map((t) => (t.id === task.id ? result.task : t)));
        return result;
      } catch (err) {
        setTasks(previous);
        toast.error("Could not move that task", errorMessage(err));
        throw err;
      }
    },
  );

  const toggleDone = useMutation(async (task: Task) => {
    const result = await api.tasks.update(task.id, {
      status: task.status === "done" ? "todo" : "done",
    });
    setTasks((prev) => prev.map((t) => (t.id === task.id ? result.task : t)));
    return result;
  });

  const filtered = useMemo(() => {
    let result = tasks;
    if (assigneeFilter === "unassigned") result = result.filter((t) => !t.assignee);
    else if (assigneeFilter) result = result.filter((t) => t.assignee?.id === assigneeFilter);
    if (!showDone) result = result.filter((t) => t.status !== "done" && t.status !== "canceled");
    return result;
  }, [tasks, assigneeFilter, showDone]);

  if (project.loading && !project.data) {
    return (
      <>
        <PageHeader title="Loading project" />
        <LoadingRows rows={5} />
      </>
    );
  }

  if (project.error || !project.data) {
    return <ErrorState error={project.error} onRetry={project.reload} />;
  }

  const { project: detail, members: projectMembers, milestones } = project.data;
  const canEdit = workspace.role !== "guest";

  return (
    <div className="fade-in">
      <PageHeader
        breadcrumbs={[{ label: "Projects", to: "/projects" }, { label: detail.key }]}
        title={
          <>
            <span className={styles.projectSwatch} style={{ background: detail.color }}>
              {detail.key.slice(0, 2)}
            </span>
            {detail.name}
          </>
        }
        badge={<span className="badge">{detail.status.replace(/_/g, " ")}</span>}
        subtitle={detail.description}
        actions={
          <>
            {projectMembers.length > 0 && <AvatarGroup users={projectMembers} size={24} />}
            {canEdit && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setCreateStatus("todo")}
              >
                <Icon name="plus" size={14} />
                New task
              </button>
            )}
          </>
        }
      />

      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Progress</div>
          <div className={styles.statValue}>{detail.progressPercent}%</div>
          <div style={{ marginTop: "var(--space-3)" }}>
            <ProgressBar percent={detail.progressPercent} color={detail.color} />
          </div>
          <div className={styles.statMeta}>
            {detail.completedTaskCount} of {detail.completedTaskCount + detail.openTaskCount} done
          </div>
        </div>
        <div className={`${styles.stat} ${detail.overdueTaskCount > 0 ? styles.statAlert : ""}`}>
          <div className={styles.statLabel}>
            <Icon name="clock" size={13} />
            Overdue
          </div>
          <div className={styles.statValue}>{detail.overdueTaskCount}</div>
          <div className={styles.statMeta}>
            {detail.targetDate ? `Target ${formatDate(detail.targetDate)}` : "No target date set"}
          </div>
        </div>
        <div className={`${styles.stat} ${detail.blockedTaskCount > 0 ? styles.statAlert : ""}`}>
          <div className={styles.statLabel}>
            <Icon name="blocked" size={13} />
            Blocked
          </div>
          <div className={styles.statValue}>{detail.blockedTaskCount}</div>
          <div className={styles.statMeta}>Waiting on upstream tasks</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>
            <Icon name="flag" size={13} />
            Milestones
          </div>
          <div className={styles.statValue}>
            {milestones.filter((m) => m.completedAt).length}/{milestones.length}
          </div>
          <div className={styles.statMeta}>
            {detail.lead ? `Led by ${detail.lead.name}` : "No lead assigned"}
          </div>
        </div>
      </div>

      {milestones.length > 0 && (
        <section style={{ marginBottom: "var(--space-6)" }}>
          <SectionHeader title="Milestones" />
          <MilestoneStrip milestones={milestones} />
        </section>
      )}

      <div className={styles.toolbar}>
        <SegmentedControl
          ariaLabel="View"
          value={view}
          onChange={setView}
          options={[
            { id: "board", label: "Board", icon: "board" },
            { id: "list", label: "List", icon: "list" },
            { id: "calendar", label: "Calendar", icon: "calendar" },
          ]}
        />

        <select
          className={`select ${styles.toolbarSelect}`}
          value={assigneeFilter}
          onChange={(event) => setAssigneeFilter(event.target.value)}
          aria-label="Filter by assignee"
        >
          <option value="">Everyone</option>
          <option value="unassigned">Unassigned</option>
          {(members.data?.members ?? []).map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
        </select>

        <label className="row gap-2 text-xs text-secondary" style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            className="checkbox"
            checked={showDone}
            onChange={(event) => setShowDone(event.target.checked)}
          />
          Show completed
        </label>

        <span className="spacer" />
        <span className="text-xs text-tertiary">{pluralise(filtered.length, "task")}</span>
      </div>

      {taskData.loading && tasks.length === 0 ? (
        <LoadingRows rows={5} />
      ) : taskData.error ? (
        <ErrorState error={taskData.error} onRetry={taskData.reload} />
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="list"
            title={tasks.length === 0 ? "No tasks yet" : "Nothing matches those filters"}
            body={
              tasks.length === 0
                ? "Add the first task, or paste a brief into the planner and get a whole plan to review."
                : "Try clearing the assignee filter."
            }
            action={
              tasks.length === 0 && canEdit ? (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setCreateStatus("todo")}
                  >
                    New task
                  </button>
                  <Link to={`/ai/plan?projectId=${projectId}`} className="btn btn-secondary">
                    <Icon name="sparkle" size={14} />
                    Plan this project
                  </Link>
                </>
              ) : undefined
            }
          />
        </div>
      ) : view === "board" ? (
        <KanbanBoard
          tasks={filtered}
          onMove={(task, status, neighbours) => void move.run(task, status, neighbours)}
          onAddTask={canEdit ? (status) => setCreateStatus(status) : undefined}
        />
      ) : view === "list" ? (
        <TaskList
          tasks={filtered}
          groupBy="status"
          onToggleDone={canEdit ? (task) => void toggleDone.run(task) : undefined}
        />
      ) : (
        <CalendarView tasks={filtered} />
      )}

      <CreateTaskDialog
        open={createStatus !== null}
        onClose={() => setCreateStatus(null)}
        projectId={projectId}
        initialStatus={createStatus ?? "todo"}
        milestones={milestones}
        onCreated={(task) => setTasks((prev) => [...prev, task])}
      />
    </div>
  );
}

function MilestoneStrip({ milestones }: { milestones: Milestone[] }) {
  return (
    <div className="stack gap-2">
      {milestones.map((milestone) => {
        const percent =
          milestone.taskCount === 0
            ? 0
            : Math.round((milestone.doneTaskCount / milestone.taskCount) * 100);
        const complete = Boolean(milestone.completedAt);
        return (
          <div key={milestone.id} className="card card-padded">
            <div className="row gap-3" style={{ marginBottom: "var(--space-2)" }}>
              <Icon
                name={complete ? "check" : "flag"}
                size={14}
                style={{ color: complete ? "var(--success)" : "var(--text-tertiary)" }}
              />
              <span className="text-sm medium">{milestone.name}</span>
              {complete && <span className="badge badge-success">Complete</span>}
              <span className="spacer" />
              <span className="text-xs text-tertiary">
                {milestone.doneTaskCount}/{milestone.taskCount} tasks
              </span>
              {milestone.dueDate && (
                <span className="text-xs text-tertiary">{formatDate(milestone.dueDate)}</span>
              )}
            </div>
            <ProgressBar percent={percent} />
            {milestone.description && (
              <p
                className="text-xs text-secondary"
                style={{ marginTop: "var(--space-2)", lineHeight: "var(--leading-snug)" }}
              >
                {milestone.description}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Calendar view: tasks grouped by due date.
 *
 * A month grid would hide everything without a date, which in practice is most
 * of the backlog — so this groups by week and calls out the undated tasks.
 */
function CalendarView({ tasks }: { tasks: Task[] }) {
  const { dated, undated } = useMemo(() => {
    const withDates = tasks.filter((task) => task.dueDate);
    const groups = new Map<string, Task[]>();
    for (const task of withDates) {
      const bucket = groups.get(task.dueDate!) ?? [];
      bucket.push(task);
      groups.set(task.dueDate!, bucket);
    }
    return {
      dated: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)),
      undated: tasks.filter((task) => !task.dueDate),
    };
  }, [tasks]);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="stack gap-5">
      {dated.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="calendar"
            title="No due dates set"
            body="Add due dates to see work laid out over time."
            compact
          />
        </div>
      ) : (
        <div className="stack gap-4">
          {dated.map(([date, group]) => {
            const past = date < today;
            const isToday = date === today;
            return (
              <section key={date}>
                <div className="row gap-2" style={{ marginBottom: "var(--space-2)" }}>
                  <span
                    className="text-sm semibold"
                    style={{ color: past ? "var(--danger)" : undefined }}
                  >
                    {formatDate(date)}
                  </span>
                  {isToday && <span className="badge badge-accent">Today</span>}
                  {past && <span className="badge badge-danger">Overdue</span>}
                  <span className="spacer" />
                  <span className="text-xs text-tertiary">{pluralise(group.length, "task")}</span>
                </div>
                <TaskList tasks={group} />
              </section>
            );
          })}
        </div>
      )}

      {undated.length > 0 && (
        <section>
          <SectionHeader title={`No due date (${undated.length})`} />
          <TaskList tasks={undated} />
        </section>
      )}
    </div>
  );
}
