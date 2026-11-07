import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiRequestError } from "../lib/api.js";
import { errorMessage } from "../lib/hooks.js";
import { useSession } from "../lib/session.js";
import { Icon } from "../components/ui/index.js";
import { Showcase } from "./LoginPage.js";
import styles from "./auth.module.css";

export function RegisterPage() {
  const { register } = useSession();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<ApiRequestError | Error | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await register({
        name,
        email,
        password,
        workspaceName: workspaceName.trim() || undefined,
      });
      navigate("/", { replace: true });
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

          <h1 className={styles.title}>Create your account</h1>
          <p className={styles.subtitle}>
            Set up a workspace for your team. You can invite people once you are in.
          </p>

          <form className={styles.form} onSubmit={submit} noValidate>
            {error && (
              <div className={styles.formError} role="alert">
                <Icon name="alert" size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{errorMessage(error)}</span>
              </div>
            )}

            <div className="field">
              <label className="label" htmlFor="register-name">
                Your name
              </label>
              <input
                id="register-name"
                className="input"
                autoComplete="name"
                autoFocus
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={Boolean(fieldError("name"))}
              />
              {fieldError("name") && <span className="field-error">{fieldError("name")}</span>}
            </div>

            <div className="field">
              <label className="label" htmlFor="register-email">
                Work email
              </label>
              <input
                id="register-email"
                className="input"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={Boolean(fieldError("email"))}
              />
              {fieldError("email") && <span className="field-error">{fieldError("email")}</span>}
            </div>

            <div className="field">
              <label className="label" htmlFor="register-password">
                Password
              </label>
              <input
                id="register-password"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={Boolean(fieldError("password"))}
              />
              {fieldError("password") ? (
                <span className="field-error">{fieldError("password")}</span>
              ) : (
                <span className="field-hint">
                  At least 10 characters, with a letter and a number.
                </span>
              )}
            </div>

            <div className="field">
              <label className="label" htmlFor="register-workspace">
                Workspace name
              </label>
              <input
                id="register-workspace"
                className="input"
                placeholder="Acme Engineering"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                aria-invalid={Boolean(fieldError("workspaceName"))}
              />
              <span className="field-hint">
                Optional — you can create one after signing up.
              </span>
            </div>

            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={pending}>
              {pending && <span className="spinner" />}
              Create account
            </button>
          </form>

          <p className={styles.footer}>
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </div>

      <Showcase />
    </div>
  );
}
