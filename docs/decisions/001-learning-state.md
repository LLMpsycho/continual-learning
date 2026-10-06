# ADR-001: Acknowledge completed learning updates

Status: Accepted
Date: 2026-10-06

## Context

The version-1 hook overwrote one project JSON file without a lock. Concurrent
sessions lost prompt counts. Scheduling also reset the count and cooldown
before the updater had completed. Failed or denied updates therefore delayed
the next attempt for two hours. Codex replaced punctuation in paths, allowing
different project names to share the same state.

## Decision

Use version-2 state with a pending request UUID, a 15-minute renewable lease,
and the last successfully completed UUID. Serialize each read/modify/write
transaction with exclusive file creation, and persist through a temporary
sibling and atomic rename. Bound lock acquisition to four seconds. Never
reset invalid state or automatically steal a possibly live owner's lock.

Scheduling retains counts and the successful-completion timestamp. The updater
renews ownership before writes and acknowledges completion only after memory
and index handling succeeds. The index must carry the matching request UUID.
Completion subtracts the scheduled count, preserving prompts arriving during
the update. Abandoned requests can retry after lease expiry; old UUIDs cannot
complete a newer request.

Codex uses SHA-256 of the canonical absolute cwd. Keep ambiguous old slug
directories untouched rather than assigning their counters to a guessed
project. Claude/Droid keep their existing state locations and migrate valid
version-1 counters in place.

Keep elapsed-time cooldown semantics and the immediate first update. Active
work timing would require a separate definition of activity and idle gaps;
it is not necessary to fix isolation or concurrency.

The updater's version-2 index records consumed byte offsets and read-time
snapshots. Structural transcript filtering and memory merging remain the
agent's responsibility. The hook checks acknowledgement identity and basic
index structure; it cannot independently prove semantic memory quality.

## Alternatives

- Atomic replacement without locking prevents partial JSON but still loses
  read/modify/write increments.
- Resetting the timer at scheduling avoids duplicate requests but punishes
  failed updates. A renewable pending request separates those concerns.
- Adding a database or lock dependency expands installation requirements for
  a small local hook. Exclusive file creation is sufficient for short local
  transactions; crash recovery is explicit.
- Guessing a migration owner for old Codex slug keys risks crossing project
  boundaries. Fresh unambiguous state is safer, without deleting old data.

## Consequences

Hook, helper and agent must be upgraded together with sessions closed. A hard
kill may leave a lock requiring manual inspection. Renewal failure must stop
an updater before writes. Version-1 state remains migratable, but rollback to
the old hook needs the pre-upgrade state backup because the old reader does
not understand version 2. No production database or external service changes
are required.
