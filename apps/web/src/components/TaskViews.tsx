/**
 * Task presentation: list rows, board cards, and the Kanban board itself.
 *
 * Drag-and-drop uses the native HTML5 API rather than a library: it keeps the
 * bundle small, works with the keyboard fallback (the status select on the
 * task page), and the server computes the final rank from the neighbouring
 * card ids, so two people dragging at once converge instead of fighting.
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
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

/**
 * Kanban board.
 *
 * Drag-and-drop shows a real insertion line rather than only tinting the
 * target column, so you can see where a card will land before you let go.
 * The drop index is computed from the pointer against each card's midpoint,
 * and the server derives the final rank from the neighbouring card ids — two
 * people dragging at once therefore converge instead of fighting.
 *
 * Dragging is not the only way to move a card: every card's status select on
 * its detail page does the same thing, and each column accepts a typed title
 * for quick capture.
 */
export function KanbanBoard({
  tasks,
  onMove,
  onAddTask,
  onQuickAdd,
  columns = BOARD_COLUMNS,
}: {
  tasks: Task[];
  /** Called with the dropped task and its new neighbours in the target column. */
  onMove: (
    task: Task,
    status: TaskStatus,
    neighbours: { beforeTaskId: string | null; afterTaskId: string | null },
  ) => void;
  /** Opens the full task dialog for this column. */
  onAddTask?: (status: TaskStatus) => void;
  /** Creates a task from just a title. Enables the inline composer. */
  onQuickAdd?: (status: TaskStatus, title: string) => Promise<unknown>;
  columns?: TaskStatus[];
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** Where the card would land: a column plus an index within it. */
  const [dropAt, setDropAt] = useState<{ status: TaskStatus; index: number } | null>(null);

  const byStatus = new Map<TaskStatus, Task[]>();
  for (const status of columns) byStatus.set(status, []);
  for (const task of tasks) byStatus.get(task.status)?.push(task);
  for (const list of byStatus.values()) list.sort((a, b) => a.position - b.position);

  /** The column as it will look mid-drag, with the dragged card removed. */
  const columnWithout = (status: TaskStatus) =>
    (byStatus.get(status) ?? []).filter((task) => task.id !== draggingId);

  const endDrag = () => {
    setDraggingId(null);
    setDropAt(null);
  };

  const commit = () => {
    const task = tasks.find((candidate) => candidate.id === draggingId);
    const target = dropAt;
    endDrag();
    if (!task || !target) return;

    const column = columnWithout(target.status);
    const before = target.index > 0 ? column[target.index - 1] : undefined;
    const after = column[target.index];

    // A drop back into the same slot is not sent: it would write an activity
    // entry for a move that did not happen.
    const currentIndex = (byStatus.get(task.status) ?? []).findIndex((c) => c.id === task.id);
    if (task.status === target.status && currentIndex === target.index) return;

    onMove(task, target.status, {
      beforeTaskId: before?.id ?? null,
      afterTaskId: after?.id ?? null,
    });
  };

  /**
   * Which gap the pointer is nearest, from the card midpoints. Measuring the
   * rendered geometry rather than tracking per-card enter/leave events means
   * the indicator does not flicker between adjacent cards.
   */
  const indexFromPointer = (container: HTMLElement, clientY: number): number => {
    const cards = [...container.querySelectorAll<HTMLElement>("[data-card]")].filter(
      (card) => card.dataset.card !== draggingId,
    );
    for (let i = 0; i < cards.length; i++) {
      const box = cards[i]!.getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return i;
    }
    return cards.length;
  };

  return (
    <div className={styles.board}>
      {columns.map((status) => {
        const column = byStatus.get(status) ?? [];
        const visible = columnWithout(status);
        const isTarget = dropAt?.status === status;

        return (
          <section
            key={status}
            className={`${styles.column} ${isTarget ? styles.columnDragOver : ""}`}
            aria-label={`${statusLabel(status)} column`}
            onDragOver={(event) => {
              if (!draggingId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const body = event.currentTarget.querySelector<HTMLElement>("[data-column-body]");
              if (!body) return;
              setDropAt({ status, index: indexFromPointer(body, event.clientY) });
            }}
            onDragLeave={(event) => {
              // Only clear when the pointer leaves the column, not a child card.
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setDropAt((current) => (current?.status === status ? null : current));
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              commit();
            }}
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
                  aria-label={`Add a task to ${statusLabel(status)} with full details`}
                  title="New task with full details"
                >
                  <Icon name="plus" size={13} />
                </button>
              )}
            </header>

            <div className={styles.columnBody} data-column-body>
              {visible.length === 0 && !isTarget && (
                <div className={styles.columnEmpty}>Nothing here</div>
              )}

              {/* The insertion line sits in the gap the card would occupy. */}
              {isTarget && dropAt.index === 0 && <DropIndicator />}

              {visible.map((task, index) => (
                <div key={task.id} data-card={task.id}>
                  <TaskCard
                    task={task}
                    dragging={draggingId === task.id}
                    onDragStart={(event) => {
                      setDraggingId(task.id);
                      event.dataTransfer.effectAllowed = "move";
                      // Some browsers refuse the drag without a payload.
                      event.dataTransfer.setData("text/plain", task.id);
                    }}
                    onDragEnd={endDrag}
                  />
                  {isTarget && dropAt.index === index + 1 && <DropIndicator />}
                </div>
              ))}
            </div>

            {onQuickAdd && (
              <div className={styles.columnFooter}>
                <QuickAdd status={status} onAdd={onQuickAdd} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function DropIndicator() {
  return <div className={styles.dropIndicator} aria-hidden />;
}

/**
 * Inline capture: a title and Enter.
 *
 * The full dialog has nine fields, which is the wrong weight for "add the
 * thing I just thought of". Everything else can be filled in later.
 */
function QuickAdd({
  status,
  onAdd,
}: {
  status: TaskStatus;
  onAdd: (status: TaskStatus, title: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onAdd(status, trimmed);
      // Stay open for a run of quick entries.
      setTitle("");
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className={styles.quickAddTrigger}
        onClick={() => setOpen(true)}
      >
        <Icon name="plus" size={13} />
        Add a task
      </button>
    );
  }

  return (
    <div className={styles.quickAdd}>
      <textarea
        ref={inputRef}
        className={styles.quickAddInput}
        rows={2}
        placeholder="What needs doing?"
        value={title}
        disabled={saving}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
          if (event.key === "Escape") {
            setTitle("");
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!title.trim()) setOpen(false);
        }}
        aria-label={`New task in ${statusLabel(status)}`}
      />
      <div className={styles.quickAddRow}>
        <span className="text-xs text-tertiary">
          <kbd>↵</kbd> to add · <kbd>esc</kbd> to close
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void submit()}
          disabled={saving || title.trim().length === 0}
        >
          {saving && <span className="spinner" />}
          Add
        </button>
      </div>
    </div>
  );
}
