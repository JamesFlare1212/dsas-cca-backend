# DSAS CCA Backend

基于 Bun、Hono 和 Redis 的 Engage CCA 数据 API。保留 `/v1` 的活动、分类、学年和教职工接口，使用 [CloakHQ/cloakbrowser](https://github.com/CloakHQ/cloakbrowser) 登录，并将数据采集、缓存、图片处理与 HTTP 服务分离。

## 运行版本与架构

运行时固定为 Bun **1.4.3**；直接依赖使用精确版本并由 `bun.lock` 锁定，包括 CloakBrowser **0.6.3**、playwright-core **1.64.1**、Hono **4.13.13**、Zod **4.6.7**、ioredis **6.0.0**、Sharp **0.35.5**、Pino **10.4.0** 和 Pangu **10.4.1**。开发检查使用 TypeScript **7.0.2** 与 Biome **2.6.2**。

Compose 和 CI 固定使用 Redis **8.10.2-alpine3.23**。该版本已于 2026-10-21 对照 [Redis 稳定版发布 API](https://api.github.com/repos/redis/redis/releases/latest) 与 [Docker Official Images 标签清单](https://github.com/docker-library/official-images/blob/master/library/redis)核实。Bun 和 Redis 镜像还固定了 Docker Registry 返回的多架构索引摘要，避免同名标签变化。

请求通过 Hono 进入统一的 Catalog 服务；Catalog 负责缓存新鲜度、同一资源的并发请求合并、上游队列、限速和熔断。Engage 客户端负责超时、有限重试与认证恢复。后台调度器复用同一采集路径，通过可续租的 Redis 租约协调多个实例。活动详情、列表摘要和待刷新时间在 Redis 中原子更新，列表不再逐项读取完整详情或内嵌图片。

```text
src/http/         HTTP 路由、输入验证、CORS、响应头
src/services/     Catalog 缓存策略与后台调度
src/upstream/     Engage 请求、CloakBrowser 登录、Cookie 生命周期
src/storage/      Redis 记录、摘要、租约与可选 S3 图片存储
src/domain/       数据模型和归一化
src/core/         有界任务队列、错误、日志与指标
scripts/          浏览器安装/冒烟、手动登录、旧缓存导入
```

## 使用 Docker Compose

需要支持 Compose v2 的 Docker。首次配置：

```sh
cp example.env .env
```

编辑 `.env`，填写 `API_USERNAME`、`API_PASSWORD` 与 `REDIS_PASSWORD`。已有 `.env` 时请保留原文件，并对照 [example.env](example.env) 补全配置。
- 默认 `API_CREDENTIALS_URL_ENCODED=true`，兼容旧版已经通过 `encodeURIComponent` 分别编码的用户名和密码。若填写明文，设置 `API_CREDENTIALS_URL_ENCODED=false`。不要重复编码。
- Redis 密码必须非空。使用 URL 安全的随机值，例如通过 `openssl rand -hex 32` 生成的十六进制字符串，再填入 `.env`。Compose 将相同值传给 Redis 并拼接到应用的 `REDIS_URL`，因此这里不要使用含 `@`、`:`、`/`、`%` 或空白的密码。
- Compose 中 `PORT` 只决定宿主机端口，容器内固定监听 `0.0.0.0:3000`。例如 `.env` 的 `PORT=8080` 会映射为 `8080:3000`。

```sh
docker compose config --quiet
docker compose up --build --detach
docker compose ps
curl --fail http://127.0.0.1:3000/health/ready
docker compose logs --tail=100 app
```

若修改了宿主机端口，请同步调整上面的请求地址。

镜像通过 `bun install --frozen-lockfile --production` 安装生产依赖，按白名单复制源文件。构建时先执行 `bun node_modules/playwright-core/cli.js install-deps chromium` 安装系统库，再执行 `bun run browser:install` 下载 CloakBrowser。`ensureBinary` 对官方签名校验清单和下载内容进行验证；安装失败直接使构建失败。这里不会安装 Playwright 自带的 Chromium。

浏览器缓存在 `/opt/cloakbrowser`，归 `bun` 用户所有。镜像与 Compose 均设置 `CLOAKBROWSER_AUTO_UPDATE=false`，通过重新构建和发布镜像更新浏览器。默认免费二进制无需许可证。若另行使用授权版本，可以在运行环境提供 `CLOAKBROWSER_LICENSE_KEY`；相应的授权二进制缓存需另行准备，默认镜像仅预装免费版本。不要把授权密钥放进 Dockerfile 或构建参数。

应用使用镜像内的非 root `bun` 用户，`init: true` 转发进程信号，停止宽限期为 25 秒。启动脚本只执行 `bun src/index.ts`。应用先验证配置和 Redis 连接，再启动 HTTP，最后启动后台任务；启动不要求先完成 Engage 登录。默认启用的后台任务随后可能触发登录与采集。首次采集尚未完成时，列表可以为空，而 readiness 已正常。

持久化存储：

| 卷           | 容器路径            | 内容                              |
| ------------ | ------------------- | --------------------------------- |
| `app-data`   | `/usr/src/app/data` | 版本化 Cookie 文件 `cookies.json` |
| `redis-data` | `/data`             | Redis AOF/RDB；启用 AOF、每秒刷盘 |

新建的 `app-data` 卷继承镜像目录中 `bun` 用户的所有权。自定义 bind mount 时，需要预先保证同一用户可写。Redis 也以 `redis` 用户运行，仅供 Compose 内网使用，不发布宿主机端口。Compose 会覆盖 `.env` 中的 `HOST`、`PORT`、`DATA_DIR`、`REDIS_URL` 和浏览器缓存/自动更新设置，以保持容器配置一致。

`docker compose down` 保留命名卷；`docker compose down --volumes` 会删除持久化数据。备份或还原 Redis 时同时考虑 AOF 与 RDB，并保留对应的应用配置。不要用空目录覆盖镜像内的 `/opt/cloakbrowser`。

## 本地开发

安装 Bun 1.4.3，准备可访问的 Redis，并在 `.env` 中填写账户配置与 `REDIS_URL`。Compose 的 Redis 默认没有宿主机端口，因此本地 Bun 需要独立的本地 Redis，或自行配置开发环境的端口转发。

```sh
bun install --frozen-lockfile
# Linux 上需有安装系统包的权限；此步骤只安装 Chromium 的 OS 依赖。
bun node_modules/playwright-core/cli.js install-deps chromium
bun run browser:install
bun run browser:smoke
bun run dev
```

`bun run start` 或 `bun src/index.ts` 启动普通服务。Bun 自动读取 `.env`；本地 `DATA_DIR` 默认是 `./data`，浏览器使用 CloakBrowser 的默认用户缓存目录。浏览器冒烟只创建本地页面，不访问 Engage，也不需要账户配置。

手动获取或更新登录 Cookie：

```sh
bun run cookie:get
# 在 Compose 中使用同一个应用数据卷：
docker compose run --rm --no-deps app bun run cookie:get
```

手动登录会访问所配置的 Engage 站点。正常启动与常规测试不需要执行该命令。`SCHEDULER_ENABLED=false` 可以关闭后台采集；详情或教职工接口发生缓存未命中时仍会按需访问上游。

## HTTP 接口

所有下列数据接口均使用 `GET`，JSON 响应保持原有结构。每次请求都会生成 `X-Request-ID`。活动详情和教职工响应还提供 `X-Cache` 与 `X-Data-Updated-At`，其中更新时间对应数据实际抓取时间。CORS 允许前端读取这三个响应头。

### 活动列表

`GET /v1/activity/list` 返回以活动 ID 为键的对象；每项仅包含 `name` 和 `photo`。无图片时列表中的 `photo` 为 `""`。

```json
{
  "7095": { "name": "Science Club", "photo": "https://images.example.org/science.avif" },
  "7096": { "name": "Chess Club", "photo": "" }
}
```

支持组合筛选与可选分页：

| 参数           | 规则                                         |
| -------------- | -------------------------------------------- |
| `category`     | 已缓存的分类名称，长度 1–200                 |
| `academicYear` | 相邻年份组成的 `YYYY/YYYY`，例如 `2026/2027` |
| `grade`        | 整数 1–12，筛选包含该年级的活动              |
| `isStudentLed` | 字面量 `true` 或 `false`                     |
| `limit`        | 可选，整数 1–500；省略时不限制条数           |
| `offset`       | 可选，整数 0–999999，默认 0                  |

结果按活动 ID 的数值升序排列，`X-Total-Count` 返回分页前的匹配数量。重复参数或格式错误返回 400；不存在的分类、学年返回 400，并附带 `availableCategories` 或 `availableAcademicYears`。列表只读取 Redis 摘要，不会为了响应而遍历上游。

```sh
curl --get http://127.0.0.1:3000/v1/activity/list \
  --data-urlencode 'academicYear=2026/2027' \
  --data-urlencode 'grade=7' \
  --data-urlencode 'isStudentLed=true' \
  --data-urlencode 'limit=50' \
  --data-urlencode 'offset=0'
```

### 分类与学年

- `GET /v1/activity/category` 返回分类到数量的映射，例如 `{"Club":12,"Sport":8}`。
- `GET /v1/activity/academicYear` 返回学年到数量的映射，例如 `{"2026/2027":20}`。

两者基于已缓存摘要聚合，空缓存返回 `{}`。

### 活动详情与教职工

`GET /v1/activity/:activityId` 接受 1–9 位数字 ID。响应包含归一化后的完整活动字段，包括 `id`、`name`、`academicYear`、`category`、`description`、`photo`、`duration`、`grades`、`meeting`、`staff`、`staffForReports` 与 `studentLeaders`，并在同一层保留 `lastCheck` 和 `cache` 元数据。详情中的缺失标量使用 `null`，集合使用数组。活动不存在时返回 404，响应包含 `error`、`lastCheck`、`source: "api-fetch-empty"` 和 `cache`。

`GET /v1/staffs` 保留教职工 ID 到姓名的映射，元数据也放在同一层：

```json
{
  "1001": "Example Teacher",
  "lastCheck": "2026-10-21T12:00:00.000Z",
  "cache": "HIT"
}
```

`cache` 和 `X-Cache` 的语义：

| 值      | 行为                                                 |
| ------- | ---------------------------------------------------- |
| `HIT`   | 已有数据仍在新鲜期内；有效的活动不存在记录也可以命中 |
| `MISS`  | 无可用缓存，需要等待一次采集；同一资源的并发采集合并 |
| `STALE` | 立即返回旧的有效数据，并在后台刷新；刷新失败保留旧值 |

输入错误通常为 400，HTTP 限流为 429，Redis/上游暂不可用为 503，请求超时或取消为 504。错误响应使用 `error`，并视情况提供 `code`、`requestId`；日志与配置错误不会输出账户、Cookie 或 Redis URL 中的凭据。

认证恢复支持 401/403、登录重定向和登录页面。针对旧 Engage 会话过期时返回 500 的行为，客户端会先用同一 Cookie 做一次有超时、并发合并和冷却限制的会话检查；只有确认需要登录才刷新会话，普通 500 继续作为上游故障处理。

### 健康检查与指标

- `GET /health/live`：HTTP 进程存活，返回 `{"status":"ok"}`。
- `GET /health/ready`：验证 Redis；正常返回 `{"status":"ready"}`，不可用或正在关闭时返回 503。Docker HEALTHCHECK 使用此接口。它不验证 Engage 登录或数据是否已预热。
- `GET /metrics`：Prometheus 文本指标，包括 HTTP 请求、上游请求/失败、缓存命中、旧数据响应、后台任务与采集队列长度。若无需公开指标，可在反向代理中限制该路径的访问。

## 配置与缓存

[example.env](example.env) 列出全部应用配置及默认值；[src/config.ts](src/config.ts) 是校验规则的来源。数值参数会校验整数与上下界，布尔值使用 `true`/`false`。启动时检查扫描范围、S3 配置完整性和 Origin 格式；失败时仅报告字段名称。

主要调节项：

| 配置                                                           | 默认值             | 作用与范围                                        |
| -------------------------------------------------------------- | ------------------ | ------------------------------------------------- |
| `CONCURRENT_API_CALLS` / `MAX_PENDING_FETCHES`                 | `4` / `256`        | 并发 1–32；等待队列 1–10000                       |
| `CRAWLER_REQUESTS_PER_MINUTE`                                  | `120`              | 每分钟上游请求 0–60000；0 关闭限速                |
| `CRAWLER_REQUEST_TIMEOUT_MS` / `CRAWLER_MAX_RETRIES`           | `15000` / `2`      | 单次超时 100–120000 ms；额外重试 0–5 次           |
| `CRAWLER_RETRY_DELAY_MS`                                       | `1000`             | 重试基础延时 0–30000 ms                           |
| `MIN_ACTIVITY_ID_SCAN` / `MAX_ACTIVITY_ID_SCAN`                | `3000` / `8000`    | 包含两端；各为 0–999999999，差值不超过 100000     |
| `CLUB_UPDATE_INTERVAL_MINS` / `STAFF_UPDATE_INTERVAL_MINS`     | `360` / `360`      | 活动/教职工新鲜期，分别为 1–10080 分钟            |
| `CLUB_CHECK_INTERVAL_SECONDS` / `STAFF_CHECK_INTERVAL_SECONDS` | `60` / `60`        | 两次任务完成之间的检查间隔，分别为 1–3600 秒      |
| `DISCOVERY_INTERVAL_MINS`                                      | `360`              | 两轮发现任务完成之间的间隔，1–10080 分钟          |
| `ERROR_CACHE_TTL`                                              | `3600`             | 活动不存在结果的新鲜期，1–86400 秒                |
| `FAILED_FETCH_RETRY_SECONDS`                                   | `60`               | 失败采集重新排队的延时，1–3600 秒                 |
| `CIRCUIT_FAILURE_THRESHOLD` / `CIRCUIT_COOLDOWN_MS`            | `5` / `30000`      | 连续失败阈值 1–100；熔断冷却 1000–300000 ms       |
| `HTTP_REQUESTS_PER_MINUTE`                                     | `600`              | 按连接来源限流，0–600000；0 关闭                  |
| `HTTP_TIMEOUT_MS` / `SHUTDOWN_TIMEOUT_MS`                      | `120000` / `15000` | 请求等待 1000–180000 ms；关闭期限 1000–120000 ms  |
| `IMAGE_PROCESS_TIMEOUT_MS`                                     | `10000`            | 图片处理等待 100–60000 ms，超时回退且释放采集队列 |

若提高 `SHUTDOWN_TIMEOUT_MS`，应同步增加 Compose 的 `stop_grace_period`，保证容器有足够退出时间。`ALLOWED_ORIGINS` 使用逗号分隔的完整 Origin（无结尾斜线），或 `*`。

有效活动与教职工记录不设置 Redis 过期时间，以便上游故障时继续提供旧数据。`CLUB_UPDATE_INTERVAL_MINS` 与 `STAFF_UPDATE_INTERVAL_MINS` 控制新鲜度。扫描范围内的负记录持久保存，`ERROR_CACHE_TTL` 控制多久以后重新检查。范围外的临时查询若不存在，仅保存同等时长的可过期负缓存，不加入后台轮询；范围外的有效活动仍会持续刷新。旧的 `ACTIVITY_CACHE_TTL`、`STAFF_CACHE_TTL` 已有意移除，不再生效。

默认 `REDIS_KEY_PREFIX=dsas:v2`，对应以下键：

```text
dsas:v2:activities       hash：活动记录（含不存在结果）
dsas:v2:summaries        hash：有效活动的轻量摘要
dsas:v2:due              sorted set：下次刷新时间
dsas:v2:staff            hash：all 字段保存教职工记录
dsas:v2:lease:<name>     带所有权令牌和期限的任务租约
dsas:v2:missing:<id>     范围外临时查询的负缓存，按 ERROR_CACHE_TTL 过期
```

自定义前缀若不以 `:v2` 结尾，适配器自动追加 `:v2`；已经带版本的前缀不会重复追加。

图片处理等待超时后，接口采集会继续并保留旧照片或空照片。Bun 的原生 S3 API 暂不支持中断已开始的请求；这些请求会保持其图片并发名额直到实际结束，避免故障期间持续创建上传请求。

可选 S3：同时配置 `S3_BUCKET_NAME`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 后，将内嵌图片转换为 AVIF，并按原始内容哈希复用对象。`S3_ENDPOINT` 指定兼容服务，`S3_PUBLIC_URL` 指定公开服务根地址；两者都不应重复带 bucket。自定义公开地址使用 `<root>/<bucket>/<prefix>/avif-v1/<hash>.avif`；标准 AWS 地址按 bucket/region 生成。未配置 S3 时保留已有图片 URL，省略内嵌图片；图片处理失败会尽量保留上一张有效图片。输入字节数、像素数和转换并发分别由 `IMAGE_MAX_INPUT_BYTES`、`IMAGE_MAX_PIXELS`、`IMAGE_CONCURRENCY` 限制。

## 从旧版迁移

先备份 Redis 数据，保留旧 `.env`，确认连接的是包含旧键的 Redis。新版不自动读取旧的 `activity:*`、`staffs:all`，也不会自动搬运旧 `./redis_data` 目录。Compose 现在使用命名卷；若使用全新卷，应先还原旧 Redis 数据，或在原 Redis 上运行迁移工具。

使用相同 `REDIS_URL` 与目标 `REDIS_KEY_PREFIX`，停止采集后执行：

```sh
bun run cache:migrate
```

Compose 中可执行：

```sh
docker compose stop app
docker compose run --rm --no-deps app bun run cache:migrate
docker compose up --detach app
```

迁移导入旧的 `activity:*` 与 `staffs:all`，建立 v2 记录、摘要和刷新队列，保留旧键，并跳过已存在的 v2 数据。迁移工具不会复制 Redis 磁盘卷。迁移完成后，检查列表、详情和 readiness，再恢复正常采集。

旧 `services/cookies.json` 不会复制或自动导入。新版使用 `DATA_DIR/cookies.json`，内容包含格式版本和认证 Cookie，写入使用临时文件与原子替换。让应用按需重新登录，或手动执行 `bun run cookie:get`；保留原有 URL 编码凭据时无需改成明文。

## 测试与 CI

常规检查不需要账户、浏览器下载或真实 Engage；认证和上游请求使用模拟，Cookie 测试使用临时路径：

```sh
bun run check
```

这会依次执行 TypeScript、Biome 和单元测试。真实 Redis 集成测试需要显式启用，建议使用独立的临时实例：

```sh
RUN_REDIS_TESTS=1 TEST_REDIS_URL=redis://127.0.0.1:6379/0 bun run test:integration
```

集成测试使用随机键命名空间并清理自身数据。不要把测试配置指向生产 Redis。

真实 CloakBrowser 登录测试使用临时本地 Engage 页面和虚构凭据，验证并发登录合并、会话复用及过期重登：

```sh
bun run browser:install
bun run test:browser
```

并发合并、出站限速、熔断和 HTTP 限速均以进程为单位；后台任务租约通过 Redis 协调多个进程。出站限速包含请求重试与认证恢复后的重试。多副本部署应按副本数量分配出站预算，并确保账号允许独立会话。

CI 将检查、Redis/真实浏览器集成与容器浏览器冒烟分为三个任务。Redis 服务与 Compose 使用相同固定版本。容器任务构建生产镜像（包括系统依赖和经验证的 CloakBrowser），然后执行：

```sh
docker build --tag dsas-cca-backend:smoke .
docker run --rm --init --network none dsas-cca-backend:smoke bun run browser:smoke
```

浏览器冒烟在禁用网络的容器中渲染本地页面，不使用真实账户。镜像构建本身需要访问软件包仓库及官方浏览器下载源。GitHub Actions 固定到完整提交 SHA；Dependabot 每周检查 Bun 文本锁文件、Docker、Compose 和 Actions 更新。[GitHub 当前支持 Bun 的 `bun.lock`](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories#bun)。更新 Bun 时同时核对 `packageManager`、Dockerfile 与 CI 中的版本；更新 Redis 时同时核对 Compose 与 CI 服务镜像。
