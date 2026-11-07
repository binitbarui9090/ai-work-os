/**
 * The home dashboard.
 *
 * One endpoint assembles everything the landing page shows, so the first paint
 * is a single round-trip instead of six. Every number here is a live query —
 * nothing on this screen is a placeholder.
 */
import type { DashboardSummary, Task } from "@workos/shared";
import type { WorkspaceContext } from "../../middleware/context.js";
import { detectBlockers } from "../../ai/analysis/blockers.js";
import { listActivity } from "../activity/activity.service.js";
import { countPendingActions } from "../ai/actions.service.js";
import { countUnread } from "../notifications/notification.service.js";
import { listProjects } from "../projects/projects.service.js";
import { listTasks } from "../tasks/tasks.service.js";
import { loadSummary } from "../workspaces/workspaces.service.js";

export async function getDashboard(
  workspace: WorkspaceContext,
  userId: string,
): Promise<DashboardSummary> {
  const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const [summary, myTasks, dueSoon, projects, activity, blockers, unread, pendingAi] =
    await Promise.all([
      loadSummary(workspace.id, userId),
      listTasks(workspace, userId, { assigneeId: "me", limit: 50, offset: 0 }),
      listTasks(workspace, userId, { dueBefore: soon, limit: 50, offset: 0 }),
      listProjects(workspace, userId),
      listActivity(workspace.id, { limit: 20 }),
      detectBlockers(workspace, userId, { limit: 8 }),
      countUnread(workspace.id, userId),
      countPendingActions(workspace.id),
    ]);

  // `dueSoon` comes back containing overdue items too; split them so the UI can
  // treat "needs attention now" differently from "coming up".
  const overdue: Task[] = [];
  const upcoming: Task[] = [];
  for (const task of dueSoon) {
    if (task.dueDate && task.dueDate < today) overdue.push(task);
    else upcoming.push(task);
  }

  return {
    workspace: summary,
    myTasks: myTasks
      .slice()
      .sort(byUrgency)
      .slice(0, 12),
    dueSoon: upcoming.slice(0, 12),
    overdue: overdue.slice(0, 12),
    projects,
    recentActivity: activity.items,
    blockers,
    unreadNotifications: unread,
    pendingAiActions: pendingAi,
  };
}

const PRIORITY_WEIGHT: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

function byUrgency(a: Task, b: Task): number {
  // Blocked work sinks: it is not actionable right now.
  if (a.isBlocked !== b.isBlocked) return a.isBlocked ? 1 : -1;
  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.dueDate && !b.dueDate) return -1;
  if (!a.dueDate && b.dueDate) return 1;
  return PRIORITY_WEIGHT[a.priority]! - PRIORITY_WEIGHT[b.priority]!;
}
