/**
 * Brief → plan.
 *
 * The screen makes the two-step nature obvious: generating a plan writes
 * nothing, and a separate approval applies it. The whole proposal is shown
 * before that decision — tasks, dependencies, risks, and the questions the
 * planner could not answer from the brief.
 */
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { GeneratedPlan } from "@workos/shared";
import { api } from "../lib/api.js";
import { errorMessage, pluralise, useAsync, useMutation } from "../lib/hooks.js";
import { useWorkspace } from "../lib/session.js";
import { PageHeader, SectionHeader } from "../components/PageHeader.js";
import {
  EmptyState,
  Icon,
  Notice,
  RiskBadge,
  Spinner,
  useToast,
} from "../components/ui/index.js";
import styles from "./ai.module.css";

const EXAMPLE_BRIEF = `We need to replace our current payment gateway. Fees went up 40% last quarter and their webhook delivery has been unreliable since the summer — we've had three incidents where subscription renewals silently failed.

Existing subscriptions must keep working throughout; we cannot ask customers to re-enter card details. Finance needs the quarterly revenue report to keep working the whole time.

Two backend engineers available, one of them part time. We'd like this done before the end of the quarter but the hard constraint is the annual audit in about ten weeks.`;

export function AiPlanPage() {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [brief, setBrief] = useState("");
  const [projectName, setProjectName] = useState("");
  const [targetProjectId, setTargetProjectId] = useState(searchParams.get("projectId") ?? "");
  const [targetDate, setTargetDate] = useState("");
  const [teamSize, setTeamSize] = useState("");

  const [plan, setPlan] = useState<GeneratedPlan | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const capabilities = useAsync(() => api.ai.capabilities(), [workspace.id]);
  const projects = useAsync(() => api.projects.list(), [workspace.id]);

  const generate = useMutation(async () => {
    setPlan(null);
    setActionId(null);
    setApplied(null);

    const parsedTeamSize = teamSize.trim() === "" ? undefined : Number(teamSize);
    const response = await api.ai.plan({
      brief: brief.trim(),
      projectName: projectName.trim() || undefined,
      targetProjectId: targetProjectId || null,
      targetDate: targetDate || null,
      teamSize:
        parsedTeamSize !== undefined && Number.isFinite(parsedTeamSize) ? parsedTeamSize : undefined,
    });

    setPlan(response.proposal.plan);
    setActionId(response.proposal.actionId);
    // When approvals are off the server applies it immediately and says so.
    if (response.applied) {
      setApplied(response.applied);
      toast.success("Plan applied", "This workspace does not require AI approval.");
    }
    return response;
  });

  const approve = useMutation(async () => {
    if (!actionId) return;
    const result = await api.ai.decide(actionId, { decision: "approve" });

    if (result.action.status === "executed") {
      setApplied(result.output);
      toast.success("Plan applied", result.output?.split("\n")[0] ?? undefined);
      // Jump to the project that was just created or filled in.
      const match = /id=([0-9a-f-]{36})/.exec(result.output ?? "");
      if (match) navigate(`/projects/${match[1]}`);
    } else {
      toast.error("The plan could not be applied", result.action.error ?? undefined);
    }
    return result;
  });

  const reject = useMutation(async () => {
    if (!actionId) return;
    await api.ai.decide(actionId, { decision: "reject" });
    setPlan(null);
    setActionId(null);
    toast.info("Plan discarded", "Nothing was created.");
  });

  const capability = capabilities.data?.capabilities;
  const disabled = capability ? !capability.chatEnabled : false;

  return (
    <div className="fade-in">
      <PageHeader
        title="Plan from a brief"
        subtitle="Paste what you have — a message, a doc, rough notes. You get a reviewable plan: milestones, tasks, dependencies, risks and the questions it could not answer."
      />

      {disabled && (
        <div style={{ marginBottom: "var(--space-5)" }}>
          <Notice tone="warning" title="Planning is unavailable">
            {capability?.disabledReason}
          </Notice>
        </div>
      )}

      <div className={styles.planSplit}>
        <div className={styles.briefBox}>
          <div className="field">
            <label className="label" htmlFor="brief">
              The brief
            </label>
            <textarea
              id="brief"
              className={`textarea ${styles.briefInput}`}
              placeholder="What needs to happen, why, what the constraints are, and who is available."
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              disabled={disabled || generate.pending}
            />
            <span className="field-hint">
              {brief.trim().length < 40
                ? `${40 - brief.trim().length} more characters needed`
                : `${brief.trim().length} characters`}
              {" · "}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ height: "auto", padding: 0, color: "var(--text-accent)" }}
                onClick={() => setBrief(EXAMPLE_BRIEF)}
              >
                use an example
              </button>
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="target-project">
              Where should this go?
            </label>
            <select
              id="target-project"
              className="select"
              value={targetProjectId}
              onChange={(event) => setTargetProjectId(event.target.value)}
              disabled={disabled || generate.pending}
            >
              <option value="">Create a new project</option>
              {(projects.data?.projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  Add to {project.name}
                </option>
              ))}
            </select>
          </div>

          {!targetProjectId && (
            <div className="field">
              <label className="label" htmlFor="project-name-override">
                Project name
              </label>
              <input
                id="project-name-override"
                className="input"
                placeholder="Leave blank and the planner will name it"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                disabled={disabled || generate.pending}
              />
            </div>
          )}

          <div className="row gap-3" style={{ alignItems: "flex-start" }}>
            <div className="field" style={{ flex: 1 }}>
              <label className="label" htmlFor="plan-target-date">
                Target date
              </label>
              <input
                id="plan-target-date"
                className="input"
                type="date"
                value={targetDate}
                onChange={(event) => setTargetDate(event.target.value)}
                disabled={disabled || generate.pending}
              />
            </div>
            <div className="field" style={{ width: 110 }}>
              <label className="label" htmlFor="plan-team-size">
                Team size
              </label>
              <input
                id="plan-team-size"
                className="input"
                type="number"
                min={1}
                placeholder="—"
                value={teamSize}
                onChange={(event) => setTeamSize(event.target.value)}
                disabled={disabled || generate.pending}
              />
            </div>
          </div>

          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            onClick={() => void generate.run()}
            disabled={disabled || generate.pending || brief.trim().length < 40}
          >
            {generate.pending ? <span className="spinner" /> : <Icon name="sparkle" size={15} />}
            {generate.pending ? "Planning…" : "Generate plan"}
          </button>

          <p className="field-hint">
            Generating a plan does not change anything. You review it first, then approve.
          </p>

          {generate.error && <Notice tone="danger">{errorMessage(generate.error)}</Notice>}
        </div>

        <div className={styles.planResult}>
          {generate.pending ? (
            <div className="card">
              <div style={{ padding: "var(--space-12)", textAlign: "center" }}>
                <Spinner label="Reading the brief and drafting a plan" />
                <p
                  className="text-sm text-secondary"
                  style={{ marginTop: "var(--space-4)", maxWidth: "42ch", margin: "var(--space-4) auto 0" }}
                >
                  This takes a little while: it is working out the sequence and the real
                  dependencies, not just listing tasks.
                </p>
              </div>
            </div>
          ) : !plan ? (
            <div className="card">
              <EmptyState
                icon="layers"
                title="No plan yet"
                body="Paste a brief on the left. You will see the whole proposal here before anything is created."
              />
            </div>
          ) : (
            <>
              {applied ? (
                <Notice tone="info" title="Plan applied">
                  {applied}
                </Notice>
              ) : (
                <Notice
                  tone="info"
                  title="Nothing has been created yet"
                  action={
                    <div className="row gap-2">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => void reject.run()}
                        disabled={reject.pending || approve.pending}
                      >
                        Discard
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void approve.run()}
                        disabled={approve.pending || reject.pending}
                      >
                        {approve.pending && <span className="spinner" />}
                        Approve &amp; create
                      </button>
                    </div>
                  }
                >
                  Review the plan below. Approving creates{" "}
                  {pluralise(plan.tasks.length, "task")} and{" "}
                  {pluralise(plan.milestones.length, "milestone")}.
                </Notice>
              )}

              {approve.error && <Notice tone="danger">{errorMessage(approve.error)}</Notice>}

              <PlanView plan={plan} />

              {actionId && !applied && (
                <p className="text-xs text-tertiary">
                  This proposal is also in{" "}
                  <Link to="/ai/actions">AI approvals</Link>, so a colleague can review it.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function PlanView({ plan }: { plan: GeneratedPlan }) {
  const byRef = new Map(plan.tasks.map((task, index) => [task.ref, index + 1]));

  return (
    <div className="stack gap-5">
      <div className={styles.planSummary}>
        <h2 className="text-md semibold" style={{ marginBottom: "var(--space-3)" }}>
          {plan.projectName}
        </h2>
        <p className="text-sm" style={{ lineHeight: "var(--leading-relaxed)" }}>
          {plan.summary}
        </p>

        <div className="row gap-4" style={{ marginTop: "var(--space-4)", flexWrap: "wrap" }}>
          <span className="badge">{pluralise(plan.tasks.length, "task")}</span>
          <span className="badge">{pluralise(plan.milestones.length, "milestone")}</span>
          <span className="badge">
            {pluralise(
              plan.tasks.reduce((sum, task) => sum + task.dependsOn.length, 0),
              "dependency",
              "dependencies",
            )}
          </span>
          {plan.tasks.some((task) => task.estimateHours !== null) && (
            <span className="badge">
              {plan.tasks.reduce((sum, task) => sum + (task.estimateHours ?? 0), 0)}h estimated
            </span>
          )}
        </div>
      </div>

      {plan.openQuestions.length > 0 && (
        <section>
          <SectionHeader title="Questions the brief did not answer" />
          <div className="card">
            {plan.openQuestions.map((question, index) => (
              <div key={index} className={styles.riskRow}>
                <Icon
                  name="alert"
                  size={14}
                  style={{ color: "var(--warning)", flexShrink: 0, marginTop: 2 }}
                />
                <span>{question}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {plan.milestones.length > 0 && (
        <section>
          <SectionHeader title="Milestones" />
          <div className="card">
            {plan.milestones.map((milestone) => (
              <div key={milestone.name} className={styles.riskRow}>
                <Icon
                  name="flag"
                  size={14}
                  style={{ color: "var(--text-tertiary)", flexShrink: 0, marginTop: 2 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="medium">{milestone.name}</div>
                  {milestone.description && (
                    <div className="text-xs text-secondary">{milestone.description}</div>
                  )}
                  <div className="text-xs text-tertiary" style={{ marginTop: 2 }}>
                    {milestone.taskRefs.length} tasks
                    {milestone.dueDate ? ` · due ${milestone.dueDate}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHeader title={`Tasks (${plan.tasks.length})`} />
        <div className={styles.planTaskTable}>
          {plan.tasks.map((task, index) => (
            <div key={task.ref} className={styles.planTaskRow}>
              <span className={styles.planTaskIndex}>{index + 1}</span>
              <div className={styles.planTaskBody}>
                <div className={styles.planTaskTitle}>{task.title}</div>
                {task.description && (
                  <div className={styles.planTaskDescription}>{task.description}</div>
                )}
                <div className={styles.planTaskMeta}>
                  {task.priority !== "none" && <span className="badge">{task.priority}</span>}
                  {task.estimateHours !== null && <span>{task.estimateHours}h</span>}
                  {task.dueDate && <span>due {task.dueDate}</span>}
                  {task.milestone && <span>· {task.milestone}</span>}
                  {task.suggestedRole && <span>· {task.suggestedRole}</span>}
                  {task.dependsOn.length > 0 && (
                    <span className="row gap-1">
                      <Icon name="link" size={11} />
                      waits for{" "}
                      {task.dependsOn.map((ref) => (
                        <span key={ref} className={styles.dependsOn}>
                          #{byRef.get(ref) ?? ref}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {plan.risks.length > 0 && (
        <section>
          <SectionHeader title="Risks it identified" />
          <div className="card">
            {plan.risks.map((risk, index) => (
              <div key={index} className={styles.riskRow}>
                <RiskBadge level={risk.severity} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{risk.description}</div>
                  {risk.mitigation && (
                    <div className="text-xs text-secondary" style={{ marginTop: 2 }}>
                      Mitigation: {risk.mitigation}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
