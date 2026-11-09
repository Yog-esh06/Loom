# LOOM architecture notes

## Trust boundaries

The browser is an untrusted client. FastAPI authenticates each request, loads the current user, and resolves resource ownership through workspace membership before accessing projects, documents, tasks, comments, approvals, or agent runs. The WebSocket repeats token and membership validation before accepting a document channel.

Document text, task descriptions, and agent requests are untrusted content. The deterministic provider only formats local data and does not have external tools. A future model adapter must preserve this boundary, pass minimum context, validate structured outputs, and route mutations through backend services and approvals.

## Data and delivery semantics

SQLite is the default local database. Documents store append-only Yjs binary updates. Connected clients receive updates over an in-process room manager; disconnected clients rely on persisted updates fetched over REST and their own IndexedDB state. Replaying a Yjs update is idempotent by CRDT design, but transport delivery is not exactly-once. Presence is ephemeral and scoped to one API process.

Agent jobs are launched with in-process asyncio tasks. They are neither durable nor guaranteed to survive API restart. The run record tracks status, and a failure marks the execution failed, but multi-process scheduling and leases are not implemented.

## Tenant isolation

Workspace-owned resources resolve through a project or document to its workspace. Authorization is enforced in API service helpers rather than trusted from submitted workspace identifiers. The initial data model uses foreign keys and workspace membership uniqueness but does not yet enforce tenant constraints using database row-level security.

## Production gaps

Before production, add migrations, PostgreSQL, role-specific policy checks, rate limits, secure cookie or one-time WebSocket credentials, a distributed collaboration transport, Yjs snapshot compaction, durable job processing, audit retention policies, backups, and security testing of deployment configuration.
