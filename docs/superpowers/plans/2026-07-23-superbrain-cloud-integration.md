# SuperBrain Cloud Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the colleague's cloud prototype into a team-owned, tested, bidirectional WorkBuddy–mentor product, deploy it on Tencent Cloud with managed Supabase, and push the new product line to the public team repository.

**Architecture:** Keep TanStack Start, React, Supabase Auth/PostgreSQL/RLS/Realtime, and the existing MCP surface. Run the application as a Node/Nitro service on Tencent Cloud. Add deterministic username login, team-managed mentor provisioning, idempotent WorkBuddy events, persistent mentor-message delivery state, MCP and token fetch/ack paths, and cross-platform fallback connectors.

**Tech Stack:** TypeScript, React 19, TanStack Start, Nitro 3, Supabase, Zod, Vitest, Playwright, Bash, PowerShell, Nginx, systemd, GitHub Actions.

---

## File map

### Authentication and administration

- `src/lib/auth/identifiers.ts`: normalize usernames and derive versioned, hashed internal Auth identities.
- `src/lib/auth/admin.server.ts`: trusted mentor create/disable/reset operations.
- `src/lib/auth/admin.functions.ts`: authenticated TanStack server-function wrappers.
- `src/routes/auth.tsx`: student-only signup and username-or-email sign-in.
- `src/routes/_authenticated/admin.mentors.tsx`: team administrator UI.
- `scripts/bootstrap-mentors.ts`: one-time masked, idempotent initial account provisioning.

### WorkBuddy protocol and delivery

- `src/lib/workbuddy/contracts.ts`: Zod contracts and response types shared by routes and tests.
- `src/lib/workbuddy/events.server.ts`: idempotent ingest RPC and stable session resolution.
- `src/lib/workbuddy/credentials.server.ts`: one-time token creation, hash authentication, rotation, and revocation.
- `src/lib/workbuddy/credentials.functions.ts`: authenticated student token-management wrappers.
- `src/lib/workbuddy/delivery.server.ts`: pending/fetched/acknowledged state transitions.
- `src/routes/api/public/workbuddy/ingest.ts`: thin public ingest handler.
- `src/routes/api/public/workbuddy/mentor-messages.ts`: token-authenticated unread-message endpoint.
- `src/routes/api/public/workbuddy/mentor-messages.ack.ts`: token-authenticated acknowledgement endpoint.
- `src/lib/mcp/tools/get-unread-mentor-messages.ts`: authenticated MCP pull tool.
- `src/lib/mcp/tools/ack-mentor-messages.ts`: authenticated MCP acknowledgement tool.
- `connectors/workbuddy-sync.mjs`: shared retry, atomic outbox, render ledger, sync, fetch, and ack core.
- `connectors/install-macos.sh`: macOS/Linux installation and file permissions.
- `connectors/install-windows.ps1`: Windows installation and current-user ACL.
- `connectors/templates/SKILL.md`: token-free WorkBuddy instructions.

### Database, UI, quality, and deployment

- `supabase/migrations/20260723090000_add_team_admin_role.sql`: isolated enum migration.
- `supabase/migrations/20260723090100_cloud_integration.sql`: staff, credentials, ingest ledger, session source keys, delivery, policies, RPCs, and triggers.
- `src/integrations/supabase/types.ts`: generated-compatible application types for the new schema.
- `src/routes/_authenticated/index.tsx`: delivery status, web-seen state, and general-domain wording.
- `src/routes/_authenticated/workbuddy.tsx`: MCP-first setup plus Windows/macOS fallbacks.
- `src/lib/domain-packs.ts`: general learning-camp and industrial-automation prompt packs.
- `vitest.config.ts`, `playwright.config.ts`, `tests/`: automated verification.
- `.github/workflows/ci.yml`: Linux/Windows/macOS checks.
- `deploy/`, `scripts/deploy.sh`, `.env.example`: Tencent Node deployment and rollback.
- `docs/superpowers/specs/2026-07-23-superbrain-cloud-integration-design.md`: approved design.
- `docs/superpowers/plans/2026-07-23-superbrain-cloud-integration.md`: this plan.

## Task 1: Establish the product branch and quality baseline

**Files:**

- Modify: `package.json`
- Modify: `vite.config.ts`
- Modify: all files reported only by `prettier/prettier`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `tests/setup.ts`

- [ ] **Step 1: Verify branch ancestry and a clean baseline**

Run:

```bash
git branch --show-current
git rev-parse HEAD
bun run build
bun run lint
bunx tsc --noEmit
```

Expected: branch is `codex/superbrain-cloud-integration`; HEAD is `f86c689...`; build passes; lint reports 341 formatting errors, one conditional-assignment error, and six Fast Refresh warnings; typecheck reports the two known `/auth` navigation-search errors.

- [ ] **Step 2: Add test tooling and scripts**

Run:

```bash
bun add -d vitest @vitest/coverage-v8 @playwright/test
```

Add these scripts to `package.json`:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage",
  "test:e2e": "playwright test",
  "typecheck": "tsc --noEmit",
  "format:check": "prettier --check .",
  "start": "node .output/server/index.mjs",
  "check": "bun run format:check && bun run lint -- --max-warnings=0 && bun run typecheck && bun run test && bun run build"
}
```

- [ ] **Step 3: Create deterministic Vitest configuration**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
```

Create `tests/setup.ts`:

```ts
process.env.NODE_ENV = "test";
```

- [ ] **Step 4: Pin self-hosted Node output**

Add to the Lovable `defineConfig` call in `vite.config.ts`:

```ts
nitro: { preset: "node-server" },
```

Expected build output: `.output/server/index.mjs`, startable with Node.

- [ ] **Step 5: Format and verify the baseline**

Run the formatter, fix the conditional assignment in `src/routes/_authenticated/index.tsx`, fix both `/auth` navigations by passing their validated search shape, and resolve the six component-export warnings so CI can enforce zero warnings.

Run:

```bash
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
```

Expected: lint exits 0 with no warnings; typecheck and tests exit 0; Node/Nitro build passes; `.output/nitro.json` records `node-server`.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock vite.config.ts vitest.config.ts playwright.config.ts tests/setup.ts src
git commit -m "chore: establish cloud integration quality baseline"
```

## Task 2: Add deterministic mentor usernames and student-only signup

**Files:**

- Create: `src/lib/auth/identifiers.ts`
- Create: `src/lib/auth/signin.server.ts`
- Create: `src/lib/auth/signin.functions.ts`
- Create: `tests/unit/auth-identifiers.test.ts`
- Modify: `src/routes/auth.tsx`
- Modify: `src/routes/_authenticated/index.tsx`

- [ ] **Step 1: Write the failing identifier tests**

Create `tests/unit/auth-identifiers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  loginIdentifierToEmail,
  mentorUsernameToEmail,
  normalizeMentorUsername,
} from "@/lib/auth/identifiers";

describe("mentor identifiers", () => {
  it("normalizes a camp username deterministically", () => {
    expect(normalizeMentorUsername("  MRF ")).toBe("mrf");
  });

  it("maps mentor usernames to a stable opaque identity", () => {
    expect(mentorUsernameToEmail("xiuqiang")).toMatch(
      /^u1_[a-zA-Z0-9_-]+@auth\.copilot\.sg\.superbrain-ai\.com$/,
    );
  });

  it("keeps student email logins unchanged", () => {
    expect(loginIdentifierToEmail("student@example.com")).toBe("student@example.com");
  });

  it("rejects unsafe usernames", () => {
    expect(() => normalizeMentorUsername("../root")).toThrow("用户名");
  });
});
```

- [ ] **Step 2: Run the negative control**

Run:

```bash
bun run test tests/unit/auth-identifiers.test.ts
```

Expected: FAIL because `src/lib/auth/identifiers.ts` does not exist.

- [ ] **Step 3: Implement the pure mapping**

Create `src/lib/auth/identifiers.ts` with:

```ts
import { createHash } from "node:crypto";

const MENTOR_LOGIN_DOMAIN = "auth.copilot.sg.superbrain-ai.com";
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function normalizeMentorUsername(value: string): string {
  const username = value.normalize("NFKC").trim().toLowerCase();
  if (!USERNAME.test(username)) throw new Error("用户名需为 2–32 位字母、数字、点、横线或下划线");
  return username;
}

export function mentorUsernameToEmail(value: string): string {
  const digest = createHash("sha256").update(normalizeMentorUsername(value)).digest("base64url");
  return `u1_${digest}@${MENTOR_LOGIN_DOMAIN}`;
}

export function loginIdentifierToEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") ? normalized : mentorUsernameToEmail(normalized);
}
```

- [ ] **Step 4: Make signup student-only and signin username-aware**

In `src/routes/auth.tsx`:

- replace the signin `email` state with `identifier`;
- send the identifier and password to `signin.functions.ts`; the trusted server maps usernames and performs Supabase password login;
- return only the session plus the public account profile, then call `supabase.auth.setSession` in the browser;
- keep an email input for signup;
- remove role state and the student/mentor selector;
- send `{ display_name, role: "student" }` on signup;
- label signin input “用户名或学员邮箱”;
- never render a public mentor-registration control.

- [ ] **Step 5: Display mentor usernames**

Load the active `staff_accounts.username` and use it in the authenticated top bar. Never derive the display name from the internal Auth identity or include that identity in product API responses.

- [ ] **Step 6: Run tests and commit**

```bash
bun run test tests/unit/auth-identifiers.test.ts
bun run lint
git add src/lib/auth src/routes/auth.tsx src/routes/_authenticated/index.tsx tests/unit/auth-identifiers.test.ts
git commit -m "feat: add username mentor login"
```

## Task 3: Extend the Supabase schema for team administration and reliable delivery

**Files:**

- Create: `supabase/migrations/20260723090000_add_team_admin_role.sql`
- Create: `supabase/migrations/20260723090100_cloud_integration.sql`
- Modify: `src/integrations/supabase/types.ts`
- Create: `tests/unit/schema-contract.test.ts`

- [ ] **Step 1: Write a schema contract test that fails**

Create `tests/unit/schema-contract.test.ts` to read the migration text and assert the exact invariants:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const roleSql = readFileSync(
  new URL("../../supabase/migrations/20260723090000_add_team_admin_role.sql", import.meta.url),
  "utf8",
);
const sql = readFileSync(
  new URL("../../supabase/migrations/20260723090100_cloud_integration.sql", import.meta.url),
  "utf8",
);

describe("cloud integration migration", () => {
  it("defines team admin, idempotent events, and persistent deliveries", () => {
    expect(roleSql).toContain("ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'team_admin'");
    expect(sql).toContain("CREATE TABLE public.staff_accounts");
    expect(sql).toContain("CREATE TABLE public.workbuddy_ingest_events");
    expect(sql).toContain("CREATE TABLE public.workbuddy_credentials");
    expect(sql).toContain("source_session_key text");
    expect(sql).toContain("CREATE TABLE public.mentor_message_deliveries");
    expect(sql).toContain("acknowledged_at timestamptz");
  });
});
```

- [ ] **Step 2: Run the negative control**

Expected: FAIL because the migration is absent.

- [ ] **Step 3: Add the isolated role migration**

The first migration contains only:

```sql
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'team_admin';
```

Keeping the enum change in its own migration prevents PostgreSQL from rejecting use of the new enum value in the same transaction.

- [ ] **Step 4: Add staff, credential, ingest, session, and delivery storage**

The second migration contains:

```sql
CREATE TABLE public.staff_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text NOT NULL,
  normalized_username text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  disabled_at timestamptz,
  disabled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS source_session_key text;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_student_source_key
  ON public.sessions(student_id, source, source_session_key)
  WHERE source_session_key IS NOT NULL;

CREATE TABLE public.workbuddy_ingest_events (
  event_id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  source text NOT NULL,
  payload_sha256 text NOT NULL,
  client_created_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.timeline_items
  ADD COLUMN IF NOT EXISTS source_event_id uuid REFERENCES public.workbuddy_ingest_events(event_id),
  ADD COLUMN IF NOT EXISTS event_ordinal smallint,
  ADD COLUMN IF NOT EXISTS author_username text;
CREATE UNIQUE INDEX IF NOT EXISTS timeline_event_ordinal_unique
  ON public.timeline_items(source_event_id, event_ordinal)
  WHERE source_event_id IS NOT NULL;

CREATE TABLE public.workbuddy_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.mentor_message_deliveries (
  message_id uuid PRIMARY KEY REFERENCES public.timeline_items(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  first_fetched_at timestamptz,
  last_fetched_at timestamptz,
  fetch_count integer NOT NULL DEFAULT 0,
  acknowledged_at timestamptz,
  web_seen_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

It must also:

- enable RLS and Realtime for the new public tables;
- allow a student to select/update only deliveries for their own profile;
- allow mentors and team admins to read deliveries;
- expose service-role-only RPCs that atomically ingest a WorkBuddy turn and create a mentor timeline item plus pending delivery;
- replace `handle_new_user()` so public signup always gets `student`, ignoring client role metadata;
- provision staff and roles together through a service-role-only function;
- require active staff status for mentor/team_admin RLS access so disable invalidates existing sessions immediately;
- force `author_username` from `staff_accounts` instead of accepting a client-supplied value;
- remove the original demo seed block from the new-project migration sequence or add a deterministic pre-launch cleanup migration.

- [ ] **Step 5: Update TypeScript types**

Add staff accounts, credentials, ingest events, source-session fields, `team_admin`, and complete mentor-delivery types to `src/integrations/supabase/types.ts`.

- [ ] **Step 6: Verify and commit**

```bash
bun run test tests/unit/schema-contract.test.ts
bun run format:check
git add supabase/migrations src/integrations/supabase/types.ts tests/unit/schema-contract.test.ts
git commit -m "feat: add reliable delivery schema"
```

## Task 4: Implement trusted mentor account administration

**Files:**

- Create: `src/lib/auth/admin.server.ts`
- Create: `src/lib/auth/admin.functions.ts`
- Create: `src/routes/_authenticated/admin.mentors.tsx`
- Create: `scripts/bootstrap-mentors.ts`
- Create: `tests/unit/mentor-admin.test.ts`

- [ ] **Step 1: Define an injectable Auth gateway and failing tests**

Test these exact behaviors:

- `team_admin` is required;
- username becomes the deterministic internal email;
- create adds `mentor`, and optionally `team_admin`;
- disable and enable call the gateway with a ban duration;
- reset updates the password but never returns it;
- duplicate username returns a stable conflict error.

The production interface in `admin.server.ts` must be:

```ts
export interface MentorAuthGateway {
  createUser(input: {
    email: string;
    password: string;
    userMetadata: Record<string, unknown>;
    appMetadata: { account_kind: "staff" };
  }): Promise<{ id: string }>;
  updateUser(id: string, input: { password?: string; banDuration?: string }): Promise<void>;
  listUsers(): Promise<
    Array<{ id: string; email: string; lastSignInAt: string | null; bannedUntil: string | null }>
  >;
}
```

- [ ] **Step 2: See the tests fail, then implement**

Use `supabaseAdmin.auth.admin.createUser`, `updateUserById`, and `listUsers` only in `.server.ts`. Create staff Auth users with trusted `app_metadata.account_kind = "staff"` so the public-signup trigger does not create a student profile. Provision `staff_accounts` plus roles in one database function; if provisioning fails, delete the new Auth user as compensation.

- [ ] **Step 3: Add server-function wrappers**

`admin.functions.ts` must use `requireSupabaseAuth`, verify the caller has `team_admin` through `supabaseAdmin`, validate inputs with Zod, and return password-free DTOs.

- [ ] **Step 4: Add the management page**

The page lists username, enabled state, last login, and roles, with create, disable/enable, and reset controls. It must not display initial or reset passwords after submission.

- [ ] **Step 5: Add masked, idempotent bootstrap**

`scripts/bootstrap-mentors.ts` accepts the approved usernames through a non-secret JSON input or prompt and reads the initial password through masked stdin. The password is never accepted as a CLI argument, written to a file, or logged. The first approved administrator gets explicit `mentor` and `team_admin` roles; the others get only `mentor`. Running twice must not create duplicates or reset existing passwords.

- [ ] **Step 6: Verify and commit**

```bash
bun run test tests/unit/mentor-admin.test.ts
bun run lint
git add src/lib/auth src/routes/_authenticated/admin.mentors.tsx scripts/bootstrap-mentors.ts tests/unit/mentor-admin.test.ts
git commit -m "feat: add team-managed mentor accounts"
```

## Task 5: Make WorkBuddy ingest idempotent and session-stable

**Files:**

- Create: `src/lib/workbuddy/contracts.ts`
- Create: `src/lib/workbuddy/events.server.ts`
- Create: `src/lib/workbuddy/credentials.server.ts`
- Modify: `src/routes/api/public/workbuddy/ingest.ts`
- Modify: `src/lib/mcp/tools/log-turn.ts`
- Create: `tests/unit/workbuddy-events.test.ts`

- [ ] **Step 1: Write failing domain tests**

Cover:

- two requests with the same `event_id` produce one stored event;
- a turn event creates deterministic prompt/reply/diagnosis ordinals;
- `source_session_key` resolves the same cloud session;
- two source keys with the same title do not merge;
- a bearer-token session belongs to that token's student;
- the same event id with a different payload hash returns `409 EVENT_ID_CONFLICT`;
- a bearer student cannot submit `kind = mentor`.

- [ ] **Step 2: Add shared contracts**

Each reliable turn accepts:

```ts
{
  event_id: string;
  source: "mcp" | "skill" | "connector";
  source_session_key: string;
  prompt: string;
  reply: string;
  diagnosis?: {
    text: string;
    severity: "ok" | "warn" | "error";
  };
}
```

Responses return stable item ids, `duplicate`, and `session_id`. A separate legacy adapter may accept the old item-array shape, but all new MCP and connector calls require `event_id`.

- [ ] **Step 3: Extract the domain service**

`events.server.ts` receives an injectable gateway. Production calls `ingest_workbuddy_turn(...)` so ledger insertion, SHA-256 payload conflict detection, session resolution, and timeline insertion occur in one database transaction. Do not implement a race-prone “select then insert” workflow in TypeScript. Resolve sessions by `(student_id, source, source_session_key)` and do not merge reliable-path sessions by title or recency. Authenticate the bearer credential through `credentials.server.ts`, which hashes the presented token and resolves only an active credential's student.

- [ ] **Step 4: Keep the route thin**

The route handles CORS, size, auth, JSON parse, Zod validation, and delegates. Do not leave database workflow embedded in the handler.

- [ ] **Step 5: Upgrade MCP `log_turn`**

Make `event_id` and `source_session_key` required for the reliable MCP path and call the same ingest service/RPC used by the public route.

- [ ] **Step 6: Verify red/green and commit**

```bash
bun run test tests/unit/workbuddy-events.test.ts
git add src/lib/workbuddy src/routes/api/public/workbuddy/ingest.ts src/lib/mcp/tools/log-turn.ts tests/unit/workbuddy-events.test.ts
git commit -m "feat: make workbuddy ingest idempotent"
```

## Task 6: Add persistent mentor fetch and acknowledgement

**Files:**

- Create: `src/lib/workbuddy/delivery.server.ts`
- Modify: `src/lib/workbuddy/credentials.server.ts`
- Create: `src/lib/workbuddy/credentials.functions.ts`
- Create: `src/routes/api/public/workbuddy/mentor-messages.ts`
- Create: `src/routes/api/public/workbuddy/mentor-messages.ack.ts`
- Modify: `src/routes/_authenticated/workbuddy.tsx`
- Create: `tests/unit/mentor-delivery.test.ts`
- Create: `tests/integration/workbuddy-message-api.test.ts`

- [ ] **Step 1: Write the delivery-state tests**

Assert:

- a mentor item starts pending;
- fetch returns it and sets `first_fetched_at`, `last_fetched_at`, and `fetch_count`;
- repeated fetch returns the same unacknowledged message without duplication;
- ack sets `acknowledged_at`;
- repeated ack is successful and preserves the first timestamp;
- messages created while the student is offline survive service restart because state is in Supabase;
- a message from another student is not returned on the normal ownership path.

- [ ] **Step 2: Run the negative control**

Expected: FAIL because the service and routes do not exist.

- [ ] **Step 3: Implement the state service**

Expose:

```ts
export async function fetchPendingMentorMessages(
  repository: DeliveryRepository,
  input: { studentId: string; sessionId?: string; limit: number },
): Promise<{ messages: MentorMessage[]; cursor: string | null }>;

export async function acknowledgeMentorMessages(
  repository: DeliveryRepository,
  input: { studentId: string; messageIds: string[] },
): Promise<{ acknowledged: number }>;
```

Fetch only `acknowledged_at IS NULL`, order by creation time and id, and cap at 100.

Authenticate bearer tokens by hashing the presented value and looking up an active `workbuddy_credentials` row. Update `last_used_at`; never query or log the old plaintext `students.workbuddy_token`.

- [ ] **Step 4: Add token endpoints**

- `GET /api/public/workbuddy/mentor-messages?session_id=&limit=` authenticates the hashed per-student bearer token.
- `POST /api/public/workbuddy/mentor-messages/ack` validates `{ message_ids: uuid[] }`.
- Both return structured error codes and request ids.
- CORS allows GET, POST, and OPTIONS.

- [ ] **Step 5: Add one-time credential management**

Authenticated students can create the first token, rotate it, and revoke it through server functions. Plaintext appears exactly once after create/rotate; storage and later API responses expose only prefix, status, and timestamps. Rotation revokes the previous credential in the same transaction.

- [ ] **Step 6: Verify and commit**

```bash
bun run test tests/unit/mentor-delivery.test.ts tests/integration/workbuddy-message-api.test.ts
git add src/lib/workbuddy src/routes/api/public/workbuddy src/routes/_authenticated/workbuddy.tsx tests
git commit -m "feat: add reliable mentor message delivery"
```

## Task 7: Add MCP pull/ack tools and enforce the closed loop

**Files:**

- Create: `src/lib/mcp/tools/get-unread-mentor-messages.ts`
- Create: `src/lib/mcp/tools/ack-mentor-messages.ts`
- Modify: `src/lib/mcp/index.ts`
- Modify: `src/lib/mcp/tools/log-turn.ts`
- Create: `tests/unit/mcp-mentor-delivery.test.ts`

- [ ] **Step 1: Write failing tool-handler tests**

Use a real in-memory fake repository, not a mock of the handler. Assert exact returned message text and ids.

- [ ] **Step 2: Implement `get_unread_mentor_messages`**

Inputs: optional `session_id`, optional `limit`. Output: message id, session id, text, mentor author id, created time, and cursor.

- [ ] **Step 3: Implement `ack_mentor_messages`**

Input: `message_ids` array, 1–100. Only acknowledgements belonging to the current student are accepted.

- [ ] **Step 4: Update MCP instructions**

The instructions must say:

1. call `log_turn`;
2. call `get_unread_mentor_messages`;
3. show every returned mentor message in the current WorkBuddy response;
4. only after showing them, call `ack_mentor_messages`;
5. retry unacknowledged messages on the next turn.

- [ ] **Step 5: Negative control and commit**

Temporarily remove the pull tool from the registered tool list and prove the registry test fails; restore it, run tests, and commit:

```bash
git add src/lib/mcp tests/unit/mcp-mentor-delivery.test.ts
git commit -m "feat: close mentor loop through mcp"
```

## Task 8: Add Windows and macOS fallback connectors

**Files:**

- Create: `connectors/workbuddy-sync.mjs`
- Create: `connectors/install-macos.sh`
- Create: `connectors/install-windows.ps1`
- Create: `connectors/templates/SKILL.md`
- Create: `tests/connectors/mock-server.mjs`
- Create: `tests/connectors/test-posix.sh`
- Create: `tests/connectors/test-windows.ps1`
- Modify: `src/routes/_authenticated/workbuddy.tsx`
- Create: `docs/workbuddy-setup.md`

- [ ] **Step 1: Define one shared CLI contract**

The Node connector is the cross-platform protocol implementation. Both installers expose:

```text
configure --api-url URL
sync --event-file FILE
fetch [--session-id UUID]
ack --message-ids ID[,ID...]
flush
```

State paths:

- POSIX: `${XDG_STATE_HOME:-$HOME/.local/state}/superbrain-copilot/`
- Windows: `$env:LOCALAPPDATA\SuperBrainCopilot\`

- [ ] **Step 2: Write connector tests before scripts**

The mock server must fail the first sync and succeed the second. Tests assert:

- the failed event is present in the queue;
- `flush` sends it once;
- fetched mentor text is preserved exactly;
- ack sends the exact ids;
- an acknowledged message is written to the render ledger before ack is sent;
- concurrent flushes do not send the same event twice;
- malformed queue entries move to quarantine instead of blocking the queue;
- tokens never appear in stdout, process arguments, `SKILL.md`, or event files.

- [ ] **Step 3: Implement the shared connector**

Use Node 22 standard-library APIs only. Store the bearer token in a current-user-only config file, keep an atomic outbox outside the project tree, use claim/lock files to prevent duplicate flushes, and quarantine malformed events. Requests use bounded timeouts and three retries with short backoff. Fetch writes the exact rendered mentor message and id to a durable render ledger before acknowledgement is allowed.

- [ ] **Step 4: Implement thin platform installers**

`install-macos.sh` and `install-windows.ps1` install the same `workbuddy-sync.mjs`, create the platform state directory with current-user-only permissions/ACLs, prompt for the token without echoing it, and write token-free WorkBuddy instructions from `connectors/templates/SKILL.md`.

- [ ] **Step 5: Replace the Bash-only setup page**

Make MCP the recommended path. Add distinct Windows and macOS/Linux fallback tabs, downloadable scripts, visible last-sync/queue guidance, and a connection test action.

- [ ] **Step 6: Verify and commit**

Run the POSIX test locally. The Windows installer and connector run in CI in Task 10.

```bash
git add connectors tests/connectors src/routes/_authenticated/workbuddy.tsx docs/workbuddy-setup.md
git commit -m "feat: add cross-platform workbuddy fallback"
```

## Task 9: Expose delivery status in mentor and student web experiences

**Files:**

- Modify: `src/routes/_authenticated/index.tsx`
- Create: `src/lib/timeline-delivery.ts`
- Create: `src/lib/mentor-messages.server.ts`
- Create: `tests/unit/timeline-delivery.test.ts`
- Create: `tests/unit/mentor-message-create.test.ts`
- Create: `src/lib/domain-packs.ts`
- Modify: `src/lib/ai.server.ts`

- [ ] **Step 1: Write failing UI-state tests**

Map delivery rows to:

- `待 WorkBuddy 获取`;
- `WorkBuddy 已获取`;
- `WorkBuddy 已送达`;
- `网页已查看`;
- combined states without overwriting one channel with the other.

- [ ] **Step 2: Implement delivery projection**

Keep the projection pure in `timeline-delivery.ts`; the route only fetches/subscribes and renders.

- [ ] **Step 3: Mark student web views separately**

When a student renders mentor items, set `web_seen_at` for those delivery rows. Do not set `acknowledged_at`.

- [ ] **Step 4: Route mentor sends through the delivery service**

Replace direct browser inserts with an authenticated server function/RPC that atomically creates the mentor timeline item and its pending delivery row. The server derives `author_username` from active staff state and rejects disabled staff. Unit tests prove that failure to create the delivery row rolls back the timeline item.

- [ ] **Step 5: Show mentor delivery state**

Mentor timeline displays the delivery badge and pending count. Realtime subscription includes delivery changes. If Realtime disconnects, poll with an exponential interval bounded between 5 and 30 seconds, then stop polling when the subscription is healthy again.

- [ ] **Step 6: Extract domain packs**

`domain-packs.ts` exports `general-learning-camp` and `industrial-automation`. Default to general; select with `DOMAIN_PACK`, and keep manual mentoring functional when `DEEPSEEK_API_KEY` is absent.

- [ ] **Step 7: Verify and commit**

```bash
bun run test tests/unit/timeline-delivery.test.ts tests/unit/mentor-message-create.test.ts
bun run lint
git add src tests/unit/timeline-delivery.test.ts
git commit -m "feat: surface mentor delivery status"
```

## Task 10: Add browser E2E and multi-OS CI

**Files:**

- Create: `tests/e2e/auth-and-mentor.spec.ts`
- Create: `tests/e2e/workbuddy-loop.spec.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Add E2E tests**

Against an ephemeral local Supabase stack in CI and a separate test project for the live pre-deploy check, cover:

- student signup cannot choose mentor;
- mentor username login;
- team admin creates/disables a mentor;
- student event appears in mentor timeline;
- mentor reply appears in student web timeline;
- WorkBuddy fetch returns it until ack;
- after ack, it no longer appears as unread.
- a disabled mentor's pre-existing session can no longer read or send;
- the same event id with a changed payload returns `409`;
- one student's token cannot fetch or ack another student's message.

- [ ] **Step 2: Prove a negative control**

Point the fetch assertion to a nonexistent message id and verify Playwright fails; restore the correct id.

- [ ] **Step 3: Add CI**

The workflow contains:

```yaml
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run check
      - run: '! rg "lovable\\.dev|lovable\\.app|works\\.dev" bun.lock src public supabase/config.toml'
  connectors:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
```

Regenerate `bun.lock` from the public package registry so it contains no Lovable artifact-registry URLs. Run the shared connector plus installer test on Ubuntu/macOS/Windows. Start local Supabase for integration and browser tests. Run live E2E only when the required repository secrets exist, and never silently mark a missing-secret live job as a production pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e .github/workflows/ci.yml playwright.config.ts
git commit -m "test: add cloud loop and multi-os verification"
```

## Task 11: Add Tencent deployment and rollback assets

**Files:**

- Create: `.env.example`
- Create: `src/routes/api/health.ts`
- Create: `src/routes/api/ready.ts`
- Create: `tests/unit/health-probes.test.ts`
- Create: `deploy/systemd/superbrain-copilot.service`
- Create: `deploy/nginx/copilot.sg.superbrain-ai.com.conf`
- Create: `scripts/deploy.sh`
- Create: `scripts/healthcheck.sh`
- Create: `docs/deployment.md`
- Modify: `package.json`

- [ ] **Step 1: Define environment variables without values**

`.env.example` lists:

```text
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_SUPABASE_PROJECT_ID=
WORKBUDDY_INGEST_SECRET=
DEEPSEEK_API_KEY=
DOMAIN_PACK=general-learning-camp
PORT=3410
```

Ensure `.env`, `.env.*.local`, and deployment secret files are ignored.

- [ ] **Step 2: Add health and readiness endpoints**

`GET /api/health` is process-local and returns the release id. `GET /api/ready` performs a bounded Supabase read and reports dependency failure without exposing connection details. Unit tests break each dependency and prove the corresponding probe becomes non-2xx.

- [ ] **Step 3: Add systemd and Nginx templates**

The service runs the immutable release's `.output/server/index.mjs` as the restricted deployment user, binds `127.0.0.1:3410`, restarts on failure, and reads an external EnvironmentFile.

Nginx proxies `copilot.sg.superbrain-ai.com` to that loopback port and preserves WebSocket/streaming headers.

- [ ] **Step 4: Add an atomic deploy script**

The script:

1. verifies an explicit release directory;
2. installs with `bun install --frozen-lockfile`;
3. runs `bun run check`;
4. builds;
5. switches the `current` symlink atomically;
6. restarts only the new service;
7. waits for `/api/health` and `/api/ready`;
8. restores the previous symlink and service if health fails.

It never deletes old releases automatically.

- [ ] **Step 5: Add health verification**

`healthcheck.sh` checks `/api/health`, `/api/ready`, the MCP tool list, and an unauthenticated ingest rejection. Expected: both probes 200, MCP metadata 200, ingest 401.

- [ ] **Step 6: Commit**

```bash
git add .env.example .gitignore src/routes/api/health.ts src/routes/api/ready.ts tests/unit/health-probes.test.ts deploy scripts docs/deployment.md package.json
git commit -m "ops: add tencent deployment and rollback"
```

## Task 12: Provision team Supabase and initial accounts

**Files:**

- Modify only deployment state; do not commit secrets.
- Append verification evidence to `docs/deployment.md` without credentials.

- [ ] **Step 1: Create or select a team-owned Supabase project**

Use a team-controlled account. Record project ref and region, but never passwords or service-role keys.

- [ ] **Step 2: Apply migrations**

Use the Supabase CLI or SQL editor. Verify tables, RLS, Realtime, unique event index, delivery trigger, and no demo students.

- [ ] **Step 3: Configure server and GitHub secrets**

Store keys only in Supabase/Tencent/GitHub secret stores. Do not write them into the project worktree.

- [ ] **Step 4: Bootstrap initial mentors**

Pass the approved usernames as non-secret JSON over stdin or select the built-in approved list. Enter the initial password only through the script's masked interactive prompt. Do not place it in environment variables, process arguments, shell history, files, docs, or logs. Verify the four approved usernames can sign in, are required to change the temporary password, and only the initial administrator can manage accounts.

- [ ] **Step 5: Run live integration tests**

Run migrations/tests against an isolated test student and verify no credential is printed.

## Task 13: Deploy to Tencent Cloud and run the live closed loop

**Files:**

- Server-side release and Nginx configuration only.
- Update: `docs/deployment.md` with non-secret evidence.

- [ ] **Step 1: Read the latest server-vault instructions and preflight**

Check memory, disk, selected port, existing Nginx names, and service user. Do not modify unrelated services.

- [ ] **Step 2: Configure DNS and HTTPS**

Point `copilot.sg.superbrain-ai.com` to the Singapore server, install the Nginx site, and issue/attach TLS through the existing server convention.

- [ ] **Step 3: Deploy an immutable release**

Run the deployment script. Verify only the dedicated service and Nginx site changed.

- [ ] **Step 4: Run the live end-to-end loop**

1. create a test student;
2. send a deterministic WorkBuddy turn;
3. resend the same event and prove one timeline item;
4. sign in as mentor by username;
5. send a message while the student connector is offline;
6. fetch, display, and ack after reconnection;
7. verify the mentor UI reports WorkBuddy delivery;
8. restart the application and repeat pending-message retrieval.

- [ ] **Step 5: Run the full verification gate**

```bash
bun run check
bun run test:e2e
git diff --check
git status --short
```

Record exact pass/fail output and clearly separate CI evidence from unavailable real WorkBuddy hardware evidence.

## Task 14: Review, document, and push the public branch

**Files:**

- Add: approved design and this plan under `docs/superpowers/`
- Update: `README.md`
- Update: `docs/deployment.md`

- [ ] **Step 1: Copy the approved design and plan into the product branch**

Do not include passwords, personal tokens, private server paths, or old spool data.

- [ ] **Step 2: Run code review**

Review authentication boundaries, event-id propagation, delivery state transitions, script quoting, secret handling, migration safety, and rollback behavior. Fix findings and rerun the relevant red/green tests.

- [ ] **Step 3: Verify branch lineage and diff**

```bash
git merge-base codex/superbrain-cloud-integration origin/main
git log --oneline --decorate -n 20
git status --short
git diff origin/main...HEAD --stat
```

Expected: branch descends from colleague `origin/main`; worktree is clean.

- [ ] **Step 4: Push to the public team repository**

```bash
git push -u team codex/superbrain-cloud-integration
```

Do not force push and do not update public `main`.

- [ ] **Step 5: Report completion**

Provide the public branch URL, commit id, deployed URL, tests run, live closed-loop evidence, any unavailable real-device evidence, and rollback location.
