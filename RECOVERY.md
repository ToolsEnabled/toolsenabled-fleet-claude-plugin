# Resetting Fleet's messaging state after upgrading

This applies if you used Fleet **before** the release that fenced its memory tools. If this
is a fresh install, there is nothing to do.

## What happened

Fleet keeps three kinds of its own state in the same durable memory table its `memory.*`
tools expose, under namespaces reserved for Fleet:

- `agent-comms` — the retained history of messages between agents on this computer,
  including the owner journal that **every** local message is appended to, and each agent's
  read cursor.
- `agent-comms-control` — which channels exist, who is a member, and who has been
  designated.
- `mcp.tool-surface` — the instance records `system.status` reports.

Earlier releases did not reserve those namespaces, so an agent calling `memory.set` could
write or overwrite them, and `memory.get` could read them. That is now refused at the tool
boundary, and only Fleet's own internals reach that state.

Closing the door does not clean the room. If a row was written through the old hole, it is
still there, and Fleet still reads it.

**In 1.7.0 and later** Fleet no longer has a messaging layer. Rows in `agent-comms` and
`agent-comms-control` are left over from an earlier release and nothing reads them;
`system.doctor` reports them as `retired` with a row count. `mcp.tool-surface` is still
read by Fleet. The reset below clears all three, so it also removes the leftovers.

## Why there is no "scan and remove the bad rows"

A forged row has the same schema, the same revision mechanics and the same storage
integrity as a row Fleet wrote itself. After the fact there is nothing that distinguishes
them. Audit records can sometimes help, but they cannot prove innocence when audit was off
or unavailable.

So this procedure does not claim to find forgeries. It resets the state. That is the only
repair anyone can honestly offer, and saying otherwise would be a claim nobody can support.

The report below labels a row that parses as **unverifiable**, never as clean, for exactly
this reason. `malformed` means a row Fleet can no longer parse at all — a positive finding.
`absent` is the only state that needs nothing.

## What is lost, and what is not

Reset: retained local message history, read cursors, channel membership, designation state.
Agents keep working; they simply have no history of earlier messages, and `mcp.tool-surface`
rebuilds itself the next time Fleet starts.

**Not touched:** your ledger, tasks, memory, search index, settings, subagent records and
the audit ledger. Those live elsewhere and this procedure does not read or write them.

## The procedure

**1. Look first.** Safe to run at any time, changes nothing:

```
node ~/.claude/plugins/.../toolsenabled-fleet/recover-state.js
```

(Use the folder your Fleet plugin is installed in. `/tefleet status` names it.)

**2. Stop Fleet.** Close the Claude Code sessions that have Fleet on. The reset refuses to
run while any session is live, because clearing state under a running Fleet would leave
that session holding records that no longer exist. It also refuses when it cannot read one
of Fleet's own session records: not being able to tell must not read as nothing running.
A crashed session that left a readable record does not block it, because liveness means the
recorded process is still that same process — pid and start time, since pids get reused.
The guard is a backstop, not a lock: close the sessions yourself rather than relying on it.

**3. Reset.**

```
node .../toolsenabled-fleet/recover-state.js --reset
```

It copies the state database — including its `-wal` and `-shm` files, which are part of its
current contents — into `recovery-backup-<timestamp>/` beside it, owner-readable only,
before changing anything. Then it clears the three reserved namespaces and prints how many
rows it removed from each.

**4. Start Claude Code again.** Fleet recreates what it needs.

Keep the backup until you are satisfied, then delete it. It contains the state you reset,
including the message history, so treat it as private.

## Checking afterwards

`system.doctor` reports the same `reservedMemory` section, so you can confirm the
namespaces now read `absent`. If a namespace reports `malformed` again later, something is
writing rows Fleet cannot parse; that is worth reporting to support@toolsenabled.ai.
