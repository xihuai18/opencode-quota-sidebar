# Security Policy

## Reporting a Vulnerability

If you discover a security issue in this project, please do not open a public issue first.

Use one of these channels:

1. GitHub Security Advisory (preferred)
2. Open a private report to repository maintainers

Please include:

- affected version
- impact and attack scenario
- minimal reproduction steps
- suggested fix (if available)

We will acknowledge reports as quickly as possible and provide a remediation timeline.

## Security Notes for Contributors

- Never commit real tokens, API keys, or auth snapshots.
- This plugin reads credentials from OpenCode local auth storage; treat all auth data as sensitive.
- Keep debug logs free of secrets.
- Prefer fail-closed behavior for writes (already enforced via symlink checks and atomic writes).
