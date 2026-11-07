/**
 * Task presentation: list rows, board cards, and the Kanban board itself.
 *
 * Drag-and-drop uses the native HTML5 API rather than a library: it keeps the
 * bundle small, works with the keyboard fallback (the status select on the
 * task page), and the server computes the final rank from the neighbouring
 * card ids, so two people dragging at once converge instead of fighting.
 */
import { useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { TASK_STATUSES, type Task, type TaskStatus } from "@workos/shared";
import { daysUntil, formatDate, statusLabel } from "../lib/hooks.js";
import { Avatar, Icon, PriorityIndicator } from "./ui/index.js";
import styles from "../pages/pages.module.css";

/** Columns shown on the board, in flow order. `canceled` is deliberately out. */
export const BOARD_COLUMNS: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
];

export function DueDate({ value, done }: { value: string | null; done?: boolean }) {
  if (!value) return null;
  const days = daysUntil(value);
  const overdue = !done && days !== null && days < 0;
  const soon = !done && days !== null && days >= 0 && days <= 2;

  return (
    <span
      className={`${styles.dueDate} ${overdue ? styles.dueDateOverdue : soon ? styles.dueDateSoon : ""}`}
      title={overdue ? `Overdue by ${Math.abs(days!)} day(s)` : `Due ${formatDate(value)}`}
    >
      {formatDate(value)}
    </span>
  );
}

export function TaskLabels({ labels }: { labels: Task["labels"] }) {
  if (labels.length === 0) return null;
  return (
    <span className={styles.taskLabels}>
      {labels.slice(0, 3).map((label) => (
        <span
          key={label.id}
          className={styles.taskLabel}
          style={{
            background: `color-mix(in srgb, ${label.color} 16%, transparent)`,
            color: label.color,
          }}
        >
          {label.name}
        </span>
      ))}
    </span>
  );
}

// ── List ────────────────────────────────────────────────────────────────────

export function TaskRow({
  task,
  onToggleDone,
}: {
  task: Task;
  onToggleDone?: (task: Task) => void;
}) {
  const done = task.status === "done";

  return (
    <div className={styles.taskRow}>
      {onToggleDone && (
        <button
          type="button"
          className={`${styles.taskStatusToggle} ${done ? styles.taskStatusToggleDone : ""}`}
          onClick={(event) => {
            event.preventDefault();
            onToggleDone(task);
          }}
          aria-label={done ? `Reopen ${task.reference}` : `Mark ${task.reference} done`}
          title={done ? "Reopen" : "Mark done"}
        >
          <Icon name="check" size={11} strokeWidth={2.4} />
        </button>
      )}

      <Link
        to={`/tasks/${task.id}`}
        className="row gap-3"
        style={{ flex: 1, minWidth: 0, color: "inherit" }}
      >
        <span className={styles.taskReference}>{task.reference}</span>
        <span className={`${styles.taskTitle} ${done ? styles.taskTitleDone : ""}`}>
          {task.title}
        </span>
      </Link>

      <span className={styles.taskMeta}>
        {task.isBlocked && (
          <span className={styles.blockedChip} title="Waiting on unfinished work">
            <Icon name="blocked" size={10} />
            Blocked
          </span>
        )}
        {task.createdByAi && (
          <span className={styles.aiChip} title="Created by AI, after human approval">
            <Icon name="sparkle" size={9} />
            AI
          </span>
        )}
        <TaskLabels labels={task.labels} />
        {task.commentCount > 0 && (
          <span className={styles.taskCardStat} title={`${task.commentCount} comments`}>
            <Icon name="message" size={11} />
            {task.commentCount}
          </span>
        )}
        <DueDate value={task.dueDate} done={done} />
        <PriorityIndicator priority={task.priority} />
        <Avatar user={task.assignee} size={22} />
      </span>
    </div>
  );
}

export function TaskList({
  tasks,
  onToggleDone,
  groupBy,
}: {
  tasks: Task[];
  onToggleDone?: (task: Task) => void;
  groupBy?: "status" | "project" | "none";
}) {
  if (groupBy === "none" || !groupBy) {
    return (
      <div className={styles.taskList}>
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} onToggleDone={onToggleDone} />
        ))}
      </div>
    );
  }

  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = groupBy === "status" ? task.status : task.projectName;
    const bucket = groups.get(key) ?? [];
    bucket.push(task);
    groups.set(key, bucket);
  }

  // Status groups follow the board's flow order; project groups are alphabetical.
  const ordered =
    groupBy === "status"
      ? TASK_STATUSES.filter((status) => groups.has(status)).map(
          (status) => [status, groups.get(status)!] as const,
        )
      : [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className={styles.taskList}>
      {ordered.map(([key, group]) => (
        <div key={key}>
          <div className={styles.taskGroupHeader}>
            <span>{groupBy === "status" ? statusLabel(key) : key}</span>
            <span className="text-tertiary">{group.length}</span>
          </div>
          {group.map((task) => (
            <TaskRow key={task.id} task={task} onToggleDone={onToggleDone} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Board ───────────────────────────────────────────────────────────────────

export function TaskCard({
  task,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  dragging?: boolean;
  onDragStart?: (event: DragEvent<HTMLAnchorElement>) => void;
  onDragEnd?: () => void;
}) {
  return (
    <Link
      to={`/tasks/${task.id}`}
      className={`${styles.taskCard} ${dragging ? styles.taskCardDragging : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className={styles.taskCardHeader}>
        <span className={styles.taskReference} style={{ width: "auto" }}>
          {task.reference}
        </span>
        <span className="spacer" />
        {task.isBlocked && (
          <Icon
            name="blocked"
            size={12}
            style={{ color: "var(--danger)" }}
            aria-label="Blocked"
          />
        )}
        {task.createdByAi && (
          <Icon
            name="sparkle"
            size={12}
            style={{ color: "var(--text-accent)" }}
            aria-label="Created by AI"
          />
        )}
        <PriorityIndicator priority={task.priority} />
      </div>

      <div className={styles.taskCardTitle}>{task.title}</div>

      {task.labels.length > 0 && (
        <div style={{ marginTop: "var(--space-2)" }}>
          <TaskLabels labels={task.labels} />
        </div>
      )}

      <div className={styles.taskCardFooter}>
        <Avatar user={task.assignee} size={20} />
        <span className="spacer" />
        {task.subtaskCount > 0 && (
          <span className={styles.taskCardStat} title="Subtasks done">
            <Icon name="check" size={11} />
            {task.doneSubtaskCount}/{task.subtaskCount}
          </span>
        )}
        {task.commentCount > 0 && (
          <span className={styles.taskCardStat}>
            <Icon name="message" size={11} />
            {task.commentCount}
          </span>
        )}
        {task.attachmentCount > 0 && (
          <span className={styles.taskCardStat}>
            <Icon name="paperclip" size={11} />
            {task.attachmentCount}
          </span>
        )}
        <DueDate value={task.dueDate} done={task.status === "done"} />
      </div>
    </Link>
  );
}

export function KanbanBoard({
  tasks,
  onMove,
  onAddTask,
  columns = BOARD_COLUMNS,
}: {
  tasks: Task[];
  /** Called with the dropped task and its new neighbours in the target column. */
  onMove: (
    task: Task,
    status: TaskStatus,
    neighbours: { beforeTaskId: string | null; afterTaskId: string | null },
  ) => void;
  onAddTask?: (status: TaskStatus) => void;
  columns?: TaskStatus[];
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);

  const byStatus = new Map<TaskStatus, Task[]>();
  for (const status of columns) byStatus.set(status, []);
  for (const task of tasks) {
    byStatus.get(task.status)?.push(task);
  }
  for (const list of byStatus.values()) list.sort((a, b) => a.position - b.position);

  const handleDrop = (status: TaskStatus, dropIndex: number) => {
    setDragOverColumn(null);
    const task = tasks.find((t) => t.id === draggingId);
    setDraggingId(null);
    if (!task) return;

    const column = (byStatus.get(status) ?? []).filter((t) => t.id !== task.id);
    const before = dropIndex > 0 ? column[dropIndex - 1] : undefined;
    const after = column[dropIndex];

    // No-op drops are not sent: dragging a card back where it was should not
    // produce an activity entry.
    if (task.status === status && before?.id === undefined && after?.id === column[0]?.id) {
      const currentIndex = (byStatus.get(status) ?? []).findIndex((t) => t.id === task.id);
      if (currentIndex === dropIndex) return;
    }

    onMove(task, status, {
      beforeTaskId: before?.id ?? null,
      afterTaskId: after?.id ?? null,
    });
  };

  return (
    <div className={styles.board}>
      {columns.map((status) => {
        const column = byStatus.get(status) ?? [];
        return (
          <section
            key={status}
            className={`${styles.column} ${dragOverColumn === status ? styles.columnDragOver : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOverColumn(status);
            }}
            onDragLeave={(event) => {
              // Only clear when leaving the column, not a child card.
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setDragOverColumn((current) => (current === status ? null : current));
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              handleDrop(status, column.filter((t) => t.id !== draggingId).length);
            }}
            aria-label={`${statusLabel(status)} column`}
          >
            <header className={styles.columnHeader}>
              <span className={styles.columnTitle}>{statusLabel(status)}</span>
              <span className={styles.columnCount}>{column.length}</span>
              <span className="spacer" />
              {onAddTask && (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => onAddTask(status)}
                  aria-label={`Add a task to ${statusLabel(status)}`}
                >
                  <Icon name="plus" size={13} />
                </button>
              )}
            </header>

            <div className={styles.columnBody}>
              {column.length === 0 ? (
                <div className={styles.columnEmpty}>
                  {dragOverColumn === status ? "Drop here" : "Nothing here"}
                </div>
              ) : (
                column.map((task, index) => (
                  <div
                    key={task.id}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleDrop(status, index);
                    }}
                  >
                    <TaskCard
                      task={task}
                      dragging={draggingId === task.id}
                      onDragStart={(event) => {
                        setDraggingId(task.id);
                        event.dataTransfer.effectAllowed = "move";
                        // Some browsers refuse the drag without any payload.
                        event.dataTransfer.setData("text/plain", task.id);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDragOverColumn(null);
                      }}
                    />
                  </div>
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
