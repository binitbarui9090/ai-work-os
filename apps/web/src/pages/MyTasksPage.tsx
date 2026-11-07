import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Task } from "@workos/shared";
import { api } from "../lib/api.js";
import { pluralise, useAsync, useDebounced, useMutation } from "../lib/hooks.js";
import { useRealtimeEvent } from "../lib/realtime.js";
import { useWorkspace } from "../lib/session.js";
import { PageHeader } from "../components/PageHeader.js";
import { TaskList } from "../components/TaskViews.js";
import {
  EmptyState,
  ErrorState,
  Icon,
  LoadingRows,
  SegmentedControl,
} from "../components/ui/index.js";
import styles from "./pages.module.css";

type Scope = "mine" | "unassigned" | "all";
type Grouping = "status" | "project" | "none";

export function MyTasksPage() {
  const workspace = useWorkspace();
  const [scope, setScope] = useState<Scope>("mine");
  const [grouping, setGrouping] = useState<Grouping>("project");
  const [query, setQuery] = useState("");
  const [includeDone, setIncludeDone] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);

  const debouncedQuery = useDebounced(query, 220);

  const loaded = useAsync(
    () =>
      api.tasks.list({
        assigneeId: scope === "all" ? undefined : scope === "mine" ? "me" : "unassigned",
        q: debouncedQuery.trim() || undefined,
        includeDone,
        limit: 500,
      }),
    [workspace.id, scope, debouncedQuery, includeDone],
  );

  useEffect(() => {
    if (loaded.data) setTasks(loaded.data.tasks);
  }, [loaded.data]);

  useRealtimeEvent("task.updated", (event) => {
    setTasks((prev) => prev.map((task) => (task.id === event.task.id ? event.task : task)));
  });

  const toggleDone = useMutation(async (task: Task) => {
    const result = await api.tasks.update(task.id, {
      status: task.status === "done" ? "todo" : "done",
    });
    // Completed work leaves the list unless it is being shown deliberately.
    setTasks((prev) =>
      includeDone
        ? prev.map((candidate) => (candidate.id === task.id ? result.task : candidate))
        : prev.filter((candidate) => candidate.id !== task.id),
    );
    return result;
  });

  const counts = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      overdue: tasks.filter(
        (task) => task.dueDate && task.dueDate < today && task.status !== "done",
      ).length,
      blocked: tasks.filter((task) => task.isBlocked).length,
      inProgress: tasks.filter((task) => task.status === "in_progress").length,
    };
  }, [tasks]);

  return (
    <div className="fade-in">
      <PageHeader
        title="My tasks"
        subtitle="Everything assigned to you across every project."
      />

      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Open</div>
          <div className={styles.statValue}>{tasks.filter((t) => t.status !== "done").length}</div>
        </div>
        <div className={`${styles.stat} ${counts.overdue > 0 ? styles.statAlert : ""}`}>
          <div className={styles.statLabel}>Overdue</div>
          <div className={styles.statValue}>{counts.overdue}</div>
        </div>
        <div className={`${styles.stat} ${counts.blocked > 0 ? styles.statAlert : ""}`}>
          <div className={styles.statLabel}>Blocked</div>
          <div className={styles.statValue}>{counts.blocked}</div>
          <div className={styles.statMeta}>Not actionable right now</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>In progress</div>
          <div className={styles.statValue}>{counts.inProgress}</div>
          <div className={styles.statMeta}>Finishing beats starting</div>
        </div>
      </div>

      <div className={styles.toolbar}>
        <SegmentedControl
          ariaLabel="Scope"
          value={scope}
          onChange={setScope}
          options={[
            { id: "mine", label: "Mine", icon: "user" },
            { id: "unassigned", label: "Unassigned" },
            { id: "all", label: "Everyone", icon: "users" },
          ]}
        />

        <input
          className={`input ${styles.toolbarSearch}`}
          placeholder="Filter by title…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter tasks"
        />

        <select
          className={`select ${styles.toolbarSelect}`}
          value={grouping}
          onChange={(event) => setGrouping(event.target.value as Grouping)}
          aria-label="Group by"
        >
          <option value="project">Group by project</option>
          <option value="status">Group by status</option>
          <option value="none">No grouping</option>
        </select>

        <label className="row gap-2 text-xs text-secondary" style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            className="checkbox"
            checked={includeDone}
            onChange={(event) => setIncludeDone(event.target.checked)}
          />
          Show completed
        </label>

        <span className="spacer" />
        <span className="text-xs text-tertiary">{pluralise(tasks.length, "task")}</span>
      </div>

      {loaded.loading && tasks.length === 0 ? (
        <LoadingRows rows={6} />
      ) : loaded.error ? (
        <ErrorState error={loaded.error} onRetry={loaded.reload} />
      ) : tasks.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="check"
            title={
              scope === "mine"
                ? "Nothing assigned to you"
                : scope === "unassigned"
                  ? "Everything has an owner"
                  : "No tasks match"
            }
            body={
              scope === "mine"
                ? "When someone assigns you work it shows up here. In the meantime, the home page suggests what to pick up."
                : scope === "unassigned"
                  ? "Every active task has someone responsible for it."
                  : "Try clearing the filter."
            }
            action={
              scope === "mine" ? (
                <Link to="/" className="btn btn-secondary">
                  <Icon name="arrow-right" size={14} />
                  See suggestions
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : (
        <TaskList
          tasks={tasks}
          groupBy={grouping}
          onToggleDone={workspace.role !== "guest" ? (task) => void toggleDone.run(task) : undefined}
        />
      )}
    </div>
  );
}
