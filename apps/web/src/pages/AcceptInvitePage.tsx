/**
 * Invitation landing page.
 *
 * The invitation is bound to an email address, so this screen has to handle
 * three cases honestly: not signed in, signed in as the right person, and
 * signed in as someone else.
 */
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { errorMessage, formatDate, useAsync, useMutation } from "../lib/hooks.js";
import { useSession } from "../lib/session.js";
import { CenteredSpinner, ErrorState, Icon, Notice } from "../components/ui/index.js";
import styles from "./auth.module.css";

export function AcceptInvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const { status, user, switchWorkspace, refresh } = useSession();

  const invitation = useAsync(() => api.auth.previewInvitation(token), [token]);
  const [accepted, setAccepted] = useState(false);

  const accept = useMutation(async () => {
    const result = await api.auth.acceptInvitation(token);
    await refresh();
    switchWorkspace(result.workspaceId);
    setAccepted(true);
    navigate("/", { replace: true });
    return result;
  });

  if (invitation.loading || status === "loading") {
    return (
      <div className={styles.centered}>
        <CenteredSpinner label="Checking your invitation" />
      </div>
    );
  }

  if (invitation.error || !invitation.data) {
    return (
      <div className={styles.centered}>
        <div className={styles.centeredBox}>
          <ErrorState error={invitation.error ?? new Error("Invitation not found")} />
          <Link to="/login" className="btn btn-secondary btn-block">
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  const invite = invitation.data.invitation;
  const emailMatches = user?.email.toLowerCase() === invite.email.toLowerCase();

  return (
    <div className={styles.centered}>
      <div className={styles.centeredBox}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <Icon name="sparkle" size={18} />
          </span>
          <span className={styles.brandName}>AI Work OS</span>
        </div>

        <h1 className={styles.title}>You have been invited</h1>
        <p className={styles.subtitle}>
          {invite.invitedByName} invited you to join as a {invite.role}.
        </p>

        <div className={styles.inviteWorkspace}>
          <span className={styles.inviteMark}>{invite.workspaceName.slice(0, 2).toUpperCase()}</span>
          <div style={{ minWidth: 0 }}>
            <div className="semibold truncate">{invite.workspaceName}</div>
            <div className="text-xs text-tertiary">
              Invitation for {invite.email} · expires {formatDate(invite.expiresAt)}
            </div>
          </div>
        </div>

        {accept.error && (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <Notice tone="danger">{errorMessage(accept.error)}</Notice>
          </div>
        )}

        {status === "anonymous" ? (
          <div className="stack gap-3">
            <Notice tone="info">
              This invitation is for <strong>{invite.email}</strong>. Sign in with that address, or
              create an account with it, to accept.
            </Notice>
            <Link
              to="/register"
              state={{ inviteToken: token, email: invite.email }}
              className="btn btn-primary btn-lg btn-block"
            >
              Create an account
            </Link>
            <Link
              to="/login"
              state={{ from: `/invite/${token}` }}
              className="btn btn-secondary btn-block"
            >
              I already have an account
            </Link>
          </div>
        ) : emailMatches ? (
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            onClick={() => void accept.run()}
            disabled={accept.pending || accepted}
          >
            {accept.pending && <span className="spinner" />}
            Join {invite.workspaceName}
          </button>
        ) : (
          <div className="stack gap-3">
            <Notice tone="warning" title="Signed in as someone else">
              You are signed in as <strong>{user?.email}</strong>, but this invitation was sent to{" "}
              <strong>{invite.email}</strong>. Sign out and sign in with that address to accept it.
            </Notice>
            <Link to="/" className="btn btn-secondary btn-block">
              Go to your workspace instead
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
