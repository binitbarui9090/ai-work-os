import { Link } from "react-router-dom";
import { EmptyState } from "../components/ui/index.js";

export function NotFoundPage() {
  return (
    <div className="card" style={{ marginTop: "var(--space-8)" }}>
      <EmptyState
        icon="search"
        title="That page does not exist"
        body="The link may be stale, or the thing it pointed at has been deleted."
        action={
          <>
            <Link to="/" className="btn btn-primary">
              Go home
            </Link>
            <Link to="/projects" className="btn btn-secondary">
              Browse projects
            </Link>
          </>
        }
      />
    </div>
  );
}
