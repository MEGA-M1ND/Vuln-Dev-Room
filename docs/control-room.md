# The repository control room

One screen answering: **what is every agent doing in this repository, and what
is waiting on a person?**

`/rooms/[roomId]/control-room`

## What it reports — and what it deliberately does not

It reports **work**. It does not report **people**.

There is no throughput per developer, no ranking, no leaderboard, no
"productivity" number, and no activity score. An owner is shown on each queue
row so you know who to ask, not so you can measure them. The team activity
timeline is the room's shared history of what happened — a record, not a
metric. If a future change to this page would let someone compare two
teammates' numbers, that change does not belong here.

## Sections

| Section | Answers |
| --- | --- |
| Summary | How much is active, how much is waiting on a person, how much nothing has touched |
| Work queue | Every piece of work in flight, filterable |
| Potential conflicts & risks | The same signals as the insights page (see `risk-signals.md`) |
| Recent outcomes | How the last finished runs ended — including the ones that did not land |
| Recent pull requests | What was opened from this room, and its state |
| Team activity | What agents reported and what people decided, newest first |

## The work queue

Ordered by what most needs a human, not by recency:

1. **Waiting on a person first.** `AWAITING_APPROVAL`, `WAITING_FOR_INPUT`,
   `BLOCKED`, `REVIEW_READY` — the four states where nothing moves until
   someone acts. A `RUNNING` run is unfinished but nobody is blocking it, so it
   sorts below.
2. Then by open risk signals, most first.
3. Then oldest activity first — the thing nobody has touched longest is the
   most likely to be forgotten.

**Tasks with no run at all are included**, marked *Not started*. A task nobody
pointed an agent at is exactly the kind of gap a shared screen should expose.
"Never run" means literally no runs — a task whose run already merged has
plainly been picked up, and is found under recent outcomes instead.

## Filters

Status · owner · agent provider · repository · risk level · "waiting on a
person".

Two rules the implementation holds to:

- **Filter options come from the room's actual data**, so the UI never offers a
  filter that returns nothing. (Owners are the exception: they come from
  membership, so you can check whether a teammate has anything at all.)
- **Filters narrow the queue only.** Recent outcomes, pull requests and
  activity stay unfiltered. Narrowing to one owner should not hide what the
  rest of the team just shipped — that is the opposite of what a shared control
  room is for. The summary counts are likewise computed before filtering, so
  the header does not change meaning as you narrow.

## API

```
GET /api/rooms/[roomId]/control-room
    ?status=BLOCKED&status=RUNNING
    &ownerId=…&provider=claude_code&repository=…&riskLevel=HIGH
    &awaitingHumanOnly=true
```

Any room member may read it — a shared view of what agents are doing is the
whole point. Every filter value is validated against its enum at the route
boundary; a client can never shape a query with an arbitrary string.

Repeated params are OR-ed within a field (`status=A&status=B`) and AND-ed
across fields.

## Providers

`agentProvider` on the task names which agent is doing the work. Runs from the
built-in LangGraph runtime predate that column and report `devroom_builtin`.
Unknown providers render as their raw identifier rather than being hidden, so a
new adapter is visible the day it starts publishing events.
