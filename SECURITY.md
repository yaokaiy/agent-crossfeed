# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
private reporting instead: on the repository page, open the **Security** tab
and choose **Report a vulnerability**.

Include the version, what you did, what happened, and what you expected. You
will get a reply within 7 days.

## What is in scope

agent-crossfeed runs on your machine with your permissions. It starts the
Codex CLI on briefs written by Claude Code and stores job records locally.
Reports about any of the following are welcome:

- a brief, file name or quota reading that causes a command to run outside
  the Codex sandbox;
- a job that writes outside the directory it was given;
- secrets ending up in the ledger, logs or job files;
- a way for the plugin to block or silently change a Claude Code session.

The sandboxing of Codex itself and the permission system of Claude Code are
their vendors' responsibility; report problems in those to them.
