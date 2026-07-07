# Self-hosted Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the mini-parking API runtime from Tencent CloudBase to the self-managed Docker/Caddy server at `parking.kuaidianfanfan.com`, while continuing to use the existing hosted Supabase database and Storage project.

**Architecture:** The WeChat mini program calls `https://parking.kuaidianfanfan.com`; Caddy terminates TLS and reverse-proxies to the private Node API container on port `8787`; Node authenticates signed bearer tokens and reads/writes the existing Supabase project. CloudBase transport, CloudBase OpenID headers, and CloudBase signed-upload shortcuts are removed.

**Tech Stack:** Native WeChat mini-program JavaScript, Node.js `http` server, Node `crypto` HMAC-SHA256, Supabase JS v2, Docker Compose, Caddy.

---

## File structure

- Modify `app.js`: remove CloudBase initialization from mini-program launch.
- Modify `config/api.js`: remove `cloudbaseConfig`; set `apiConfig.baseUrl` and `apiConfig.recognitionApiUrl` to the HTTPS production domain.
- Modify `utils/api.js`: remove CloudBase client code; route all JSON calls through `wx.request`; route all image uploads through `wx.uploadFile` to `/api/upload`.
- Modify `server/auth.js`: replace unsigned Base64 tokens with signed, expiring HMAC-SHA256 bearer tokens; remove CloudBase OpenID extraction.
- Modify `server/index.js`: export a testable server factory, make recognition authenticated, remove `/api/upload-token`, enforce multipart size limits, and keep `/api/upload` as the only upload endpoint.
- Modify `server/db.js`: remove the unused signed upload-token helper after `/api/upload-token` is removed.
- Modify `Dockerfile`: build a production image that runs as the unprivileged `node` user and exposes internal port `8787`.
- Create `compose.yaml`: define `api` and `caddy` services, private networking, health checks, restart policies, and persistent Caddy volumes.
- Create `Caddyfile`: serve `parking.kuaidianfanfan.com` and reverse-proxy to `api:8787`.
- Modify `.env.example`: keep local-development variables and point readers to `.env.server.example` for production.
- Create `.env.server.example`: document required deployment variables without secrets.
- Modify `.gitignore`: ignore `.env.server` and local worktree directories if they are not already ignored.
- Modify `README.md`: replace CloudBase deployment guidance with the self-hosted deployment summary.
- Replace `docs/cloudbase-run.md` with `docs/self-hosted-deployment.md`: provide the operator runbook for DNS, Caddy TLS, Compose deployment, WeChat legal domains, verification, upgrade, and rollback.
- Modify `scripts/run-tests.js`: remove CloudBase tests, add self-hosted config/client/auth/server tests, and preserve existing pricing/recommendation/UI/storage/model tests.

## Preflight and isolation

### Task 1: Confirm workspace state and choose isolation

**Files:**
- Inspect: `.gitignore`
- Possible modify: `.gitignore`

- [ ] **Step 1: Detect whether this checkout is already isolated**

Run:

```bash
git rev-parse --git-dir
git rev-parse --git-common-dir
git rev-parse --show-superproject-working-tree
git branch --show-current
git status --short
```

Expected: the checkout is a normal repository, not a linked worktree, and it contains pre-existing local modifications in `README.md`, `pages/add/add.js`, `pages/index/index.js`, `pages/index/index.wxml`, `pages/index/index.wxss`, `scripts/run-tests.js`, and `utils/location.js`.

- [ ] **Step 2: Ask before creating an isolated worktree**

Ask the user:

```text
是否允许我创建隔离 worktree？这样可以保护你当前分支上的本地修改。若不允许，我会在当前目录小范围补丁实现。
```

Expected: if the user approves, create a project-local worktree; if the user declines, continue in the current directory with path-limited edits.

- [ ] **Step 3: If using a project-local worktree, ensure it is ignored**

Run:

```bash
git check-ignore -q .worktrees
```

Expected: exit code `0`. If it exits non-zero, add this exact block to `.gitignore`:

```gitignore

# Local agent worktrees
.worktrees/
```

Then run:

```bash
git check-ignore -q .worktrees
```

Expected: exit code `0`.

- [ ] **Step 4: If approved, create the worktree**

Run:

```bash
git worktree add .worktrees/self-hosted-deployment -b codex/self-hosted-deployment
```

Expected: new worktree exists at `.worktrees/self-hosted-deployment` on branch `codex/self-hosted-deployment`.

- [ ] **Step 5: Run baseline tests**

Run from the chosen working directory:

```bash
npm test
```

Expected: either `all tests passed`, or failures clearly attributable to pre-existing local edits. If tests fail before migration changes, report the failures and ask whether to proceed.

## Tests first

### Task 2: Update tests for self-hosted configuration and client transport

**Files:**
- Modify: `scripts/run-tests.js`

- [ ] **Step 1: Change auth/config imports**

Replace this import block:

```js
const { extractCloudOpenid, extractOpenid, generateToken } = require("../server/auth");
const { cloudbaseConfig } = require("../config/api");
```

with:

```js
const { decodeToken, extractOpenid, generateToken } = require("../server/auth");
const { apiConfig } = require("../config/api");
```

- [ ] **Step 2: Replace the CloudBase auth-helper test**

Replace `testServerAuthHelpers()` with:

```js
function withAuthEnv(values, fn) {
  const previous = {};
  Object.keys(values).forEach((key) => {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  });

  try {
    return fn();
  } finally {
    Object.keys(values).forEach((key) => {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    });
  }
}

function testServerAuthHelpers() {
  withAuthEnv({
    AUTH_TOKEN_SECRET: "test-secret-for-hmac",
    AUTH_TOKEN_TTL_SECONDS: "60"
  }, () => {
    const token = generateToken("openid_1", { nowMs: 1_700_000_000_000 });
    assert.strictEqual(
      extractOpenid({ headers: { authorization: `Bearer ${token}` } }, { nowMs: 1_700_000_001_000 }),
      "openid_1"
    );
    assert.strictEqual(decodeToken(token, { nowMs: 1_700_000_001_000 }).openid, "openid_1");
    assert.strictEqual(extractOpenid({ headers: {} }), null);

    const tampered = token.replace(/.$/, token.endsWith("a") ? "b" : "a");
    assert.strictEqual(extractOpenid({ headers: { authorization: `Bearer ${tampered}` } }), null);

    const expired = generateToken("openid_2", {
      nowMs: 1_700_000_000_000,
      ttlSeconds: 1
    });
    assert.strictEqual(
      extractOpenid({ headers: { authorization: `Bearer ${expired}` } }, { nowMs: 1_700_000_002_000 }),
      null
    );
  });

  withAuthEnv({
    NODE_ENV: "production",
    AUTH_TOKEN_SECRET: undefined
  }, () => {
    assert.throws(
      () => generateToken("openid_3"),
      /AUTH_TOKEN_SECRET is required/
    );
  });
}
```

- [ ] **Step 3: Add a domain/config test**

Add this function after `testLocationEntryPointsUsePrivacyAwareHelper()`:

```js
function testSelfHostedApiConfiguration() {
  const appJs = readProjectFile("app.js");
  const configJs = readProjectFile("config/api.js");
  const utilsApiJs = readProjectFile("utils/api.js");

  assert.strictEqual(apiConfig.baseUrl, "https://parking.kuaidianfanfan.com");
  assert.strictEqual(apiConfig.recognitionApiUrl, "https://parking.kuaidianfanfan.com/api/recognize-parking");
  assert.doesNotMatch(appJs, /wx\.cloud/);
  assert.doesNotMatch(configJs, /cloudbaseConfig|prod-d0g1zp7w0322a5d42|mini-parking-api/);
  assert.doesNotMatch(utilsApiJs, /callContainer|X-WX-SERVICE|wx\.cloud|upload-token/);
}
```

- [ ] **Step 4: Replace the CloudBase recognition transport test**

Remove `testCloudbaseRecognitionTimeout()` and add:

```js
async function testRecognitionUsesSelfHostedRequest() {
  const store = installWxStorageMock();
  store.auth_token = "signed-token";
  const calls = [];
  global.wx.request = (options) => {
    calls.push(options);
    options.success({
      statusCode: 200,
      data: { ok: true, recognition: { name: "自有服务器识别" } }
    });
  };

  try {
    const result = await api.requestParkingRecognition({
      photoRefs: [{
        uploadedUrl: "https://example.supabase.co/storage/v1/object/public/parking-evidence/evidence/photo.jpg",
        storageBucket: "parking-evidence",
        storagePath: "evidence/photo.jpg",
        mediaType: "image/jpeg"
      }]
    });

    assert.strictEqual(result.recognition.name, "自有服务器识别");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "https://parking.kuaidianfanfan.com/api/recognize-parking");
    assert.strictEqual(calls[0].method, "POST");
    assert.strictEqual(calls[0].timeout, 60000);
    assert.strictEqual(calls[0].header.Authorization, "Bearer signed-token");
    assert.deepStrictEqual(calls[0].data.photoRefs[0].storagePath, "evidence/photo.jpg");
    assert.ok(calls[0].data.requestId);
  } finally {
    delete global.wx.request;
  }
}
```

- [ ] **Step 5: Replace the CloudBase signed-upload test**

Remove `testCloudbaseUploadUsesSignedSupabaseUpload()` and add:

```js
async function testUploadUsesSelfHostedMultipartEndpoint() {
  const store = installWxStorageMock();
  store.auth_token = "signed-token";
  const uploadCalls = [];
  global.wx.uploadFile = (options) => {
    uploadCalls.push(options);
    options.success({
      statusCode: 201,
      data: JSON.stringify({
        uploadedUrl: "https://example.supabase.co/storage/v1/object/public/parking-evidence/evidence/photo.jpg",
        storageBucket: "parking-evidence",
        storagePath: "evidence/photo.jpg"
      })
    });
  };

  try {
    const result = await api.uploadImage("/tmp/local-photo.jpg");
    assert.strictEqual(uploadCalls.length, 1);
    assert.strictEqual(uploadCalls[0].url, "https://parking.kuaidianfanfan.com/api/upload");
    assert.strictEqual(uploadCalls[0].filePath, "/tmp/local-photo.jpg");
    assert.strictEqual(uploadCalls[0].name, "file");
    assert.strictEqual(uploadCalls[0].header.Authorization, "Bearer signed-token");
    assert.strictEqual(uploadCalls[0].header["X-Request-Id"].startsWith("upload-"), true);
    assert.strictEqual(result.storagePath, "evidence/photo.jpg");
  } finally {
    delete global.wx.uploadFile;
  }
}
```

- [ ] **Step 6: Add API error test without mutating CloudBase config**

Replace `testApiErrorMetadata()` with:

```js
async function testApiErrorMetadata() {
  installWxStorageMock();
  global.wx.request = (options) => {
    options.success({
      statusCode: 401,
      data: {
        error: "unauthorized: missing or invalid token",
        code: "UNAUTHORIZED"
      }
    });
  };

  try {
    await assert.rejects(
      () => api.request("POST", "/api/parking-lots", {}),
      (error) => {
        assert.strictEqual(error.statusCode, 401);
        assert.strictEqual(error.code, "UNAUTHORIZED");
        assert.match(error.message, /unauthorized/);
        return true;
      }
    );
  } finally {
    delete global.wx.request;
  }
}
```

- [ ] **Step 7: Add server route-limit tests**

Add these helpers and test after `testUploadUsesSelfHostedMultipartEndpoint()`:

```js
function requestNodeServer(server, options, body) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const req = require("http").request({
        host: "127.0.0.1",
        port: address.port,
        path: options.path,
        method: options.method || "GET",
        headers: options.headers || {}
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          server.close(() => {
            resolve({
              statusCode: res.statusCode,
              data: data ? JSON.parse(data) : {}
            });
          });
        });
      });
      req.on("error", (error) => {
        server.close(() => reject(error));
      });
      if (body) req.write(body);
      req.end();
    });
  });
}

async function testServerRoutesRequireAuthAndLimitMultipart() {
  const { createAppServer } = require("../server/index");
  await withAuthEnv({
    AUTH_TOKEN_SECRET: "test-secret-for-hmac",
    AUTH_TOKEN_TTL_SECONDS: "60"
  }, async () => {
    const recognition = await requestNodeServer(
      createAppServer(),
      {
        path: "/api/recognize-parking",
        method: "POST",
        headers: { "content-type": "application/json" }
      },
      JSON.stringify({ photos: [] })
    );
    assert.strictEqual(recognition.statusCode, 401);
    assert.strictEqual(recognition.data.code, "UNAUTHORIZED");

    const token = generateToken("openid_1");
    const boundary = "----mini-parking-test-boundary";
    const largeBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      Buffer.alloc(8 * 1024 * 1024 + 1, "x"),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const upload = await requestNodeServer(
      createAppServer(),
      {
        path: "/api/upload",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": largeBody.length
        }
      },
      largeBody
    );
    assert.strictEqual(upload.statusCode, 413);
    assert.strictEqual(upload.data.code, "BODY_TOO_LARGE");
  });
}
```

- [ ] **Step 8: Update the test runner call list**

In `run()`, add these calls:

```js
  testSelfHostedApiConfiguration();
  await testRecognitionUsesSelfHostedRequest();
  await testUploadUsesSelfHostedMultipartEndpoint();
  await testServerRoutesRequireAuthAndLimitMultipart();
```

Remove these calls:

```js
  await testCloudbaseRecognitionTimeout();
  await testCloudbaseUploadUsesSignedSupabaseUpload();
```

- [ ] **Step 9: Run the tests and verify the expected red phase**

Run:

```bash
npm test
```

Expected: tests fail because `cloudbaseConfig` still exists, `app.js` still calls `wx.cloud`, `utils/api.js` still has `callContainer`, auth tokens are not HMAC-signed yet, and `server/index.js` does not export `createAppServer`.

## Implementation

### Task 3: Implement signed self-hosted authentication

**Files:**
- Modify: `server/auth.js`

- [ ] **Step 1: Replace the whole file with signed-token helpers**

Use this implementation:

```js
const crypto = require("crypto");

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getAuthTokenSecret(options) {
  const env = (options && options.env) || process.env;
  const secret = env.AUTH_TOKEN_SECRET || "";
  if (!secret && env.NODE_ENV === "production") {
    throw new Error("AUTH_TOKEN_SECRET is required in production");
  }
  return secret || "mini-parking-dev-auth-secret";
}

function getTokenTtlSeconds(options) {
  const env = (options && options.env) || process.env;
  const explicit = options && options.ttlSeconds;
  const raw = explicit != null ? explicit : env.AUTH_TOKEN_TTL_SECONDS;
  const ttl = Number(raw || DEFAULT_TTL_SECONDS);
  return Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TTL_SECONDS;
}

function signPayload(encodedPayload, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""), "base64url");
  const right = Buffer.from(String(b || ""), "base64url");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function generateToken(openid, options) {
  if (!openid) {
    throw new Error("openid is required");
  }
  const nowMs = (options && options.nowMs) || Date.now();
  const issuedAt = Math.floor(nowMs / 1000);
  const ttlSeconds = getTokenTtlSeconds(options);
  const payload = {
    openid,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload, getAuthTokenSecret(options));
  return `${encodedPayload}.${signature}`;
}

function decodeToken(token, options) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [encodedPayload, signature] = parts;
    const expected = signPayload(encodedPayload, getAuthTokenSecret(options));
    if (!safeEqual(signature, expected)) return null;

    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload || !payload.openid || !payload.exp) return null;

    const nowMs = (options && options.nowMs) || Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    if (Number(payload.exp) <= nowSeconds) return null;

    return payload;
  } catch {
    return null;
  }
}

function extractOpenid(req, options) {
  const auth = (req.headers && req.headers.authorization) || "";
  if (!auth.startsWith("Bearer ")) return null;
  const payload = decodeToken(auth.slice(7), options);
  return payload ? payload.openid : null;
}

module.exports = {
  decodeToken,
  extractOpenid,
  generateToken,
  getAuthTokenSecret
};
```

- [ ] **Step 2: Run focused auth tests**

Run:

```bash
npm test
```

Expected: auth-helper assertions pass; remaining failures point to CloudBase client/config/server route changes.

### Task 4: Remove CloudBase from the mini program client

**Files:**
- Modify: `app.js`
- Modify: `config/api.js`
- Modify: `utils/api.js`

- [ ] **Step 1: Replace `app.js` launch code**

Use this file content:

```js
App({
  globalData: {
    userLocation: null,
    destination: null,
    durationMinutes: 30,
    authToken: ""
  }
});
```

- [ ] **Step 2: Replace `config/api.js`**

Use this file content:

```js
const API_BASE_URL = "https://parking.kuaidianfanfan.com";

const apiConfig = {
  baseUrl: API_BASE_URL,
  recognitionApiUrl: `${API_BASE_URL}/api/recognize-parking`,
  requestTimeoutMs: 30000,
  recognitionTimeoutMs: 60000
};

module.exports = {
  apiConfig
};
```

- [ ] **Step 3: Remove CloudBase helpers from `utils/api.js`**

Change the first line to:

```js
const { apiConfig } = require("../config/api");
```

Delete `cloudClientPromise`, `buildCloudHeaders()`, `getCloudClient()`, `resetCloudClientForTests()`, `requestWithCloudBase()`, `readFileAsArrayBuffer()`, and `uploadFileToSignedUrl()`.

- [ ] **Step 4: Make recognition use the normal authenticated request path**

Replace `requestParkingRecognition()` with:

```js
function requestParkingRecognition(payload, options) {
  const opts = options || {};
  const requestId = opts.requestId || createRequestId("recognition");
  return request("POST", "/api/recognize-parking", {
    ...(payload || {}),
    requestId
  }, {
    requestId,
    timeout: apiConfig.recognitionTimeoutMs || apiConfig.requestTimeoutMs
  });
}
```

- [ ] **Step 5: Simplify `requestApi()`**

Replace `requestApi()` with:

```js
function requestApi(options) {
  return requestWithWxRequest(options);
}
```

- [ ] **Step 6: Simplify generic `request()`**

Remove the `if (cloudbaseConfig.enabled) { ... }` branch from `request()` so it always builds:

```js
const baseUrl = apiConfig.baseUrl || "http://127.0.0.1:8787";
const url = baseUrl + path;
```

and always calls `wx.request`.

- [ ] **Step 7: Simplify `uploadImage()`**

Delete the `if (cloudbaseConfig.enabled) { ... }` branch so `uploadImage()` always calls `wx.uploadFile` at:

```js
const path = "/api/upload";
const baseUrl = apiConfig.baseUrl || "http://127.0.0.1:8787";
const url = baseUrl + path;
```

- [ ] **Step 8: Update exports**

Remove `resetCloudClientForTests` from `module.exports`.

- [ ] **Step 9: Run tests**

Run:

```bash
npm test
```

Expected: client/config tests pass; remaining failures are server route cleanup and deployment documentation.

### Task 5: Clean up server routes and multipart limits

**Files:**
- Modify: `server/index.js`
- Modify: `server/db.js`

- [ ] **Step 1: Update server auth import**

Replace:

```js
const { extractCloudOpenid, extractOpenid, generateToken } = require("./auth");
```

with:

```js
const { extractOpenid, generateToken, getAuthTokenSecret } = require("./auth");
```

- [ ] **Step 2: Add a production secret check after `loadLocalEnv()`**

Add:

```js
getAuthTokenSecret();
```

Expected: production startup fails fast if `NODE_ENV=production` and `AUTH_TOKEN_SECRET` is missing.

- [ ] **Step 3: Limit multipart reads**

Inside `parseMultipart(req)`, replace:

```js
const chunks = [];
req.on("data", (chunk) => chunks.push(chunk));
```

with:

```js
const chunks = [];
let totalBytes = 0;
req.on("data", (chunk) => {
  totalBytes += chunk.length;
  if (totalBytes > MAX_BODY_BYTES) {
    reject(new Error("request body too large"));
    req.destroy();
    return;
  }
  chunks.push(chunk);
});
```

- [ ] **Step 4: Remove CloudBase login fallback**

Replace the beginning of `handleLogin()` with:

```js
async function handleLogin(req, res) {
  const { code, nickname, avatarUrl } = await readJsonBody(req);

  if (!code) {
    return sendError(res, 400, "missing code", "MISSING_CODE");
  }

  const { openid } = await wxCode2Session(code);
```

Keep the existing user creation, profile update, token generation, and response.

- [ ] **Step 5: Make recognition authenticated**

Remove recognition from `PUBLIC_ROUTES` and from `isPublicRoute()` by deleting the exact recognition entries:

```js
  { method: "POST", prefix: "/api/recognize-parking" },
```

and:

```js
  if (method === "POST" && pathname === "/api/recognize-parking") return true;
```

Move the recognition route below the authentication block:

```js
    // POST /api/recognize-parking (auth required)
    if (method === "POST" && pathname === "/api/recognize-parking") {
      await handleRecognize(req, res);
      return;
    }
```

- [ ] **Step 6: Remove upload-token route and handler**

Delete `handleUploadToken()` and remove this route block:

```js
    // POST /api/upload-token (auth required)
    if (method === "POST" && pathname === "/api/upload-token") {
      await handleUploadToken(req, res);
      return;
    }
```

In the health response route list, remove:

```js
"/api/upload-token"
```

- [ ] **Step 7: Export a testable server factory**

Replace:

```js
const server = http.createServer(async (req, res) => {
```

with:

```js
function createAppServer() {
  return http.createServer(async (req, res) => {
```

After the request handler closes, replace:

```js
server.listen(PORT, HOST, () => {
  console.log(`parking api listening on http://${HOST}:${PORT}`);
});
```

with:

```js
}

function startServer(port = PORT, host = HOST) {
  const server = createAppServer();
  server.listen(port, host, () => {
    console.log(`parking api listening on http://${host}:${port}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createAppServer,
  startServer
};
```

- [ ] **Step 8: Remove signed upload token helper from `server/db.js`**

Delete the function `createEvidencePhotoUploadToken()` and remove it from `module.exports`.

- [ ] **Step 9: Run tests**

Run:

```bash
npm test
```

Expected: auth, route protection, multipart limit, upload, Supabase, and model-client tests pass.

### Task 6: Add Docker Compose and Caddy deployment assets

**Files:**
- Modify: `Dockerfile`
- Create: `compose.yaml`
- Create: `Caddyfile`
- Create: `.env.server.example`
- Modify: `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Replace `Dockerfile`**

Use this content:

```dockerfile
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY utils ./utils

USER node
EXPOSE 8787

CMD ["node", "server/index.js"]
```

- [ ] **Step 2: Create `compose.yaml`**

Use this content:

```yaml
services:
  api:
    build:
      context: .
    env_file:
      - .env.server
    environment:
      HOST: 0.0.0.0
      PORT: 8787
      NODE_ENV: production
    expose:
      - "8787"
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

  caddy:
    image: caddy:2-alpine
    depends_on:
      api:
        condition: service_healthy
    env_file:
      - .env.server
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    restart: unless-stopped

volumes:
  caddy_data:
  caddy_config:
```

- [ ] **Step 3: Create `Caddyfile`**

Use this content:

```caddyfile
{$API_SITE_ADDRESS} {
	encode zstd gzip

	log {
		output stdout
		format console
	}

	reverse_proxy api:8787
}
```

- [ ] **Step 4: Create `.env.server.example`**

Use this content:

```dotenv
API_SITE_ADDRESS=parking.kuaidianfanfan.com

HOST=0.0.0.0
PORT=8787
NODE_ENV=production

SUPABASE_URL=https://dnwmoojwvosyfnlgsfmk.supabase.co
SUPABASE_SERVICE_KEY=replace-with-supabase-service-role-key
SUPABASE_STORAGE_BUCKET=parking-evidence

WX_APPID=replace-with-wechat-mini-program-appid
WX_APP_SECRET=replace-with-wechat-mini-program-secret

AUTH_TOKEN_SECRET=replace-with-32-plus-byte-random-secret
AUTH_TOKEN_TTL_SECONDS=604800

SENSENOVA_BASE_URL=https://token.sensenova.cn
SENSENOVA_API_KEY=replace-with-sensenova-api-key
SENSENOVA_MODEL=sensenova-6.7-flash-lite
MODEL_API_MOCK=0
```

- [ ] **Step 5: Update `.env.example`**

Ensure it contains this production pointer:

```dotenv
# Local development values live here.
# Production Docker Compose uses .env.server, which must not be committed.
```

- [ ] **Step 6: Update `.gitignore`**

Ensure it contains:

```gitignore
.env.server
.worktrees/
```

- [ ] **Step 7: Validate Compose**

Run:

```bash
cp .env.server.example /tmp/mini-parking-env-server-test
docker compose --env-file /tmp/mini-parking-env-server-test config
```

Expected: Compose renders `api` and `caddy` services, ports `80:80` and `443:443`, and `API_SITE_ADDRESS=parking.kuaidianfanfan.com`.

### Task 7: Update documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-06-self-hosted-deployment-design.md`
- Modify: `README.md`
- Delete: `docs/cloudbase-run.md`
- Create: `docs/self-hosted-deployment.md`

- [ ] **Step 1: Update the design spec for the now-known domain**

In `docs/superpowers/specs/2026-07-06-self-hosted-deployment-design.md`, replace:

```markdown
No production domain is available yet.
```

with:

```markdown
The production API domain is `parking.kuaidianfanfan.com`.
```

Replace:

```markdown
The absence of a filed domain blocks Phase 2 release, but it does not block code migration or Phase 1 server verification.
```

with:

```markdown
Phase 2 release requires DNS for `parking.kuaidianfanfan.com`, valid HTTPS from Caddy, and WeChat legal-domain configuration before trial or production mini-program traffic is sent to the self-hosted API.
```

- [ ] **Step 2: Create `docs/self-hosted-deployment.md`**

Use a runbook with these exact sections and commands:

```markdown
# Self-hosted deployment runbook

## Target

- API domain: `parking.kuaidianfanfan.com`
- Server: `49.64.86.64`
- Runtime: Docker Compose with Caddy and Node.js
- Database and object storage: hosted Supabase

## Before deployment

1. Rotate the root password that was shared during planning.
2. Add an SSH key and verify key-based login.
3. Restrict SSH access where practical.
4. Point DNS `A` record `parking.kuaidianfanfan.com` to `49.64.86.64`.
5. Confirm ICP and WeChat mini-program domain requirements are satisfied for production use.

## Server files

Create `/opt/mini-parking/.env.server` from `.env.server.example` and fill real secrets on the server only.

## Deploy

```bash
cd /opt/mini-parking
docker compose --env-file .env.server up -d --build
docker compose ps
```

## Verify

```bash
curl -i http://parking.kuaidianfanfan.com/health
curl -i https://parking.kuaidianfanfan.com/health
docker compose logs --tail=100 api
docker compose logs --tail=100 caddy
```

Expected:

- HTTP redirects or serves through Caddy.
- HTTPS returns JSON with `"ok":true`.
- `api` is healthy.
- Caddy has a valid certificate for `parking.kuaidianfanfan.com`.

## WeChat mini program settings

Add `https://parking.kuaidianfanfan.com` to:

- request legal domain
- uploadFile legal domain

Keep the Supabase project host allowed for image loading if evidence photos are rendered from Supabase public URLs.

## Upgrade

```bash
cd /opt/mini-parking
git rev-parse HEAD
git pull --ff-only
docker compose --env-file .env.server up -d --build
docker compose ps
curl -fsS https://parking.kuaidianfanfan.com/health
```

## Rollback

```bash
cd /opt/mini-parking
git checkout <previous-good-commit>
docker compose --env-file .env.server up -d --build
curl -fsS https://parking.kuaidianfanfan.com/health
```
```

- [ ] **Step 3: Delete obsolete CloudBase runbook**

Run:

```bash
git rm docs/cloudbase-run.md
```

Expected: CloudBase deployment instructions are removed from active docs.

- [ ] **Step 4: Update `README.md`**

Add a deployment summary that says:

```markdown
## Deployment

Production API traffic is served from `https://parking.kuaidianfanfan.com`.

- Runtime: Docker Compose on the self-owned server
- HTTPS/reverse proxy: Caddy
- Database and evidence photos: hosted Supabase
- Deployment runbook: `docs/self-hosted-deployment.md`

Tencent CloudBase is no longer part of the production runtime.
```

- [ ] **Step 5: Search for obsolete CloudBase references**

Run:

```bash
rg -n "cloudbase|CloudBase|callContainer|wx\\.cloud|X-WX-SERVICE|upload-token|prod-d0g1zp7w0322a5d42|mini-parking-api" app.js config utils server README.md docs scripts
```

Expected: no matches in runtime files. Historical matches are allowed only inside the completed design/plan documents if they describe removed behavior.

## Verification and handoff

### Task 8: Full local verification

**Files:**
- Inspect: all modified files

- [ ] **Step 1: Run the test suite**

Run:

```bash
npm test
```

Expected: `all tests passed`.

- [ ] **Step 2: Run Compose validation**

Run:

```bash
cp .env.server.example /tmp/mini-parking-env-server-test
docker compose --env-file /tmp/mini-parking-env-server-test config
```

Expected: valid Compose output with `api`, `caddy`, `caddy_data`, and `caddy_config`.

- [ ] **Step 3: Build the production image**

Run:

```bash
docker compose --env-file /tmp/mini-parking-env-server-test build api
```

Expected: image builds successfully. If the build fails because dependency download is blocked by local network sandboxing, rerun with explicit network approval.

- [ ] **Step 4: Confirm no secrets were committed**

Run:

```bash
rg -n "SUPABASE_SERVICE_KEY=ey|AUTH_TOKEN_SECRET=[A-Za-z0-9+/=]{32,}|SENSENOVA_API_KEY=sk-|WX_APP_SECRET=[0-9a-fA-F]{32}" .
```

Expected: no matches for real production secrets. Also manually confirm the previously disclosed server password is not present in any tracked file.

- [ ] **Step 5: Review diff**

Run:

```bash
git diff -- app.js config/api.js utils/api.js server/auth.js server/index.js server/db.js Dockerfile compose.yaml Caddyfile .env.example .env.server.example .gitignore README.md docs/self-hosted-deployment.md docs/cloudbase-run.md scripts/run-tests.js docs/superpowers/specs/2026-07-06-self-hosted-deployment-design.md
```

Expected: diff only contains self-hosted migration changes and does not revert unrelated local edits.

### Task 9: Commit migration changes when approved

**Files:**
- Stage only migration files.

- [ ] **Step 1: Stage path-limited changes**

Run:

```bash
git add app.js config/api.js utils/api.js server/auth.js server/index.js server/db.js Dockerfile compose.yaml Caddyfile .env.example .env.server.example .gitignore README.md docs/self-hosted-deployment.md docs/cloudbase-run.md scripts/run-tests.js docs/superpowers/specs/2026-07-06-self-hosted-deployment-design.md docs/superpowers/plans/2026-07-07-self-hosted-deployment.md
```

Expected: only files related to the migration are staged. Pre-existing unrelated page/location edits remain untouched unless they overlap with the migration.

- [ ] **Step 2: Commit**

Run:

```bash
git commit -m "feat: support self-hosted deployment"
```

Expected: commit contains the self-hosted migration only.

- [ ] **Step 3: Provide deployment handoff**

Report:

```text
已完成代码迁移。下一步是在服务器上创建 /opt/mini-parking/.env.server，填入 Supabase/微信/模型密钥，确认 DNS 指向 49.64.86.64，然后执行 docker compose --env-file .env.server up -d --build。
```

## Self-review

- Spec coverage: the plan covers CloudBase removal, Supabase preservation, signed auth, authenticated recognition, upload consolidation, multipart limit, Docker/Caddy deployment, domain `parking.kuaidianfanfan.com`, docs, verification, and commit handoff.
- Placeholder scan: the plan contains no deferred implementation markers; all code-edit steps include concrete replacements or exact file contents.
- Type consistency: token helpers use `generateToken(openid, options)`, `decodeToken(token, options)`, and `extractOpenid(req, options)` consistently across tests and implementation; client config exports only `{ apiConfig }`; server exports `{ createAppServer, startServer }`.
