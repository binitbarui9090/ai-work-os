/**
 * Project intelligence.
 *
 * Three sections, each labelled with how it was produced:
 *  - Blockers: deterministic, computed from tasks and dependencies.
 *  - Health reports: metrics from SQL; the narrative is model-written and
 *    marked `generatedBy`, so a rules-only report is never passed off as AI.
 *  - Duplicates: embedding similarity when available, trigram otherwise, and
 *    the method is stated.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import type { HealthReport } from "@workos/shared";
import { api } from "../lib/api.js";
import { errorMessage, formatDate, pluralise, relativeTime, useAsync, useMutation } from "../lib/hooks.js";
import { useWorkspace } from "../lib/session.js";
import { PageHeader, SectionHeader } from "../components/PageHeader.js";
import {
  Avatar,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRows,
  Notice,
  RiskBadge,
  Tabs,
  useToast,
} from "../components/ui/index.js";
import styles from "./pages.module.css";

export function InsightsPage() {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<"blockers" | "health" | "duplicates">("blockers");
  const [projectFilter, setProjectFilter] = useState("");

  const projects = useAsync(() => api.projects.list(), [workspace.id]);
  const capabilities = useAsync(() => api.ai.capabilities(), [workspace.id]);

  return (
    <div className="fade-in">
      <PageHeader
        title="Insights"
        subtitle="What is stuck, where the risk is, and where work is being duplicated. Findings are computed from your data — the AI only adds commentary on top."
      />

      <div className={styles.toolbar}>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "blockers", label: "Blockers" },
            { id: "health", label: "Health reports" },
            { id: "duplicates", label: "Duplicate work" },
          ]}
        />
        <span className="spacer" />
        <select
          className={`select ${styles.toolbarSelect}`}
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
          aria-label="Filter by project"
        >
          <option value="">All projects</option>
          {(projects.data?.projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      {tab === "blockers" && <BlockersSection projectId={projectFilter} />}
      {tab === "health" && (
        <HealthSection
          projectId={projectFilter}
          aiAvailable={capabilities.data?.capabilities.chatEnabled ?? false}
          aiReason={capabilities.data?.capabilities.disabledReason ?? null}
        />
      )}
      {tab === "duplicates" && <DuplicatesSection projectId={projectFilter} />}
    </div>
  );
}

function BlockersSection({ projectId }: { projectId: string }) {
  const workspace = useWorkspace();
  const [explain, setExplain] = useState(false);

  const blockers = useAsync(
    () =>
      api.ai.blockers({
        projectId: projectId || undefined,
        limit: 50,
        explain,
      }),
    [workspace.id, projectId, explain],
  );

  const data = blockers.data;
  const items = data?.blockers ?? [];

  const bySeverity = {
    critical: items.filter((b) => b.severity === "critical").length,
    high: items.filter((b) => b.severity === "high").length,
    medium: items.filter((b) => b.severity === "medium").length,
    low: items.filter((b) => b.severity === "low").length,
  };

  return (
    <div className="stack gap-5">
      <div className={styles.statGrid} style={{ marginBottom: 0 }}>
        <div className={`${styles.stat} ${bySeverity.critical > 0 ? styles.statAlert : ""}`}>
          <div className={styles.statLabel}>Critical</div>
          <div className={styles.statValue}>{bySeverity.critical}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>High</div>
          <div className={styles.statValue}>{bySeverity.high}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Medium</div>
          <div className={styles.statValue}>{bySeverity.medium}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Low</div>
          <div className={styles.statValue}>{bySeverity.low}</div>
        </div>
      </div>

      <SectionHeader
        title={`Detected blockers (${items.length})`}
        action={
          data?.explanationsAvailable ? (
            <label className="row gap-2 text-xs text-secondary" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                className="checkbox"
                checked={explain}
                onChange={(event) => setExplain(event.target.checked)}
              />
              Add AI commentary
            </label>
          ) : (
            <span className="text-xs text-tertiary" title={data?.explanationsUnavailableReason ?? ""}>
              AI commentary unavailable
            </span>
          )
        }
      />

      {blockers.loading ? (
        <LoadingRows rows={5} />
      ) : blockers.error ? (
        <ErrorState error={blockers.error} onRetry={blockers.reload} />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="check"
            title="Nothing is stuck"
            body="No overdue tasks, no unfinished dependencies, nothing stalled for more than a week."
          />
        </div>
      ) : (
        <div className="card">
          {items.map((blocker) => (
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
                  <span className="spacer" />
                  <RiskBadge level={blocker.severity} />
                </div>

                <div className="text-xs text-tertiary" style={{ marginTop: 2 }}>
                  {blocker.projectName} · {blocker.status.replace(/_/g, " ")} ·{" "}
                  {blocker.assignee?.name ?? "unassigned"}
                  {blocker.blockingCount > 0 &&
                    ` · blocking ${pluralise(blocker.blockingCount, "task")}`}
                </div>

                <div className={styles.blockerReasons}>
                  {blocker.reasons.map((reason, index) => (
                    <span key={index} className={styles.blockerReason}>
                      <Icon name="dot" size={6} style={{ marginTop: 5, flexShrink: 0 }} />
                      {reason}
                    </span>
                  ))}
                </div>

                {blocker.aiExplanation && (
                  <div className={styles.blockerExplanation}>
                    <strong>AI: </strong>
                    {blocker.aiExplanation}
                  </div>
                )}
              </div>
              {blocker.assignee && <Avatar user={blocker.assignee} size={24} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HealthSection({
  projectId,
  aiAvailable,
  aiReason,
}: {
  projectId: string;
  aiAvailable: boolean;
  aiReason: string | null;
}) {
  const workspace = useWorkspace();
  const toast = useToast();
  const [periodDays, setPeriodDays] = useState(7);

  const reports = useAsync(
    () => api.ai.healthReports({ projectId: projectId || undefined, limit: 10 }),
    [workspace.id, projectId],
  );

  const generate = useMutation(async () => {
    const result = await api.ai.generateHealthReport({
      projectId: projectId || null,
      periodDays,
    });
    toast.success(
      `Report generated — risk ${result.report.riskLevel}`,
      result.report.generatedBy === "ai"
        ? "Metrics from your data, narrative written by the model."
        : "Metrics and findings computed from your data (no AI provider configured).",
    );
    reports.reload();
    return result;
  });

  return (
    <div className="stack gap-5">
      {!aiAvailable && aiReason && (
        <Notice tone="neutral" title="Reports will be rule-based">
          {aiReason} The metrics and findings are computed from your data either way — only the
          written narrative needs a model.
        </Notice>
      )}

      <div className="row gap-3">
        <select
          className="select"
          style={{ width: 170 }}
          value={periodDays}
          onChange={(event) => setPeriodDays(Number(event.target.value))}
          aria-label="Reporting period"
        >
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
        </select>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void generate.run()}
          disabled={generate.pending}
        >
          {generate.pending ? <span className="spinner" /> : <Icon name="activity" size={14} />}
          Generate report
        </button>
        {generate.pending && (
          <span className="text-xs text-tertiary">Computing metrics and writing it up…</span>
        )}
      </div>

      {generate.error && <Notice tone="danger">{errorMessage(generate.error)}</Notice>}

      {reports.loading ? (
        <LoadingRows rows={3} />
      ) : reports.error ? (
        <ErrorState error={reports.error} onRetry={reports.reload} />
      ) : (reports.data?.reports.length ?? 0) === 0 ? (
        <div className="card">
          <EmptyState
            icon="activity"
            title="No reports yet"
            body="Generate one to get the week's metrics, the risks, and a set of concrete recommendations. One is also produced automatically every Monday."
          />
        </div>
      ) : (
        <div className="stack gap-5">
          {reports.data!.reports.map((report) => (
            <HealthReportCard key={report.id} report={report} />
          ))}
        </div>
      )}
    </div>
  );
}

function HealthReportCard({ report }: { report: HealthReport }) {
  const metrics = report.metrics;

  return (
    <article className="panel">
      <div className="panel-header">
        <div className="row gap-3">
          <RiskBadge level={report.riskLevel} />
          <span className="panel-title">
            {report.projectName ?? "Whole workspace"} ·{" "}
            {formatDate(report.periodStart)} to {formatDate(report.periodEnd)}
          </span>
        </div>
        <span
          className={report.generatedBy === "ai" ? "badge badge-accent" : "badge"}
          title={
            report.generatedBy === "ai"
              ? "Metrics computed from your data; narrative written by the model"
              : "Computed entirely from your data by rules — no model involved"
          }
        >
          {report.generatedBy === "ai" ? "AI narrative" : "Rule-based"}
        </span>
      </div>

      <div className="panel-body stack gap-5">
        <div className={styles.statGrid} style={{ marginBottom: 0 }}>
          <Metric label="Completed" value={metrics.tasksCompleted} />
          <Metric label="Created" value={metrics.tasksCreated} />
          <Metric
            label="Net progress"
            value={metrics.netProgress > 0 ? `+${metrics.netProgress}` : metrics.netProgress}
            alert={metrics.netProgress < 0}
          />
          <Metric label="Overdue" value={metrics.tasksOverdue} alert={metrics.tasksOverdue > 0} />
          <Metric label="Blocked" value={metrics.tasksBlocked} alert={metrics.tasksBlocked > 0} />
          <Metric label="Stalled" value={metrics.staleTaskCount} alert={metrics.staleTaskCount > 0} />
          <Metric label="Unowned" value={metrics.unassignedTaskCount} />
          <Metric label="Active people" value={metrics.activeContributors} />
          <Metric
            label="Avg cycle time"
            value={
              metrics.avgCycleTimeHours === null
                ? "—"
                : metrics.avgCycleTimeHours < 24
                  ? `${metrics.avgCycleTimeHours}h`
                  : `${(metrics.avgCycleTimeHours / 24).toFixed(1)}d`
            }
          />
        </div>

        {report.narrative && (
          <div>
            <SectionHeader title="Narrative" />
            <div className="prose" style={{ whiteSpace: "pre-wrap", fontSize: "var(--text-sm)" }}>
              {report.narrative}
            </div>
          </div>
        )}

        <div className={styles.twoColumn} style={{ gap: "var(--space-5)" }}>
          <div className="stack gap-4">
            {report.concerns.length > 0 && (
              <div>
                <SectionHeader title="Concerns" />
                <ul className="stack gap-2">
                  {report.concerns.map((concern, index) => (
                    <li key={index} className="row gap-2 text-sm" style={{ alignItems: "flex-start" }}>
                      <Icon
                        name="alert"
                        size={13}
                        style={{ color: "var(--warning)", flexShrink: 0, marginTop: 3 }}
                      />
                      {concern}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.recommendations.length > 0 && (
              <div>
                <SectionHeader title="Recommended this week" />
                <ul className="stack gap-2">
                  {report.recommendations.map((recommendation, index) => (
                    <li key={index} className="row gap-2 text-sm" style={{ alignItems: "flex-start" }}>
                      <Icon
                        name="arrow-right"
                        size={13}
                        style={{ color: "var(--text-accent)", flexShrink: 0, marginTop: 3 }}
                      />
                      {recommendation}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {report.highlights.length > 0 && (
            <div>
              <SectionHeader title="Highlights" />
              <ul className="stack gap-2">
                {report.highlights.map((highlight, index) => (
                  <li key={index} className="row gap-2 text-sm" style={{ alignItems: "flex-start" }}>
                    <Icon
                      name="check"
                      size={13}
                      style={{ color: "var(--success)", flexShrink: 0, marginTop: 3 }}
                    />
                    {highlight}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="text-xs text-tertiary">Generated {relativeTime(report.createdAt)}</div>
      </div>
    </article>
  );
}

function Metric({
  label,
  value,
  alert,
}: {
  label: string;
  value: string | number;
  alert?: boolean;
}) {
  return (
    <div className={`${styles.stat} ${alert ? styles.statAlert : ""}`}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue} style={{ fontSize: "1.375rem" }}>
        {value}
      </div>
    </div>
  );
}

function DuplicatesSection({ projectId }: { projectId: string }) {
  const workspace = useWorkspace();
  const duplicates = useAsync(
    () => api.ai.duplicates({ projectId: projectId || undefined, limit: 30 }),
    [workspace.id, projectId],
  );

  if (duplicates.loading) return <LoadingRows rows={4} />;
  if (duplicates.error) return <ErrorState error={duplicates.error} onRetry={duplicates.reload} />;

  const data = duplicates.data!;

  return (
    <div className="stack gap-5">
      {data.notice && <Notice tone="neutral">{data.notice}</Notice>}

      <SectionHeader
        title={`Possible duplicates (${data.candidates.length})`}
        action={
          <span className="badge" title="How similarity was measured">
            {data.method === "embedding" ? "Semantic comparison" : "Title comparison"}
          </span>
        }
      />

      {data.candidates.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="layers"
            title="No duplicates found"
            body="No two open tasks look similar enough to be worth a second look."
          />
        </div>
      ) : (
        <div className="card">
          {data.candidates.map((candidate, index) => (
            <div key={index} className={styles.blockerCard}>
              <div className={styles.blockerBody}>
                <div className="row gap-2 text-xs text-tertiary">
                  <span className="badge">{Math.round(candidate.similarity * 100)}% similar</span>
                  <span>{candidate.reason}</span>
                </div>
                <div className="stack gap-2" style={{ marginTop: "var(--space-2)" }}>
                  {[candidate.taskA, candidate.taskB].map((task) => (
                    <Link key={task.id} to={`/tasks/${task.id}`} className={styles.dependencyRow}>
                      <span className={styles.dependencyRef}>{task.reference}</span>
                      <span className="truncate" style={{ flex: 1 }}>
                        {task.title}
                      </span>
                      <span className="badge">{task.status.replace(/_/g, " ")}</span>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
