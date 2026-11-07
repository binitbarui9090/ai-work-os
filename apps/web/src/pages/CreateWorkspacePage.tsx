import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorMessage } from "../lib/hooks.js";
import { useSession } from "../lib/session.js";
import { Icon, Notice } from "../components/ui/index.js";
import styles from "./auth.module.css";

export function CreateWorkspacePage() {
  const { createWorkspace, workspaces, logout } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await createWorkspace(name.trim());
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setPending(false);
    }
  };

  const isFirst = workspaces.length === 0;

  return (
    <div className={styles.centered}>
      <div className={styles.centeredBox}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <Icon name="sparkle" size={18} />
          </span>
          <span className={styles.brandName}>AI Work OS</span>
        </div>

        <h1 className={styles.title}>{isFirst ? "Create your workspace" : "New workspace"}</h1>
        <p className={styles.subtitle}>
          {isFirst
            ? "A workspace holds your projects, documents and meetings. You can invite your team right after."
            : "Workspaces are completely separate: members, projects and data do not cross between them."}
        </p>

        <form className={styles.form} onSubmit={submit} noValidate>
          {error && <Notice tone="danger">{errorMessage(error)}</Notice>}

          <div className="field">
            <label className="label" htmlFor="workspace-name">
              Workspace name
            </label>
            <input
              id="workspace-name"
              className="input"
              placeholder="Acme Engineering"
              autoFocus
              required
              minLength={2}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <span className="field-hint">Usually your company, team or department.</span>
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-lg btn-block"
            disabled={pending || name.trim().length < 2}
          >
            {pending && <span className="spinner" />}
            Create workspace
          </button>
        </form>

        {isFirst ? (
          <p className={styles.footer}>
            Invited to someone else's workspace? Open the invitation link they sent you, or{" "}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: 0, height: "auto", color: "var(--text-accent)" }}
              onClick={() => void logout()}
            >
              sign out
            </button>
            .
          </p>
        ) : (
          <p className={styles.footer}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: 0, height: "auto" }}
              onClick={() => navigate(-1)}
            >
              Cancel
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
