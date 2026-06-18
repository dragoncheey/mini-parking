# 省心停车微信小程序

一个原生微信小程序 MVP。用户登录后输入或选择目的地，系统在目的地 3 公里内，根据预计停车时长、费用规则、步行距离、车位情况和数据可信度，推荐更合适的停车场。

## 已实现

- 按预计停车时长计算费用，支持免费时长、计费单位、单日封顶和阶梯计费。
- 用户可通过 `wx.login` 建立登录态，后续可接后端换取 openid/session。
- 通过微信地图选点或当前位置设置目的地，并只推荐目的地 3 公里内的停车场。
- 首页使用微信内嵌 `map` 组件展示目的地和候选停车场 marker。
- 综合推荐不只按价格排序，会叠加步行距离、车位紧张度、数据新鲜度和可信度。
- 支持手动录入/用户分享停车场数据，数据通过线上 API 持久化到 Supabase。
- 登录用户才允许上报停车场；停车场会展示上报用户头像/昵称作为数据来源。
- 支持车辆管理，可录入新能源小型车和燃油小型车车牌，并选择当前车辆。
- 推荐和详情页会按当前车辆类型计算费用；未设置车辆时按停车场默认规则计费。
- 只有上报人可以维护自己提交的停车场，修改后可信度重置并清空旧的点赞/踩评价。
- 其他登录用户可以对停车场信息点赞或踩，影响可信度并参与推荐排序。
- 录入页支持拍照/上传收费牌或入口照片，并结合定位保存可复核的数据证据。
- 录入页可调用本地识别 API，把拍照证据和定位字段交给模型识别，自动回填收费字段。
- 保存经纬度、入口备注和可选高德 POI；不强依赖高德地图。
- 详情页展示现场图片；需要导航时弹出微信位置页、已配置地图小程序和复制坐标等选项。
- Node 后端提供登录、停车场、车辆、投票、图片上传和识别接口；数据持久化使用 Supabase。

## 导入方式

1. 用微信开发者工具导入本目录。
2. 首次导入时把 `project.config.json` 里的 `appid` 换成你的小程序 AppID。
3. 在微信后台配置定位、地图选点、拍照/相册相关隐私说明。
4. 首页点击账号胶囊登录，输入目的地名称后点击“匹配目的地”选择本地候选；也可以点“选地点”打开微信地图选点，或直接用当前位置作为目的地。

## 本地测试

```bash
npm test
```

测试覆盖：

- 停车费用计算，包括免费时长、半小时计费和阶梯计费。
- 目的地 3 公里范围过滤和综合推荐排序。
- 识别结果 JSON 解析、归一化和本地 mock 识别。
- 线上 API 请求封装、停车场/车辆数据归一化和当前车辆 ID 会话选择。

## 后端 API

本地启动 Node 后端：

```bash
cp .env.example .env
# 编辑 .env，至少补齐 SUPABASE_URL 和 SUPABASE_SERVICE_KEY
npm run dev:api
```

服务会自动读取项目根目录的 `.env`，已存在的系统环境变量优先级更高。小程序端本地默认请求 `http://127.0.0.1:8787`，配置在 `config/api.js`。

主要接口：

- `GET /health`：健康检查。
- `POST /api/login`：微信登录；未配置 `WX_APPID` / `WX_APP_SECRET` 时使用 `code` 作为本地 mock openid。
- `GET /api/parking-lots`、`GET /api/parking-lots/:id`：停车场列表和详情。
- `POST /api/parking-lots`、`PUT /api/parking-lots/:id`：上报和维护停车场。
- `POST /api/parking-lots/:id/vote`：点赞/踩。
- `GET /api/vehicles`、`POST /api/vehicles`、`DELETE /api/vehicles/:id`：车辆管理。
- `POST /api/upload`：图片上传；本地支持 `wx.uploadFile`，云托管模式支持 JSON/base64 上传。
- `POST /api/recognize-parking`：停车场照片和文本识别。

数据库表结构在 `server/migration.sql`，执行后可用 `node server/seed.js` 导入示例停车场。

没有配置模型环境变量时，服务会使用 mock 识别，方便先测试端到端流程。要启用模型识别，在 `.env` 中设置：

```bash
SENSENOVA_API_KEY=你的模型密钥
SENSENOVA_BASE_URL=https://token.sensenova.cn
SENSENOVA_MODEL=sensenova-6.7-flash-lite
MODEL_API_MOCK=0
```

不要把模型密钥写进小程序代码或提交到仓库。小程序包会下发到用户设备，密钥必须只存在服务端环境变量里。

当前识别默认使用支持图片输入的 `sensenova-6.7-flash-lite`，通过 SenseNova OpenAI 兼容接口 `POST https://token.sensenova.cn/v1/chat/completions` 调用。服务端会把小程序上传的照片 base64 转为 `image_url` data URL，多张图片会和文本提示一起发送给模型。

## CloudBase 云托管

项目根目录已加入 `Dockerfile`，可把当前 Node 后端部署为 CloudBase 云托管服务。推荐服务名：

```text
mini-parking-api
```

上线后编辑 `config/api.js`，把 `cloudbaseConfig.enabled` 改为 `true`，并填入云开发环境 ID：

```js
const cloudbaseConfig = {
  enabled: true,
  envId: "你的云开发环境 ID",
  serviceName: "mini-parking-api",
  recognitionPath: "/api/recognize-parking"
};
```

小程序端会通过 `wx.cloud.callContainer` 访问云托管，并带上 `X-WX-SERVICE` 服务名。更完整的部署步骤见 `docs/cloudbase-run.md`。

`cloudbaseConfig.enabled` 打开后，登录、停车场、车辆、投票、JSON/base64 图片上传和识别都会走同一个云托管容器。本地开发时保持 `enabled: false` 即可继续使用 `wx.request` / `wx.uploadFile` 请求本地 `127.0.0.1:8787`。

## 数据模型

示例数据在 `data/seedParking.js`，可通过 `node server/seed.js` 导入 Supabase。小程序运行时不再读取本地示例或离线缓存，停车场、车辆、投票和维护都只通过后端 API 读写：

- `pricing.freeMinutes`：免费分钟数。
- `pricing.billingUnitMinutes` / `pricing.unitPrice`：计费单位和单价。
- `pricing.ladder`：阶梯计费。
- `pricing.pricingByVehicle.new_energy` / `pricing.pricingByVehicle.fuel`：按车型覆盖默认收费规则；未填写的字段会继承默认规则。
- `availability`：`high`、`medium`、`low`、`unknown`。
- `evidence.photos`：拍照/上传的收费牌或入口证据。
- `evidence.recognitionStatus`：识别/复核状态。
- `evidence.recognitionWarnings`：模型或 mock 识别给出的复核提示。
- `ownerId` / `owner`：上报用户信息，用于展示头像来源和判断维护权限。
- `confidence`：基础可信度；用户点赞/踩会动态调整展示可信度。
- `confidenceResetAt`：上报人维护后记录重置时间，同时清空该停车场旧评价。
- `location.amap.poiId`：高德 POI ID，用于保留第三方地图数据。

核心计算在 `utils/pricing.js` 和 `utils/recommendation.js`。

## 车辆与车型计费

车辆管理页目前只支持小型车辆，类型为：

- `new_energy`：新能源小型车。
- `fuel`：燃油小型车。

停车场录入页默认收费规则等同燃油车/基础规则；开启“新能源小型车优惠”后，可以只填写新能源免费分钟。例如常州市新能源 2 小时免费，可填 `120`，计费单位和单价留空，系统会在 2 小时后继承停车场默认计费规则。

## 第三方地图跳转

微信小程序不能任意拉起手机里的第三方原生 App。当前代码会弹出导航选项：默认可用“微信位置页”和“复制坐标”；在 `config/map.js` 填入地图小程序配置后，会额外出现高德/百度入口。

- `amapMiniProgram.enabled` / `baiduMiniProgram.enabled`：改为 `true` 后展示对应入口。
- `appId`：填写目标地图小程序 AppID。
- `buildPath`：按目标小程序要求拼接路径，当前会带上名称、地址、经纬度和高德 POI。

如果没有第三方地图小程序 AppID/路径，默认会使用 `wx.openLocation`，由微信位置页承接导航能力；失败时复制地址、坐标和高德 POI。
