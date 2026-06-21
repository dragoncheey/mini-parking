# CloudBase 云托管部署

这套部署方式用于把本项目的 Node 后端部署到腾讯云 CloudBase 云托管，小程序端通过 `wx.cloud.callContainer` 调用，不需要在小程序代码里暴露模型密钥。

## 1. 创建云开发环境

1. 进入微信开发者工具或腾讯云 CloudBase 控制台。
2. 创建云开发环境，记下环境 ID，例如 `prod-xxxx`。
3. 开通云托管能力。

## 2. 创建云托管服务

建议服务名使用：

```text
mini-parking-api
```

构建方式选择从代码构建，根目录使用本项目根目录。云托管会读取根目录的 `Dockerfile`，容器对外监听 `80` 端口。

需要在云托管服务环境变量里配置：

```text
SUPABASE_URL=你的 Supabase Project URL
SUPABASE_SERVICE_KEY=你的 Supabase service_role key
SUPABASE_STORAGE_BUCKET=parking-evidence
SENSENOVA_API_KEY=你的模型密钥
SENSENOVA_BASE_URL=https://token.sensenova.cn
SENSENOVA_MODEL=sensenova-6.7-flash-lite
MODEL_API_MOCK=0
HOST=0.0.0.0
PORT=80
```

如果要使用真实微信登录，再补充：

```text
WX_APPID=你的小程序 AppID
WX_APP_SECRET=你的小程序 AppSecret
```

未配置微信密钥时，后端会把 `wx.login` 返回的 `code` 当作本地 mock openid，适合开发联调，不适合作为正式登录身份。

没有模型密钥时，可以先保留：

```text
MODEL_API_MOCK=1
```

这样录入页识别会返回本地模拟结果，方便先打通小程序到云托管的链路。

Supabase 需要先执行 `server/migration.sql` 建表。图片证据会上传到 Supabase Storage，默认 bucket 为 `parking-evidence`；服务端会用 service role 自动创建公开 bucket，也可以在 Supabase 控制台提前创建。

云端图片上传不是把大图 base64 发进云托管。小程序会先调用云托管 `/api/upload-token` 获取 Supabase Storage signed upload URL，再用 `wx.request` PUT 直传 Supabase。这样可以避开 `cloud.callContainer -606001` 这类大请求网关错误。微信公众平台后台需要把 Supabase 项目域名加入 request 合法域名，例如：

```text
https://dnwmoojwvosyfnlgsfmk.supabase.co
```

如需示例数据，可在本地或一次性任务中设置同样的 Supabase 环境变量后执行：

```bash
node server/seed.js
```

## 3. 配置小程序调用云托管

编辑 `config/api.js`：

```js
const cloudbaseConfig = {
  enabled: true,
  envId: "你的云开发环境 ID",
  serviceName: "mini-parking-api",
  recognitionPath: "/api/recognize-parking",
  supabaseUrl: "你的 Supabase Project URL"
};
```

本地开发时把 `enabled` 改回 `false`，小程序会继续请求 `http://127.0.0.1:8787`。`enabled: true` 时，登录、停车场、车辆、投票、上传凭证和识别接口都会通过 `wx.cloud.callContainer` 进入云托管，并携带 `X-WX-SERVICE: mini-parking-api`；图片文件本体会通过 signed URL 直传 Supabase。

## 4. 验证

云托管部署完成后，在云托管控制台访问服务根路径或 `/health`，应该看到：

```json
{
  "ok": true,
  "service": "mini-parking-api",
  "routes": [
    "/health",
    "/api/recognize-parking",
    "/api/login",
    "/api/parking-lots",
    "/api/parking-lots/:id",
    "/api/parking-lots/:id/vote",
    "/api/vehicles",
    "/api/vehicles/:id",
    "/api/upload"
  ]
}
```

然后在微信开发者工具里重新编译小程序，建议按下面路径验收：

1. 首页登录，确认 `POST /api/login` 成功。
2. 选择目的地，确认 `GET /api/parking-lots` 返回 Supabase 数据并能在地图上展示。
3. 进入“车辆管理”，新增、设置当前车辆、删除车辆。
4. 进入“录入停车场”，拍照上传、点击识别、保存停车场。
5. 进入详情页，点赞/踩并确认可信度变化。

## 5. 本地开发

本地运行时后端会自动读取项目根目录 `.env`，不需要手动 `export`。示例：

```bash
cp .env.example .env
# 编辑 .env，补齐 SUPABASE_URL / SUPABASE_SERVICE_KEY
npm run dev:api
```

如果 `MODEL_API_MOCK=1`，识别接口会返回模拟结果；如果 `WX_APPID` / `WX_APP_SECRET` 未配置，登录接口会使用开发 mock openid。
