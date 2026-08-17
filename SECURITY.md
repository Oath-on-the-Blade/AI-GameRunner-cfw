# Security policy for development

## Secrets

Do not commit API keys, Cloudflare API tokens, account credentials, `.dev.vars`, `.env`, or copied secret files.

Use Cloudflare Worker secrets for deployed provider credentials:

```bash
npx wrangler secret put SECRET_NAME
```

Use an ignored `.dev.vars` file for local-only secrets.

If a credential is ever committed, treat it as compromised: revoke/rotate it first, then remove it from repository history as a separate remediation step.

## Current MVP limitations

The MVP has no player authentication or authorization. Do not use it as a production public multiplayer service until identity, seat authorization, request limits, and private-observation delivery are implemented.
