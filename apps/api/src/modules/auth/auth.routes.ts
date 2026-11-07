import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from "@workos/shared";
import { Router } from "express";
import { asyncHandler, noStore, parseBody } from "../../lib/http.js";
import { optionalAuth, requireAuth } from "../../middleware/auth.js";
import type { AuthedRequest } from "../../middleware/context.js";
import { authRateLimit } from "../../middleware/rate-limit.js";
import {
  changePassword,
  getCurrentUser,
  login,
  register,
  updateProfile,
} from "./auth.service.js";
import {
  clearSessionCookie,
  createSession,
  destroyOtherSessions,
  destroySession,
  setSessionCookie,
} from "./session.service.js";
import { listWorkspacesForUser } from "../workspaces/workspaces.service.js";
import { acceptInvitation, previewInvitation } from "../workspaces/invitations.service.js";

export const authRoutes = Router();

authRoutes.post(
  "/register",
  authRateLimit(),
  asyncHandler(async (req, res) => {
    const input = parseBody(registerSchema, req.body);
    const { user, workspaceId } = await register(input);

    const session = await createSession(user.id, {
      ip: req.ctx.ip,
      userAgent: req.ctx.userAgent,
    });
    setSessionCookie(res, session.token);
    noStore(res);

    res.status(201).json({
      user,
      workspaceId,
      workspaces: await listWorkspacesForUser(user.id),
    });
  }),
);

authRoutes.post(
  "/login",
  authRateLimit(),
  asyncHandler(async (req, res) => {
    const input = parseBody(loginSchema, req.body);
    const user = await login(input.email, input.password);

    const session = await createSession(user.id, {
      ip: req.ctx.ip,
      userAgent: req.ctx.userAgent,
    });
    setSessionCookie(res, session.token);
    noStore(res);

    res.json({ user, workspaces: await listWorkspacesForUser(user.id) });
  }),
);

authRoutes.post(
  "/logout",
  // `optionalAuth` resolves the session so it can actually be destroyed, while
  // still returning 204 for a caller who is already signed out.
  optionalAuth(),
  asyncHandler(async (req, res) => {
    if (req.ctx.sessionId) await destroySession(req.ctx.sessionId);
    clearSessionCookie(res);
    res.status(204).end();
  }),
);

authRoutes.get(
  "/me",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { ctx } = req as AuthedRequest;
    noStore(res);
    res.json({
      user: await getCurrentUser(ctx.user.id),
      workspaces: await listWorkspacesForUser(ctx.user.id),
    });
  }),
);

authRoutes.patch(
  "/me",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { ctx } = req as AuthedRequest;
    const input = parseBody(updateProfileSchema, req.body);
    res.json({ user: await updateProfile(ctx.user.id, input) });
  }),
);

authRoutes.post(
  "/change-password",
  requireAuth(),
  authRateLimit(),
  asyncHandler(async (req, res) => {
    const { ctx } = req as AuthedRequest;
    const input = parseBody(changePasswordSchema, req.body);
    await changePassword(ctx.user.id, input.currentPassword, input.newPassword);
    // Other devices are signed out; this one stays signed in.
    const revoked = await destroyOtherSessions(ctx.user.id, ctx.sessionId);
    res.json({ ok: true, otherSessionsEndedCount: revoked });
  }),
);

/** Public: lets the sign-up page show what the invitation is for. */
authRoutes.get(
  "/invitations/:token",
  asyncHandler(async (req, res) => {
    const token = String(req.params.token ?? "");
    noStore(res);
    res.json({ invitation: await previewInvitation(token) });
  }),
);

/** Accepts an invitation for the signed-in user. */
authRoutes.post(
  "/invitations/:token/accept",
  requireAuth(),
  asyncHandler(async (req, res) => {
    const { ctx } = req as AuthedRequest;
    const token = String(req.params.token ?? "");
    const result = await acceptInvitation(token, ctx.user.id, ctx.user.email);
    res.json({
      ...result,
      workspaces: await listWorkspacesForUser(ctx.user.id),
    });
  }),
);
