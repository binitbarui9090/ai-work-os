import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PROJECT_STATUSES, type ProjectStatus } from "@workos/shared";
import { api } from "../lib/api.js";
import { errorMessage, formatDate, pluralise, useAsync, useMutation } from "../lib/hooks.js";
import { useRealtimeEvent } from "../lib/realtime.js";
import { useWorkspace } from "../lib/session.js";
import { PageHeader } from "../components/PageHeader.js";
import {
  Avatar,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRows,
  Modal,
  Notice,
  ProgressBar,
  SegmentedControl,
  useToast,
} from "../components/ui/index.js";
import styles from "./pages.module.css";

export function ProjectsPage() {
  const workspace = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState<"active" | "all" | "archived">("active");

  const projects = useAsync(
    () =>
      api.projects.list({
        includeArchived: statusFilter === "archived" || statusFilter === "all",
      }),
    [workspace.id, statusFilter],
  );

  useRealtimeEvent(["project.created", "project.updated"], () => projects.reload());

  // `?new=1` opens the create dialog, so the command palette can link to it.
  const createOpen = searchParams.get("new") === "1";
  const setCreateOpen = (open: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (open) next.set("new", "1");
    else next.delete("new");
    setSearchParams(next, { replace: true });
  };

  const visible = (projects.data?.projects ?? []).filter((project) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "archived") return project.status === "archived";
    return project.status !== "archived" && project.status !== "completed";
  });

  const canCreate = workspace.role !== "guest";

  return (
    <div className="fade-in">
      <PageHeader
        title="Projects"
        subtitle="Everything your team is working on, with live task counts."
        actions={
          canCreate ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={14} />
              New project
            </button>
          ) : undefined
        }
      />

      <div className={styles.toolbar}>
        <SegmentedControl
          ariaLabel="Filter projects"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { id: "active", label: "Active" },
            { id: "all", label: "All" },
            { id: "archived", label: "Archived" },
          ]}
        />
      </div>

      {projects.loading && !projects.data ? (
        <LoadingRows rows={4} />
      ) : projects.error ? (
        <ErrorState error={projects.error} onRetry={projects.reload} />
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="board"
            title={statusFilter === "archived" ? "No archived projects" : "No projects yet"}
            body={
              statusFilter === "archived"
                ? "Archived projects stay searchable but are hidden from the sidebar."
                : "Start one from scratch, or paste a brief and let the planner draft the whole thing for you to approve."
            }
            action={
              canCreate && statusFilter !== "archived" ? (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setCreateOpen(true)}
                  >
                    New project
                  </button>
                  <Link to="/ai/plan" className="btn btn-secondary">
                    <Icon name="sparkle" size={14} />
                    Plan from a brief
                  </Link>
                </>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className={styles.cardGrid}>
          {visible.map((project) => (
            <Link key={project.id} to={`/projects/${project.id}`} className={styles.projectCard}>
              <div className={styles.projectCardTop}>
                <span className={styles.projectSwatch} style={{ background: project.color }}>
                  {project.key.slice(0, 2)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className={styles.projectName}>{project.name}</div>
                  <div className={styles.projectKey}>
                    {project.key} · {project.status.replace(/_/g, " ")}
                  </div>
                </div>
              </div>

              {project.description && (
                <p className={styles.projectDescription}>{project.description}</p>
              )}

              <ProgressBar percent={project.progressPercent} color={project.color} />

              <div className={styles.projectFooter}>
                <span>
                  {project.completedTaskCount}/
                  {project.completedTaskCount + project.openTaskCount} done
                </span>
                {project.overdueTaskCount > 0 && (
                  <span className="badge badge-danger">{project.overdueTaskCount} late</span>
                )}
                {project.blockedTaskCount > 0 && (
                  <span className="badge badge-warning">{project.blockedTaskCount} blocked</span>
                )}
                <span className="spacer" />
                {project.targetDate && <span>{formatDate(project.targetDate)}</span>}
                {project.lead && <Avatar user={project.lead} size={18} />}
              </div>
            </Link>
          ))}
        </div>
      )}

      <CreateProjectDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

export function CreateProjectDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const workspace = useWorkspace();
  const members = useAsync(() => api.workspaces.members(), [workspace.id]);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [targetDate, setTargetDate] = useState("");
  const [leadId, setLeadId] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setStatus("active");
    setTargetDate("");
    setLeadId("");
  }, [open]);

  const create = useMutation(async () => {
    const result = await api.projects.create({
      name: name.trim(),
      description: description.trim() || null,
      status,
      targetDate: targetDate || null,
      leadId: leadId || null,
    });
    toast.success(`Created ${result.project.key}`, result.project.name);
    onClose();
    navigate(`/projects/${result.project.id}`);
    return result;
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      description="A project groups tasks, milestones, documents and meetings."
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void create.run()}
            disabled={create.pending || name.trim().length < 2}
          >
            {create.pending && <span className="spinner" />}
            Create project
          </button>
        </>
      }
    >
      <div className="stack gap-4">
        {create.error && <Notice tone="danger">{errorMessage(create.error)}</Notice>}

        <div className="field">
          <label className="label" htmlFor="project-name">
            Name
          </label>
          <input
            id="project-name"
            className="input"
            placeholder="Atlas Billing Migration"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="project-description">
            What is this for?
          </label>
          <textarea
            id="project-description"
            className="textarea"
            placeholder="The outcome, the constraints, and what success looks like."
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <span className="field-hint">
            Worth writing properly — the AI reads this when answering questions about the project.
          </span>
        </div>

        <div className="row gap-4" style={{ alignItems: "flex-start" }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="project-status">
              Status
            </label>
            <select
              id="project-status"
              className="select"
              value={status}
              onChange={(event) => setStatus(event.target.value as ProjectStatus)}
            >
              {PROJECT_STATUSES.filter((s) => s !== "archived").map((option) => (
                <option key={option} value={option}>
                  {option.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="project-target">
              Target date
            </label>
            <input
              id="project-target"
              className="input"
              type="date"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="project-lead">
            Lead
          </label>
          <select
            id="project-lead"
            className="select"
            value={leadId}
            onChange={(event) => setLeadId(event.target.value)}
          >
            <option value="">No lead yet</option>
            {(members.data?.members ?? []).map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}

export { pluralise };
