# Migrating from dsh-assistant-message-forge

`dsh-context-console` is the maintained successor to
`dsh-assistant-message-forge`. It contains the Message Forge views and RPC
surface in addition to the Context Console features.

## Preserved compatibility

- The Message Forge tab remains available.
- The Message Forge endpoint set remains available under `/api/dsh-assistant-message-forge/*`.
- Existing data under `$DSH_HOME/assistant-message-forge/` is reused in place,
  including drafts and recorded context snapshots.
- Session-log recovery remains conservative and creates a repaired child
  session without rewriting the imported source log.

## Switch packages

```powershell
corepack pnpm dsh plugin --profile web remove dsh-assistant-message-forge
corepack pnpm dsh plugin --profile web add dsh-context-console
```

Restart DSH after changing the profile. Do not load both packages at the same
time because they intentionally expose the same compatibility RPC channel and
conversation-view identifier.

## Rollback

```powershell
corepack pnpm dsh plugin --profile web remove dsh-context-console
corepack pnpm dsh plugin --profile web add dsh-assistant-message-forge@0.1.1
```

The legacy data directory is retained, so rollback does not require a data
conversion.
