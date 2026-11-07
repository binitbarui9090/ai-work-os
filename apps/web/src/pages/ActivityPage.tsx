/**
 * Workspace activity feed.
 *
 * Human and AI actions are shown in one stream, with the AI ones labelled, so
 * "who changed this" is always answerable. New events arrive live.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ActivityEvent } from "@workos/shared";
import { api } from "../lib/api.js";
import { relativeTime, useAsync, useMutation } from "../lib/hooks.js";
import { useRealtimeEvent } from "../lib/realtime.js";
import { useWorkspace } from "../lib/session.js";
import { PageHeader } from "../components/PageHeader.js";
import {
  Avatar,
  EmptyState,
  ErrorState,
  SegmentedControl,
  TaskListSkeleton,
} from "../components/ui/index.js";
import styles from "./pages.module.css";

type Actor = "all" | "people" | "ai";

export function ActivityPage() {
  const workspace = useWorkspace();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [actorFilter, setActorFilter] = useState<Actor>("all");
  const [projectFilter, setProjectFilter] = useState("");

  const loaded = useAsync(
    () => api.activity({ limit: 50, projectId: projectFilter || undefined }),
    [workspace.id, projectFilter],
  );
  const projects = useAsync(() => api.projects.list(), [workspace.id]);

  useEffect(() => {
    if (loaded.data) {
      setEvents(loaded.data.items);
      setCursor(loaded.data.nextCursor);
    }
  }, [loaded.data]);

  useRealtimeEvent("activity", (event) => {
    if (projectFilter && event.event.projectId !== projectFilter) return;
    setEvents((prev) =>
      prev.some((candidate) => candidate.id === event.event.id) ? prev : [event.event, ...prev],
    );
  });

  const loadMore = useMutation(async () => {
    if (!cursor) return;
    const page = await api.activity({
      limit: 50,
      cursor,
      projectId: projectFilter || undefined,
    });
    setEvents((prev) => [...prev, ...page.items]);
    setCursor(page.nextCursor);
    return page;
  });

  const visible = events.filter((event) => {
    if (actorFilter === "ai") return event.actorType === "ai";
    if (actorFilter === "people") return event.actorType === "user";
    return true;
  });

  return (
    <div className="fade-in">
      <PageHeader
        title="Activity"
        subtitle="Everything that has happened in this workspace, by people and by the AI."
      />

      <div className={styles.toolbar}>
        <SegmentedControl
          ariaLabel="Filter by actor"
          value={actorFilter}
          onChange={setActorFilter}
          options={[
            { id: "all", label: "Everything" },
            { id: "people", label: "People", icon: "users" },
            { id: "ai", label: "AI", icon: "sparkle" },
          ]}
        />
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

      {loaded.loading ? (
        <TaskListSkeleton rows={10} />
      ) : loaded.error ? (
        <ErrorState error={loaded.error} onRetry={loaded.reload} />
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="activity"
            title={actorFilter === "ai" ? "The AI has not changed anything" : "No activity yet"}
            body={
              actorFilter === "ai"
                ? "AI actions appear here once you approve one. Nothing it proposes takes effect without a decision."
                : "Create a project or a task and the history starts filling in."
            }
          />
        </div>
      ) : (
        <>
          <div className="card card-padded">
            <div className={styles.feed}>
              {visible.map((event) => (
                <div key={event.id} className={styles.feedItem}>
                  <Avatar user={event.actor} size={24} />
                  <span className={styles.feedText}>
                    <span className={styles.feedActor}>
                      {event.actor?.name ??
                        (event.actorType === "ai" ? "AI agent" : "System")}
                    </span>{" "}
                    {event.actorType === "ai" && <span className={styles.aiActorChip}>AI</span>}{" "}
                    {event.summary}
                    {event.entityType === "task" && (
                      <>
                        {" "}
                        <Link to={`/tasks/${event.entityId}`} className="text-xs">
                          view
                        </Link>
                      </>
                    )}
                    {event.entityType === "document" && (
                      <>
                        {" "}
                        <Link to={`/docs/${event.entityId}`} className="text-xs">
                          view
                        </Link>
                      </>
                    )}
                    {event.entityType === "meeting" && (
                      <>
                        {" "}
                        <Link to={`/meetings/${event.entityId}`} className="text-xs">
                          view
                        </Link>
                      </>
                    )}
                  </span>
                  <span className={styles.feedTime} title={new Date(event.createdAt).toLocaleString()}>
                    {relativeTime(event.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {cursor && (
            <div style={{ marginTop: "var(--space-4)", textAlign: "center" }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void loadMore.run()}
                disabled={loadMore.pending}
              >
                {loadMore.pending && <span className="spinner" />}
                Load more
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
