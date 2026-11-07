import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ApiRequestError } from "../lib/api.js";
import { errorMessage } from "../lib/hooks.js";
import { useSession } from "../lib/session.js";
import { Icon } from "../components/ui/index.js";
import styles from "./auth.module.css";

export function LoginPage() {
  const { login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = (location.state as { from?: string } | null)?.from ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiRequestError | Error | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await login(email, password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setPending(false);
    }
  };

  const fieldError = (field: string) =>
    error instanceof ApiRequestError ? error.fieldError(field) : undefined;

  return (
    <div className={styles.page}>
      <div className={styles.formSide}>
        <div className={styles.formBox}>
          <div className={styles.brand}>
            <span className={styles.brandMark}>
              <Icon name="sparkle" size={18} />
            </span>
            <span className={styles.brandName}>AI Work OS</span>
          </div>

          <h1 className={styles.title}>Sign in</h1>
          <p className={styles.subtitle}>Pick up where your team left off.</p>

          <form className={styles.form} onSubmit={submit} noValidate>
            {error && (
              <div className={styles.formError} role="alert">
                <Icon name="alert" size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{errorMessage(error)}</span>
              </div>
            )}

            <div className="field">
              <label className="label" htmlFor="login-email">
                Email
              </label>
              <input
                id="login-email"
                className="input"
                type="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={Boolean(fieldError("email"))}
              />
              {fieldError("email") && <span className="field-error">{fieldError("email")}</span>}
            </div>

            <div className="field">
              <label className="label" htmlFor="login-password">
                Password
              </label>
              <input
                id="login-password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={pending}>
              {pending && <span className="spinner" />}
              Sign in
            </button>
          </form>

          <p className={styles.footer}>
            New here? <Link to="/register">Create an account</Link>
          </p>

          {/* Shown because the seed script creates these accounts; it says so
              plainly rather than pretending to be a product feature. */}
          <div className={styles.demoHint}>
            Running the local seed data? Sign in as <code>maya@northwind.test</code> with the
            password <code>demo-password-1</code>.
            <button
              type="button"
              className="btn btn-secondary btn-sm btn-block demoButton"
              style={{ marginTop: "var(--space-2)" }}
              onClick={() => {
                setEmail("maya@northwind.test");
                setPassword("demo-password-1");
              }}
            >
              Fill in the demo account
            </button>
          </div>
        </div>
      </div>

      <Showcase />
    </div>
  );
}

export function Showcase() {
  return (
    <div className={styles.showcase}>
      <div>
        <h2 className={styles.showcaseHeading}>
          One workspace that actually understands your projects.
        </h2>
        <p className={styles.showcaseBody}>
          Projects, tasks, documents and meetings in one place — with an agent that reads them
          before it answers, and asks before it changes anything.
        </p>
      </div>

      <div className={styles.featureList}>
        <Feature
          icon="layers"
          title="Briefs become plans"
          body="Paste a messy brief. Get milestones, tasks, estimates and a real dependency graph — as a proposal you approve."
        />
        <Feature
          icon="blocked"
          title="Blockers found, not guessed"
          body="Dependency chains, stalled work and missed dates are computed from your data, so every finding is checkable."
        />
        <Feature
          icon="shield"
          title="Nothing changes without you"
          body="Every AI action waits for a human decision, and every decision is recorded in the audit log."
        />
        <Feature
          icon="search"
          title="Ask, do not dig"
          body="Semantic and keyword search across tasks, docs and meeting transcripts — with citations back to the source."
        />
      </div>
    </div>
  );
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: "layers" | "blocked" | "shield" | "search";
  title: string;
  body: string;
}) {
  return (
    <div className={styles.feature}>
      <span className={styles.featureIcon}>
        <Icon name={icon} size={15} />
      </span>
      <div>
        <div className={styles.featureTitle}>{title}</div>
        <div className={styles.featureBody}>{body}</div>
      </div>
    </div>
  );
}
