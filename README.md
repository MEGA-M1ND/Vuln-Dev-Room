# Dev Room — Stage 1

A polished, multiplayer **control room** for engineering teams. Several engineers
join the same room, share a Kanban-style task board, see who else is present,
track which ticket each teammate is viewing, and discuss tickets through
realtime comments.

> **Scope.** This is **Stage 1**: the multiplayer product shell. There are **no
> AI coding agents, code execution, repository cloning, or GitHub integration**
> — those are explicitly future stages. Repository fields are metadata only and
> are never fetched or cloned.

Authoritative state lives in **PostgreSQL**. **Liveblocks** provides ephemeral
collaborative awareness (presence, selected-ticket, typing, comment threads, and
lightweight board-invalidation broadcasts). Liveblocks is never used as durable
storage.

---

## Table of contents

- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Authorization](#authorization)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Running the app](#running-the-app)
- [Local authentication (dev switcher)](#local-authentication-dev-switcher)
- [Liveblocks setup](#liveblocks-setup)
- [API contract](#api-contract)
- [Testing](#testing)
- [Manual two-browser demo](#manual-two-browser-demo)
- [Project structure](#project-structure)
- [Stage 1 limitations](#stage-1-limitations)
- [Recommended first task for Stage 2](#recommended-first-task-for-stage-2)

---

## Tech stack

| Concern        | Choice                                             |
| -------------- | -------------------------------------------------- |
| Framework      | Next.js 15 (App Router), React 19, TypeScript strict |
| Styling        | Tailwind CSS + a small in-repo accessible UI kit   |
| Database       | PostgreSQL + Prisma ORM                            |
| Auth           | Auth.js (NextAuth v5), dev Credentials provider    |
| Realtime       | Liveblocks (`@liveblocks/react`, `react-ui`, `node`) |
| Validation     | Zod (shared client + server schemas)               |
| Testing        | Vitest (unit/component/integration), Playwright (e2e) |

## Architecture

Responsibilities are split so there is exactly **one** source of truth for
durable data:

- **PostgreSQL** — users, rooms, memberships, tickets, assignees, status,
  ordering, versions. All durable metadata.
- **Liveblocks** — online presence, currently-selected ticket, cursor, typing,
  comment threads, and `BOARD_INVALIDATED`-style broadcasts. **Invalidation
  signals only — never the durable ticket object.**
- **Application server** (route handlers + server actions) — authentication,
  authorization, Zod validation, membership checks, ticket mutations, Liveblocks
  room authorization, and broadcasting board-invalidation events.
- **Frontend** — fetches the authoritative board from the API; uses Liveblocks
  for presence and comments; **refetches** the board when it receives an
  invalidation broadcast; applies optimistic updates only for the acting user
  (with 409-conflict rollback via refetch).

```
Browser ──REST──▶ Next.js route handlers ──▶ Prisma ──▶ PostgreSQL  (source of truth)
   │                     │
   │                     └─ after a mutation: broadcastEvent(BOARD_INVALIDATED)
   │                                                   │
   └──WebSocket── Liveblocks ◀───────────────────────┘
        (presence, selected ticket, typing, comment threads, invalidation)
        on event ▶ client refetches the authoritative board
```

## Data model

Prisma schema (`prisma/schema.prisma`) — key entities:

- **User** — `id, name, email(unique), image, timestamps`
- **Room** — `id, name, slug(unique), repositoryName?, repositoryUrl?, createdById, timestamps`
- **RoomMembership** — `id, roomId, userId, role(OWNER|ENGINEER|VIEWER), createdAt`, unique `(roomId, userId)`
- **Ticket** — `id, roomId, title, description?, status(BACKLOG|IN_PROGRESS|REVIEW|DONE), priority(LOW|MEDIUM|HIGH|URGENT), assigneeId?, position(float), version(int), createdById, timestamps`

Indexes include a composite `@@index([roomId, status, position])` for board/column
queries. Cascade deletes remove a room's memberships and tickets. **`version`**
implements optimistic concurrency: it starts at `1` and increments on every ticket
mutation.

## Authorization

Enforced **server-side** on every protected action (centralized in
`src/lib/permissions`), and again in the Liveblocks auth endpoint. Never trust a
user id, role, room id, or assignee id from the browser.

| Action                | OWNER | ENGINEER | VIEWER |
| --------------------- | :---: | :------: | :----: |
| Read room / presence  |  ✅   |    ✅    |   ✅   |
| Read / add comments   |  ✅   |    ✅    |   ✅¹  |
| Create / edit tickets |  ✅   |    ✅    |   ❌   |
| Move / assign tickets |  ✅   |    ✅    |   ❌   |
| Delete tickets        |  ✅   |    ❌    |   ❌   |
| Update room / members |  ✅   |    ❌    |   ❌   |

¹ **Stage 1 decision:** VIEWERs *may* add comments (they cannot mutate tickets).

Every room API verifies membership via `requireRoomMembership`; non-members
receive `404` (room existence is not leaked). The Liveblocks auth endpoint
verifies the same membership before issuing a room-scoped token.

## Prerequisites

- Node.js ≥ 20 (tested on 22)
- PostgreSQL ≥ 14 running locally
- (Optional) A free Liveblocks account for realtime features

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#    → set DATABASE_URL, AUTH_SECRET (openssl rand -base64 32),
#      and optionally the Liveblocks keys.

# 3. Create the database (example)
#    createdb devroom   # or use an existing Postgres instance

# 4. Apply migrations + generate the Prisma client
npm run db:migrate      # runs prisma migrate dev (creates the schema)

# 5. Seed demo data (idempotent)
npm run db:seed
```

## Environment variables

| Variable                             | Required | Purpose                                              |
| ------------------------------------ | :------: | ---------------------------------------------------- |
| `DATABASE_URL`                       |   Yes    | PostgreSQL connection string                         |
| `AUTH_SECRET`                        |   Yes    | Auth.js session/JWT signing secret                   |
| `NEXTAUTH_URL`                       |  Local   | App base URL (e.g. `http://localhost:3000`)          |
| `DEV_AUTH_ENABLED`                   |   Dev    | `"true"` enables the dev sign-in switcher (dev only) |
| `LIVEBLOCKS_SECRET_KEY`              | Realtime | Server key for the Liveblocks auth endpoint          |
| `NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY`  | Realtime | Presence indicator on the client (optional)          |

> **Security:** `DEV_AUTH_ENABLED` is only honored when `NODE_ENV !== production`
> (see `src/env.ts`). The development sign-in can **never** be enabled in a
> production build. Never commit `.env`.

## Running the app

```bash
npm run dev        # http://localhost:3000  (development sign-in works here)
```

Other commands:

```bash
npm run build      # production build
npm run start      # run the production build (dev sign-in is disabled here)
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit (strict)
npm test           # Vitest (unit + component + integration)
npm run test:e2e   # Playwright two-browser flow
npm run db:reset   # drop, re-migrate and re-seed
```

## Local authentication (dev switcher)

Stage 1 ships a **development-only** sign-in so a demo needs no external identity
provider or paid service:

- The home page (`/`) lists seeded users (Prasanna, Priya, Arun) as one-click
  sign-in buttons, plus a free-form form to sign in / auto-provision **any**
  email.
- Sign in as **different users in two different browsers** (or one normal + one
  incognito window) to test collaboration.

To simulate more members: create a room, then sign in as another email in a
second browser and open the room URL — that user becomes a member on first room
creation, or ask an OWNER to add them (membership APIs are server-enforced).

## Liveblocks setup

Presence and comments require Liveblocks keys:

1. Create a free project at <https://liveblocks.io/dashboard>.
2. Copy the **secret key** into `LIVEBLOCKS_SECRET_KEY`.
3. (Optional) copy the **public key** into `NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY`.
4. Restart `npm run dev`.

Without keys, the app still runs fully: the board persists and updates on refresh,
but presence avatars, selected-ticket viewers, and comment threads are disabled
with a clear in-UI notice.

## API contract

All errors use a consistent envelope and HTTP status codes:

```json
{ "error": { "code": "TICKET_VERSION_CONFLICT", "message": "…", "details": {} } }
```

`400` invalid · `401` unauthenticated · `403` forbidden · `404` not found ·
`409` concurrency conflict · `500` unexpected.

| Method + path                         | Description                                  |
| ------------------------------------- | -------------------------------------------- |
| `GET  /api/rooms`                     | Rooms the current user belongs to            |
| `POST /api/rooms`                     | Create a room (creator becomes OWNER)        |
| `GET  /api/rooms/[roomId]`            | Full board: room + members + tickets         |
| `PATCH /api/rooms/[roomId]`           | Update room metadata (OWNER)                 |
| `GET  /api/rooms/[roomId]/tickets`    | List tickets                                 |
| `POST /api/rooms/[roomId]/tickets`    | Create a ticket                              |
| `GET  /api/tickets/[ticketId]`        | Get a ticket                                 |
| `PATCH /api/tickets/[ticketId]`       | Edit a ticket (requires `expectedVersion`)   |
| `DELETE /api/tickets/[ticketId]`      | Delete a ticket (OWNER)                      |
| `POST /api/tickets/[ticketId]/move`   | Move column/position (requires `expectedVersion`) |
| `POST /api/liveblocks-auth`           | Secure, membership-checked Liveblocks token  |

**Optimistic concurrency:** the client sends `expectedVersion`; the server does an
atomic check-and-set (`updateMany where version = expectedVersion`) and returns
`409 TICKET_VERSION_CONFLICT` on a stale update. The UI shows a clear message and
refetches.

## Testing

```bash
npm test        # 33 tests across 5 files
```

- **Unit** — authorization matrix (`permissions`), ticket Zod schemas, ordering
  logic and status transitions.
- **Component** — `Avatar` (accessible name, initials, image) via Testing Library.
- **Integration** (real Postgres) — create/update/move/delete tickets, **version
  bump**, **409 on stale version**, and **assignee-must-be-a-member** validation.
  These require `DATABASE_URL`; they auto-skip if it is unset.

**End-to-end** (`tests/e2e/collaboration.spec.ts`): a Playwright test using **two
browser contexts** signs in as two users, opens the same room, has User A create
a ticket, and — when Liveblocks keys are present — asserts User B receives the
board update, selected-ticket presence appears for User A, and a comment from
User B is seen by User A in real time. Without Liveblocks keys the realtime
assertions are skipped (the transport boundary is the only mocked/omitted piece)
and the manual demo below covers them.

```bash
npm run test:e2e   # starts the dev server automatically
```

## Manual two-browser demo

The authoritative validation scenario:

1. `npm run dev` with Liveblocks keys set. Run `npm run db:seed`.
2. **Browser 1** → <http://localhost:3000> → sign in as **Prasanna**.
3. **Browser 2** (or incognito) → same URL → sign in as **Priya**.
4. Both open **AgentGuard Development** from `/rooms`.
5. Both users appear in the roster / presence avatars.
6. **Prasanna** clicks a ticket → **Priya** sees "viewing" avatars on that ticket
   and in the roster.
7. **Prasanna** creates or moves a ticket → **Priya's** board updates **without a
   manual refresh**.
8. **Priya** posts a comment on the selected ticket → **Prasanna** sees it live.
9. Refresh either browser → rooms and tickets persist (they are in Postgres).

## Project structure

```
prisma/                       schema, migrations, seed
src/
  app/                        App Router pages + API route handlers
    api/                      rooms, tickets, liveblocks-auth, nextauth
    rooms/[roomId]/           the Dev Room (loading/error/page)
  components/
    dev-room/                 shell, board, columns, cards, details, comments,
                              roster, presence, dialogs, contexts
    ui/                       accessible primitives (button, dialog, avatar, …)
    auth/  rooms/             sign-in + room forms
  lib/
    auth/ db/ liveblocks/     auth config, prisma client, LB server+types
    permissions/ validation/  authorization matrix, Zod schemas
    events/ tickets/ rooms/    broadcast types, ticket + room services
  liveblocks.config.ts        typed Liveblocks global augmentation
tests/
  integration/ e2e/           Postgres integration + Playwright collaboration
```

## Stage 1 limitations

- Presence, selected-ticket viewers, typing, and comments require Liveblocks keys.
- Ticket **ordering within a column** uses fractional positions; drag-and-drop
  moves between columns (append to end). Fine-grained in-column reordering by
  drop index is scaffolded (`positionBetween`) but not wired to the DnD UI.
- Delete is OWNER-only and not version-guarded (documented simpler policy).
- Membership management has server-side rules but no dedicated management UI yet
  (rooms get their OWNER on creation; additional members join by opening the room
  after being added).
- The dev auth switcher is for local use only and is disabled in production.
- Comment threads live in Liveblocks (as designed); they are not mirrored into
  Postgres in Stage 1.

## Recommended first task for Stage 2

**Introduce a durable "agent task" abstraction and a background worker boundary.**
Add an `AgentRun` entity (ticket-scoped: status, requestedBy, startedAt, logs
pointer) and a typed job-dispatch seam in `src/lib/events`, so a **separate**
Python/LangGraph worker (a later stage) can claim a ticket, stream status back
through the existing Liveblocks broadcast channel, and have humans pause/approve/
take over — all without the web app ever executing code itself. This reuses the
Stage 1 invalidation + presence plumbing and keeps agents clearly labeled as a
distinct, opt-in surface.

---

_Stage 1 deliberately excludes AI agents, code execution, and repository
operations. Any agent affordance in the UI is a clearly labeled future feature._
