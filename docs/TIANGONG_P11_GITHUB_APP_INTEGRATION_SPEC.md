# Tiangong P11: GitHub App Integration Spec

## Overview

Minimal GitHub App integration for Tiangong — enables agent-attributed PR approval queue with optional live GitHub merge.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Tiangong UI                     │
│  /github → GitHubPanel.tsx                       │
│    ├── Readiness (env config status)             │
│    ├── Repos (add/list)                          │
│    ├── Permissions (grant/revoke per agent)      │
│    └── PR Approval Queue                         │
│         ├── registerPR (register existing PR)    │
│         ├── approvePR (approve + optional merge) │
│         ├── rejectPR  (reject)                   │
│         └── Audit log                            │
└──────────────────┬──────────────────────────────┘
                   │ tRPC: github.*
┌──────────────────▼──────────────────────────────┐
│         api/github-router.ts                     │
│  status | listRepos | addRepo                    │
│  listPermissions | grantPermission |             │
│  revokePermission                                │
│  registerPR | approvePR | rejectPR               │
│  listPRs | getPR | listAuditLog | listAgents     │
│                                                  │
│  Internal helpers:                               │
│  - generateInstallationToken() → JWT from        │
│    private key (jose), exchange for token        │
│  - mergeGitHubPR() → fetch GitHub REST API       │
│    PUT /repos/{owner}/{repo}/pulls/{n}/merge     │
└──────────────────┬──────────────────────────────┘
                   │ Drizzle
┌──────────────────▼──────────────────────────────┐
│              MySQL Tables                        │
│  github_integrations                             │
│  github_repos                                    │
│  github_repo_permissions                         │
│  github_pull_requests                            │
│  github_audit_log                                │
└─────────────────────────────────────────────────┘
                   │ optional (if env configured)
┌──────────────────▼──────────────────────────────┐
│            GitHub REST API                       │
│  POST /app/installations/{id}/access_tokens      │
│  PUT  /repos/{owner}/{repo}/pulls/{n}/merge      │
└─────────────────────────────────────────────────┘
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_APP_ID` | Recommended | GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY` | Recommended on Zeabur | GitHub App private key PEM content; supports escaped `\n` |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | Optional | Base64-encoded private key PEM |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Optional | Path to private key PEM file |
| `GITHUB_APP_INSTALLATION_ID` | Recommended | Installation ID |
| `GITHUB_WEBHOOK_SECRET` | Optional | Webhook secret (future phase) |

**Security:** Private key is never stored in DB. On Zeabur prefer secret env vars (`GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_BASE64`); file path is also supported for self-hosting.

## Flow

### 1. Repo Management
1. Admin adds a repo via UI or API (`addRepo`)
2. Sets owner/name (e.g., `luciferlihaoyu/tiangong`)

### 2. Permission Management
1. Admin grants permission to agents via `grantPermission`
2. Permissions: `read`, `push`, `admin`
3. Only logged-in Tiangong admins can approve/reject PRs
4. Only agents with `push` or `admin` can register PRs

### 3. PR Registration
1. Admin registers an existing PR on behalf of an authorized agent with: agentId, repoId, prNumber, title, (optional body/branch/sha)
2. System validates selected agent has push/admin permission on repo
3. PR is created with status `pending`
4. Audit log records the registration

### 4. PR Approval
1. Admin clicks "批准" in UI (or calls `approvePR` via API)
2. System validates caller is a Tiangong admin
3. PR status → `approved`
4. If GitHub App env is configured:
   - Generate JWT → exchange for installation token
   - Call GitHub API `PUT /repos/{owner}/{repo}/pulls/{n}/merge`
   - On success: status → `merged`
   - On failure: returns `mergeSkipped` with reason
5. Audit log records approve + merge actions

### 5. PR Rejection
1. Admin clicks "拒绝" in UI (or calls `rejectPR`)
2. System validates caller is a Tiangong admin
3. PR status → `rejected`
4. Audit log records rejection

## Permission Model

- **agent x repo** authorization: each permission row maps one agent to one repo with a level
- Levels: `read`, `push`, `admin`
- Initial seeding: done via UI (`初始化天宫权限`) or `github.bootstrapDefault`
  - Meizhizi is granted `admin` on `luciferlihaoyu/tiangong`
- No broad defaults — every agent starts with zero permissions

## API (`githubRouter`)

All endpoints available via tRPC `github.*`. Auth required for mutating operations (ctx.user check). See `api/github-router.ts` for implementation.

| Procedure | Description | Auth |
|---|---|---|
| `status` | Env readiness + initial state | Login |
| `listRepos` | All repos | Login |
| `addRepo` | Add a repo | Admin |
| `listPermissions` | Filter by repoId/agentId | Login |
| `grantPermission` | Grant agent access to repo | Admin |
| `revokePermission` | Deactivate a permission | Admin |
| `registerPR` | Register PR into approval queue | Admin + selected agent push/admin perm |
| `approvePR` | Approve + optional merge | Admin |
| `rejectPR` | Reject a PR | Admin |
| `listPRs` | List PRs (filterable) | Login |
| `getPR` | PR detail + audit log | Login |
| `listAuditLog` | Audit entries (filterable) | Login |
| `listAgents` | Agent list for permission UI | Login |

## Security Boundary

1. **No secrets in DB**: Private key path (not content) in env var. PEM file read at runtime.
2. **No bypass of approval**: All PRs start `pending`. Approve/reject requires admin permission.
3. **Agent attribution**: PR authorship is logged with agentId; approval/rejection is restricted to logged-in Tiangong admins.
4. **Audit trail**: Full audit log of register/approve/reject/merge/revoke events.
5. **Minimal scope**: Installation token scoped to specific repos via GitHub App installation.

## Database Schema

See `db/schema.ts` for full definitions.

### `github_integrations`
- Metadata about GitHub App installation: appId, installationId, owner

### `github_repos`
- owner, name, fullName, defaultBranch, installationId, active

### `github_repo_permissions`
- agentId → repoId → permissionLevel (read/push/admin), active

### `github_pull_requests`
- repoId, prNumber, title, body, branch/baseBranch, headSha, authorAgentId
- status: pending | approved | rejected | merged | closed
- approvedBy, approvedAt, mergedAt

### `github_audit_log`
- prId, action (approve/reject/merge/register/revoke), agentId, reason

## Future: Feishu Card Phase (P11.2)

When a PR is registered with `status: pending`:
1. Tiangong sends a Feishu interactive card to Meizhizi
2. Card shows: PR title, branch, author, repo
3. Card buttons: "批准" / "拒绝"
4. Card actions call `approvePR` / `rejectPR` via Tiangong API

Blocked on Feishu bot card API setup. Tracked in `TIANGONG_P11_2_FEISHU_CARD_SPEC.md` (future).

## Future: pushCode (P11.3)

Agent-initiated code push flow:
1. Agent generates code diff
2. Creates branch via GitHub API
3. Commits changes
4. Opens PR
5. Registers PR in Tiangong via `registerPR`
6. Enters approval queue

Not yet implemented.
