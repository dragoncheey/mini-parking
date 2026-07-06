# Self-hosted deployment design

## Context

The mini program currently sends production traffic through Tencent CloudBase. The Node API is already containerized, while PostgreSQL data and evidence photos are stored in the hosted Supabase project. The target environment is a mainland China Ubuntu/Debian server with Docker installed. No production domain is available yet.

This migration moves the API runtime and HTTPS ingress from CloudBase to the self-managed server. Supabase remains the database and object-storage provider.

## Goals

- Run the Node API and HTTPS ingress with Docker Compose on the self-managed server.
- Use Caddy for TLS termination, certificate renewal, HTTP-to-HTTPS redirects, and reverse proxying.
- Send all mini-program API and upload traffic through a normal HTTPS origin.
- Remove CloudBase initialization, `callContainer`, CloudBase headers, and CloudBase-only upload behavior.
- Preserve the existing Supabase schema, data, public photo URLs, and SenseNova integration.
- Harden authentication and public request handling before exposing the API to the internet.
- Provide repeatable deployment, verification, upgrade, and rollback instructions.

## Non-goals

- Migrating PostgreSQL or object storage away from Supabase.
- Changing parking, vehicle, voting, recommendation, or recognition business rules.
- Automating domain purchase, ICP filing, mini-program filing, or DNS-provider configuration.
- Building a general-purpose CI/CD platform.
- Supporting CloudBase and self-hosting simultaneously after the migration.

## Architecture

Production requests follow this path:

```text
WeChat mini program
  -> https://<API domain>
  -> Caddy container (ports 80/443, TLS and access logs)
  -> Node API container (private Compose network, port 8787)
  -> Supabase Database / Storage
```

The Node API also makes outbound HTTPS calls to WeChat `jscode2session` and the configured SenseNova-compatible endpoint. The Node container has no host port mapping. Only Caddy publishes ports 80 and 443.

## Repository changes

### Deployment assets

Add the following files:

- `compose.yaml`: defines `api` and `caddy`, restart policies, the private network, health checks, and persistent Caddy data/config volumes.
- `Caddyfile`: uses `{$API_SITE_ADDRESS}` as the site address and reverse-proxies to `api:8787`.
- `.env.server.example`: documents deployment variables without real credentials.
- `docs/self-hosted-deployment.md`: operator runbook for preparation, deployment, DNS/TLS cutover, mini-program configuration, upgrades, and rollback.

The Compose configuration uses `API_SITE_ADDRESS=:80` during IP-only health verification. After a domain is acquired and its ICP filing is complete, the operator changes the value to the production hostname. Caddy then obtains a publicly trusted certificate and redirects HTTP to HTTPS automatically.

The Caddy data and config directories use named volumes so certificates and account state survive container replacement. The API container reads secrets from an untracked `.env.server` file.

### Container image

Update the existing Dockerfile to listen on internal port `8787`, include a container health check-compatible runtime, and run the application as the unprivileged `node` user. The production image contains only package metadata, production dependencies, `server/`, and `utils/`.

### Mini-program transport

- Remove `wx.cloud.init` from `app.js`.
- Replace `cloudbaseConfig` in `config/api.js` with ordinary API configuration.
- Keep `http://127.0.0.1:8787` as the committed development default until a production domain exists.
- Document the explicit release step that changes `baseUrl` and `recognitionApiUrl` to the final HTTPS API origin. A bare IP is never used in release configuration.
- Remove CloudBase client creation, `callContainer`, `X-WX-SERVICE`, CloudBase upload-token branching, and CloudBase-specific error messages from `utils/api.js`.
- Send JSON API calls with `wx.request` and photos with `wx.uploadFile` to the self-hosted origin.
- Send recognition through the authenticated generic request path instead of a separate unauthenticated transport.

The mini program no longer uploads directly to a Supabase signed URL. The API accepts multipart upload data and writes it to the existing Supabase Storage bucket. Returned evidence URLs remain Supabase public URLs.

### Server cleanup

- Remove CloudBase OpenID-header extraction from `server/auth.js` and request authentication.
- Remove `/api/upload-token` after the client no longer depends on signed direct uploads.
- Keep `/api/upload` as the single authenticated upload endpoint.
- Update health-route metadata, tests, README content, and deployment documentation accordingly.
- Remove the obsolete `docs/cloudbase-run.md` after its useful environment-variable guidance has been incorporated into the self-hosted runbook.

## Runtime flows

### Login

1. The mini program calls `wx.login` and sends the temporary code to `POST /api/login`.
2. The API exchanges the code through WeChat `jscode2session` using server-side `WX_APPID` and `WX_APP_SECRET`.
3. The API creates or loads the Supabase user and returns a signed, expiring bearer token.
4. The mini program stores the token and attaches it to protected requests.

### Business API

1. Caddy accepts HTTPS and forwards the request and request ID to Node.
2. Node validates the bearer-token signature and expiry.
3. Node reads or writes through the existing Supabase client.
4. Node returns the existing JSON response shape so page behavior remains unchanged.

### Evidence upload and recognition

1. The authenticated mini program uploads a photo to `/api/upload` with `wx.uploadFile`.
2. Node enforces the request-size limit, parses the multipart file, and uploads it to Supabase Storage.
3. Node returns the existing public URL, storage bucket, and storage path metadata.
4. The authenticated recognition request references uploaded photos.
5. Node downloads those objects through Supabase and calls SenseNova.

## Security

### Secrets and server access

- `.env.server` is ignored by Git and never copied into the image.
- Required production secrets are `SUPABASE_SERVICE_KEY`, `WX_APP_SECRET`, `SENSENOVA_API_KEY`, and `AUTH_TOKEN_SECRET`.
- The password disclosed during planning must be rotated before deployment. Deployment should use an SSH key, a non-root administrative user where practical, and disabled password login after key access is verified.
- The host firewall exposes only 80/443 publicly. SSH is restricted by source address or an equivalent access control where feasible.

### Authentication

The existing Base64 token is forgeable and is not suitable for an internet-facing service. Replace it with a dependency-free HMAC-SHA256 token implemented with Node's `crypto` module:

- Payload: OpenID, issued-at time, and expiry time.
- Encoding: base64url payload plus base64url signature.
- Validation: format, signature using `timingSafeEqual`, required fields, and expiry.
- Configuration: `AUTH_TOKEN_SECRET` is mandatory when `NODE_ENV=production`; `AUTH_TOKEN_TTL_SECONDS` defaults to seven days.

Recognition becomes an authenticated route because it can incur model cost. Invalid, expired, or missing credentials return `401`; authenticated users without ownership permission continue to receive `403` where applicable.

### Request limits

Apply the existing 8 MiB limit consistently to JSON and multipart bodies. Oversized requests return `413` with a stable error code and request ID instead of being buffered without a limit.

## Configuration

The server environment contract is:

| Variable | Required in production | Purpose |
| --- | --- | --- |
| `API_SITE_ADDRESS` | Yes | Caddy site address; `:80` only for staging, hostname for production |
| `HOST` | Yes | API bind address, `0.0.0.0` in the container |
| `PORT` | Yes | Internal API port, `8787` |
| `SUPABASE_URL` | Yes | Existing hosted Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Server-only Supabase service role key |
| `SUPABASE_STORAGE_BUCKET` | Yes | Existing evidence bucket name |
| `WX_APPID` | Yes | Mini-program AppID |
| `WX_APP_SECRET` | Yes | Server-only mini-program secret |
| `AUTH_TOKEN_SECRET` | Yes | HMAC signing key generated with cryptographic randomness |
| `AUTH_TOKEN_TTL_SECONDS` | No | Token lifetime; defaults to 604800 seconds |
| `SENSENOVA_API_KEY` | Yes for real recognition | Model API key |
| `SENSENOVA_BASE_URL` | Yes for real recognition | Model endpoint |
| `SENSENOVA_MODEL` | Yes for real recognition | Model name |
| `MODEL_API_MOCK` | No | Must be `0` for production recognition |

## Error handling and observability

- Preserve and propagate `X-Request-Id`; generate one when absent.
- Return stable status codes and JSON error codes for authentication, body-size, upstream, schema, and validation failures.
- Caddy writes access logs; Node keeps concise request and upstream-failure logs without secrets, tokens, or photo content.
- Compose restarts failed services automatically.
- The API health check probes `http://127.0.0.1:8787/health` inside the API container.
- Deployment verification checks container health separately from Supabase functionality so a reachable process is not confused with a fully working application.

## Rollout

### Phase 1: repository and IP-only staging

1. Implement and test the transport, authentication, deployment files, and documentation locally.
2. Rotate the disclosed server credential and establish SSH-key access.
3. Create `.env.server` on the server and set `API_SITE_ADDRESS=:80`.
4. Start Compose and verify `/health` through the server IP.
5. Verify API-to-Supabase connectivity from the container without using the IP as a mini-program production origin.

### Phase 2: production hostname

1. Acquire a domain eligible for filing and complete the required ICP/mini-program filing steps through the access provider and WeChat processes.
2. Point the API hostname to the server and confirm ports 80/443 are reachable.
3. Change `API_SITE_ADDRESS` to the hostname and verify Caddy-issued HTTPS.
4. Put the HTTPS origin into `config/api.js`.
5. Add the API hostname to the mini program's request and upload-file legal-domain lists. Keep the Supabase project hostname allowed for evidence-image access where required by the WeChat configuration.
6. Build a trial version, execute end-to-end acceptance tests, and then release.

The absence of a filed domain blocks Phase 2 release, but it does not block code migration or Phase 1 server verification.

## Testing and acceptance

### Automated verification

- Existing pricing, recommendation, data normalization, page, and database-adapter tests continue to pass.
- Remove CloudBase transport and direct-upload-token tests.
- Add client tests proving API and upload calls use the configured normal HTTP origin and never call `wx.cloud`.
- Add token tests for a valid token, malformed token, wrong signature, expired token, and production startup without a secret.
- Add route tests proving recognition requires authentication and oversized multipart requests are rejected.
- Run `npm test`.
- Run `docker compose config` with non-secret test values.
- Build the production API image.

### Server verification

- Both containers start and become healthy.
- `GET /health` succeeds through Caddy.
- The API can query the existing Supabase schema.
- Restarting the Compose project preserves Caddy state and API availability.
- After DNS cutover, HTTP redirects to HTTPS and the certificate chain validates for the production hostname.

### End-to-end acceptance

In a WeChat trial build, verify login, parking-lot list/detail, vehicle create/update/delete, evidence upload, recognition, parking-lot create/update, voting, and evidence-image rendering. Confirm that logs contain matching request IDs and no CloudBase calls occur.

## Upgrade and rollback

The runbook records the deployed Git commit before each upgrade. An upgrade pulls or copies the intended revision and runs a Compose rebuild. If health or smoke checks fail, restore the previous revision and rebuild. Database migrations are not part of this deployment, so application rollback does not require a Supabase data rollback.

## Completion criteria

The code migration is complete when automated tests, Compose validation, image build, and IP-only server health/Supabase checks pass. The production migration is complete only after a filed domain is configured, Caddy serves valid HTTPS, WeChat legal domains are updated, and the trial-build end-to-end checklist passes.
