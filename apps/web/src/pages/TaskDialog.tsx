import { useEffect, useState } from "react";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Milestone,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@workos/shared";
import { api } from "../lib/api.js";
import { errorMessage, statusLabel, useAsync, useMutation } from "../lib/hooks.js";
import { useWorkspace } from "../lib/session.js";
import { Modal, Notice, useToast } from "../components/ui/index.js";

export function CreateTaskDialog({
  open,
  onClose,
  projectId,
  initialStatus = "todo",
  milestones = [],
  parentTaskId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  initialStatus?: TaskStatus;
  milestones?: Milestone[];
  parentTaskId?: string;
  onCreated?: (task: Task) => void;
}) {
  const workspace = useWorkspace();
  const toast = useToast();
  const members = useAsync(() => api.workspaces.members(), [workspace.id]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskStatus>(initialStatus);
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [estimateHours, setEstimateHours] = useState("");
  const [milestoneId, setMilestoneId] = useState("");
  const [labels, setLabels] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setStatus(initialStatus);
    setPriority("none");
    setAssigneeId("");
    setDueDate("");
    setEstimateHours("");
    setMilestoneId("");
    setLabels("");
  }, [open, initialStatus]);

  const create = useMutation(async (keepOpen: boolean) => {
    const parsedEstimate = estimateHours.trim() === "" ? null : Number(estimateHours);
    const result = await api.tasks.create({
      projectId,
      title: title.trim(),
      description: description.trim() || null,
      status,
      priority,
      assigneeId: assigneeId || null,
      dueDate: dueDate || null,
      estimateHours:
        parsedEstimate !== null && Number.isFinite(parsedEstimate) ? parsedEstimate : null,
      milestoneId: milestoneId || null,
      parentTaskId: parentTaskId ?? null,
      labels: labels
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean),
    });

    onCreated?.(result.task);
    toast.success(`Created ${result.task.reference}`, result.task.title);

    if (keepOpen) {
      // Rapid entry: keep the dialog and the shared fields, clear the specifics.
      setTitle("");
      setDescription("");
      setEstimateHours("");
    } else {
      onClose();
    }
    return result;
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={parentTaskId ? "New subtask" : "New task"}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void create.run(true)}
            disabled={create.pending || title.trim().length < 2}
            title="Create and keep this dialog open"
          >
            Create &amp; add another
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void create.run(false)}
            disabled={create.pending || title.trim().length < 2}
          >
            {create.pending && <span className="spinner" />}
            Create task
          </button>
        </>
      }
    >
      <div className="stack gap-4">
        {create.error && <Notice tone="danger">{errorMessage(create.error)}</Notice>}

        <div className="field">
          <label className="label" htmlFor="task-title">
            Title
          </label>
          <input
            id="task-title"
            className="input"
            placeholder="Something a single person can finish"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                void create.run(false);
              }
            }}
            autoFocus
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="task-description">
            Description
          </label>
          <textarea
            id="task-description"
            className="textarea"
            placeholder="What needs doing, and how you will know it is done."
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="row gap-3" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="task-status">
              Status
            </label>
            <select
              id="task-status"
              className="select"
              value={status}
              onChange={(event) => setStatus(event.target.value as TaskStatus)}
            >
              {TASK_STATUSES.filter((s) => s !== "canceled").map((option) => (
                <option key={option} value={option}>
                  {statusLabel(option)}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="task-priority">
              Priority
            </label>
            <select
              id="task-priority"
              className="select"
              value={priority}
              onChange={(event) => setPriority(event.target.value as TaskPriority)}
            >
              {TASK_PRIORITIES.map((option) => (
                <option key={option} value={option}>
                  {statusLabel(option)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="row gap-3" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="task-assignee">
              Assignee
            </label>
            <select
              id="task-assignee"
              className="select"
              value={assigneeId}
              onChange={(event) => setAssigneeId(event.target.value)}
            >
              <option value="">Unassigned</option>
              {(members.data?.members ?? []).map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="task-due">
              Due date
            </label>
            <input
              id="task-due"
              className="input"
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </div>

          <div className="field" style={{ width: 110 }}>
            <label className="label" htmlFor="task-estimate">
              Estimate (h)
            </label>
            <input
              id="task-estimate"
              className="input"
              type="number"
              min={0}
              step={0.5}
              placeholder="—"
              value={estimateHours}
              onChange={(event) => setEstimateHours(event.target.value)}
            />
          </div>
        </div>

        <div className="row gap-3" style={{ alignItems: "flex-start" }}>
          {milestones.length > 0 && (
            <div className="field" style={{ flex: 1 }}>
              <label className="label" htmlFor="task-milestone">
                Milestone
              </label>
              <select
                id="task-milestone"
                className="select"
                value={milestoneId}
                onChange={(event) => setMilestoneId(event.target.value)}
              >
                <option value="">None</option>
                {milestones.map((milestone) => (
                  <option key={milestone.id} value={milestone.id}>
                    {milestone.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="task-labels">
              Labels
            </label>
            <input
              id="task-labels"
              className="input"
              placeholder="backend, migration"
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
            />
            <span className="field-hint">Comma separated.</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
