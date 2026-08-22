# Security policy

## Supported versions

Security fixes are applied to the latest published version of
`dsh-context-console`. DeepSeek Harness is still evolving through breaking
release candidates, so compatibility fixes target the DSH version documented
in the current README rather than unsupported historical releases.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do
not include credentials, private session logs, or unredacted DSH configuration
in a public issue.

Include the affected plugin and DSH versions, the smallest safe reproduction,
and the expected impact. If a report needs a session log, reduce it to synthetic
events first.

## Trust boundaries

- The host plugin runs with the permissions of the local DSH process.
- Session-log repair creates a validated child session and never rewrites the
  imported source log.
- State exports can contain MCP configuration, environment-variable names, or
  request headers and must be reviewed before sharing.
- The browser client talks to loopback DSH RPC channels; the plugin does not
  provide a remote authentication boundary.
