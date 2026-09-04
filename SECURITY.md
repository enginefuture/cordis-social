# Security policy

## Reporting

Use GitHub private vulnerability reporting for token exposure, unintended
publishing, path traversal, browser profile access, CDP exposure, or dependency
supply-chain issues. Do not place credentials, cookies, private post drafts, or
profile archives in a public issue.

## Deployment

- Keep browser CDP and ProfileFleet on loopback or a trusted private tunnel.
- Store ProfileFleet and platform credentials in environment variables or a
  host secret manager, never Cordis YAML.
- Treat browser profile directories as credentials.
- Run social automation as a dedicated operating-system user.
- Display the exact prepared content and screenshot before passing a
  confirmation token to `social_publish_post`.
- Dispose the Cordis root when a host session ends.

The local browser provider protects against accidental cross-plugin leaks but
is not a security boundary against another process running as the same OS user.
