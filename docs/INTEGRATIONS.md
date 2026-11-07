# Integrations

GitHub and Google Calendar. Both are fully implemented — OAuth, token storage,
API calls, webhook verification — and both need credentials you create
yourself. Until you do, the integrations page lists the exact variables to set
rather than showing a connect button that cannot work.

---

## GitHub

### What it actually does

- Lists the repositories your token can see, so you can link one to a project.
- Receives `pull_request` and `push` webhooks, verified by HMAC signature.
- When a pull request or commit message mentions a task reference
  (`APOLLO-14`), it comments on that task with a link to the PR or commits.
- Opening a PR (or marking it ready for review) moves the referenced task to
  **in review**.

### What it deliberately does not do

- **Merging a PR does not close the task.** It stays in review. Deciding work
  is finished is a human judgement, and automating it produces boards that
  claim to be further along than the team is.
- It does not create issues, push task state to GitHub, or modify PRs.
- Webhooks from a repository that is not linked to a project are stored and
  ignored. A webhook cannot reach a workspace that did not opt in.

### Setup

**1. Create an OAuth app**

<https://github.com/settings/developers> → *New OAuth App*

| Field | Value |
| --- | --- |
| Application name | AI Work OS |
| Homepage URL | `https://app.example.com` |
| Authorization callback URL | `https://app.example.com/api/integrations/github/callback` |

The callback must be `${API_BASE_URL}/api/integrations/github/callback`
exactly. For local development that is
`http://localhost:4000/api/integrations/github/callback`.

**2. Configure the API**

```bash
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx
GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_WEBHOOK_SECRET=<32+ random chars>
```

Generate the webhook secret:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Restart the API. **Settings → Integrations** now offers a Connect button.

**3. Connect and link**

Connect → authorize on GitHub → you return to the integrations page. Then
*Link a repo*, choose a repository and a project.

**4. Add the webhook**

Per repository: *Settings → Webhooks → Add webhook*

| Field | Value |
| --- | --- |
| Payload URL | `https://app.example.com/api/integrations/github/webhook` |
| Content type | `application/json` |
| Secret | the same `GITHUB_WEBHOOK_SECRET` |
| Events | *Let me select* → **Pull requests**, **Pushes** |

The integrations page shows the exact URL and whether the secret is configured.

Verify with GitHub's *Recent Deliveries*: the `ping` event should return
`200 {"ok":true,"pong":true}`.

### Scopes

`repo`, `read:org`, `read:user`. `repo` is needed to list private repositories.
If you only link public repos, you can narrow it to `public_repo` in
`providerConfig()` in `modules/integrations/integrations.service.ts`.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `503 not_configured` from the webhook | `GITHUB_WEBHOOK_SECRET` is unset. Unverifiable deliveries are rejected rather than trusted. |
| `403 Webhook signature verification failed` | The repository's secret does not match the API's. |
| `202 {"duplicate": true}` | A redelivery of an event already stored. Idempotent by design. |
| Delivery succeeds, nothing happens | Either the repository is not linked to a project, or no commit or PR title mentioned a task reference. References are matched case-insensitively as `KEY-123`. |
| `Connection failed: bad_verification_code` | The callback URL in the OAuth app does not match `API_BASE_URL`. |

---

## Google Calendar

### What it does

- Lists your calendars.
- Lists events in a window (yesterday to +N days, default 14).
- Imports an event as a meeting record: title, time, duration, description and
  attendees — matched to workspace members by email, with unmatched addresses
  kept as external participants rather than dropped.
- Marks already-imported events so you cannot create duplicates by accident.

**Read-only.** The requested scopes are `calendar.readonly` and
`calendar.events.readonly`. Nothing is ever written to your calendar.

### Setup

**1. Create a Google Cloud project** — <https://console.cloud.google.com>

**2. Enable the Calendar API** — *APIs & Services → Library* → Google Calendar
API → Enable.

**3. Configure the consent screen** — *APIs & Services → OAuth consent screen*.
Internal is simplest for a company workspace. Add the two scopes above. While
the app is in *Testing*, add each user as a test user.

**4. Create credentials** — *Credentials → Create credentials → OAuth client ID
→ Web application*

| Field | Value |
| --- | --- |
| Authorized redirect URI | `https://app.example.com/api/integrations/google/callback` |

Must equal `${API_BASE_URL}/api/integrations/google/callback` exactly — Google
is strict, including about the trailing path.

**5. Configure the API**

```bash
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
```

Restart, then connect from **Settings → Integrations**.

### Token refresh

The authorization request sends `access_type=offline` and `prompt=consent`,
which is what makes Google return a refresh token. Access tokens are refreshed
automatically when within 60 seconds of expiry.

Google only returns a refresh token on the **first** consent for a client. If
the stored one is missing or rejected, the connection is marked `error` with
"Reconnect Google Calendar" rather than failing silently — disconnect and
reconnect to get a fresh one.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `redirect_uri_mismatch` | The URI in Google Cloud does not match `API_BASE_URL` byte for byte. |
| `access_denied` | The account is not a test user while the consent screen is in Testing. |
| "Reconnect Google Calendar" | No refresh token stored, or Google rejected it. Disconnect and reconnect. |
| `403 insufficientPermissions` | The Calendar API is not enabled, or the scopes were changed after consent. Reconnect. |
| Events missing | The window is yesterday → +14 days by default, and cancelled events are filtered out. |

---

## Email

Not an OAuth integration, but the same honesty applies.

```bash
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false        # true for port 465
SMTP_USER=...
SMTP_PASSWORD=...
EMAIL_FROM="AI Work OS <no-reply@example.com>"
```

`EMAIL_PROVIDER=console` (the local default) logs the message instead of
sending it, and the result is labelled as not sent. `disabled` skips it
entirely.

Invitation emails are best effort: **the invite link is always returned to the
inviter** and shown with a copy button, so an invitation is never stuck waiting
on SMTP.

---

## Security notes

**Tokens at rest.** Access and refresh tokens are encrypted with AES-256-GCM
before insertion; the key is derived from `SESSION_SECRET` via HKDF. They are
decrypted only in memory for an outbound call, and the logger redacts
`accessToken` / `refreshToken` fields.

Rotating `SESSION_SECRET` makes stored tokens undecryptable. The integration is
then marked as needing reconnection rather than erroring opaquely.

**OAuth state.** Each authorization creates a single-use `oauth_states` row
carrying the workspace, the user and the post-connect redirect, expiring after
10 minutes. It is deleted as it is read, so a replayed callback fails. The
redirect target is validated as a same-origin relative path, so the callback
cannot be used as an open redirect.

**Who can connect.** Connecting and disconnecting require the admin or owner
role. Linking a repository to a project requires member. Every connect, link and
disconnect is written to the audit log.

**Webhook authentication.** The HMAC is computed over the raw request body,
retained only on the webhook path, and compared with `timingSafeEqual`.
