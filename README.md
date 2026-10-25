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

需要 Docker 25+ 和支持 Compose v2 的 Docker CLI。默认拉取 GitHub Container Registry（GHCR）的预构建镜像，并由 Watchtower 自动更新。首次配置：

```sh
cp example.env .env
```

编辑 `.env`，填写 `API_USERNAME`、`API_PASSWORD` 与 `REDIS_PASSWORD`。已有 `.env` 时请保留原文件，并对照 [example.env](example.env) 补全配置。
- 默认 `API_CREDENTIALS_URL_ENCODED=true`，兼容旧版已经通过 `encodeURIComponent` 分别编码的用户名和密码。若填写明文，设置 `API_CREDENTIALS_URL_ENCODED=false`。不要重复编码。
- Redis 密码必须非空。使用 URL 安全的随机值，例如通过 `openssl rand -hex 32` 生成的十六进制字符串，再填入 `.env`。Compose 将相同值传给 Redis 并拼接到应用的 `REDIS_URL`，因此这里不要使用含 `@`、`:`、`/`、`%` 或空白的密码。
- Compose 中 `PORT` 只决定宿主机端口，容器内固定监听 `0.0.0.0:3000`。例如 `.env` 的 `PORT=8080` 会映射为 `8080:3000`。

```sh
docker compose config --quiet
docker compose pull
docker compose up --detach
docker compose ps
curl --fail http://127.0.0.1:3000/health/ready
docker compose logs --tail=100 app
```

若修改了宿主机端口，请同步调整上面的请求地址。

### Watchtower 自动更新

Watchtower 检查的是容器镜像仓库中的标签，不直接拉取 GitHub 源码。更新链路为：GitHub 推送 → CI 测试和容器冒烟通过 → 发布同一份已验证镜像至 GHCR → Watchtower 检测摘要变化并重建 `app`。

默认 `APP_IMAGE=ghcr.io/jamesflare1212/dsas-cca-backend:latest` 跟随仓库默认分支 `master`。当前尚未合并的重写分支使用以下配置，首次启动前将它写入 `.env`：

```dotenv
APP_IMAGE=ghcr.io/jamesflare1212/dsas-cca-backend:rewrite-bun-cloakbrowser
WATCHTOWER_POLL_INTERVAL=300
WATCHTOWER_DOCKER_API_VERSION=1.44
```

CI 仅对原仓库默认分支与 `rewrite/bun-cloakbrowser` 的推送发布镜像，PR、fork、其他分支和手动运行不发布。每次发布还提供 `sha-<完整提交 SHA>` 标签用于回滚。默认分支发布 `latest`，重写分支仅更新 `rewrite-bun-cloakbrowser`。首次部署应先确认对应 CI 的 `publish` 任务完成，再执行 `docker compose pull`。

Watchtower 使用显式启用标签和 Compose 项目 scope，默认每 300 秒检查一次，只更新本项目的 `app`。Redis 与 Watchtower 自身均排除在自动更新之外。更新时最多等待 25 秒关闭应用，保留已有环境变量、端口与命名卷，并清理旧镜像。它需要挂载宿主机 Docker socket 才能重建容器；没有零停机或自动回滚保证。查看更新日志：

```sh
docker compose logs --tail=100 watchtower
```

Watchtower 会复用旧容器配置。修改 `.env` 或 Compose 后，需要手动执行 `docker compose up --detach` 使配置生效。暂停更新可执行 `docker compose stop watchtower`；恢复用 `docker compose up --detach watchtower`。

同一 Docker 主机已有其他 Watchtower 时，也应为其设置独立 scope；全局实例应使用 `--scope none`，以免清理其他 Watchtower 实例。[多实例配置](https://containrrr.dev/watchtower/running-multiple-instances/)说明了自身 scope 标签与全局实例的行为。

回滚时将 `APP_IMAGE` 改为已发布的 `ghcr.io/jamesflare1212/dsas-cca-backend:sha-<完整 SHA>`，再执行 `docker compose pull app` 和 `docker compose up --detach app`。固定 SHA 标签不会跟随新的分支发布。

按要求使用 [containrrr/watchtower](https://github.com/containrrr/watchtower) 的固定版本 `1.7.1` 与镜像摘要；该上游已归档。配置显式使用 Docker API `1.44`，以避免其旧版客户端默认 API 在新 Docker 上被拒绝。若宿主机 API 限制不同，根据 `docker version` 调整 `WATCHTOWER_DOCKER_API_VERSION`。[Watchtower 参数](https://containrrr.dev/watchtower/arguments/)、[Docker API 版本](https://docs.docker.com/reference/api/engine/)说明了这些配置。

### GHCR 访问权限

新建 GHCR 包可能默认为私有，即使源码仓库公开。首次发布后，可以在 [容器包设置](https://github.com/users/JamesFlare1212/packages/container/package/dsas-cca-backend)中将该包设为 Public，供服务器匿名拉取。此代码不会修改包可见性。

保留私有包时，使用具有 `read:packages` 权限的 GitHub 凭据在服务器终端登录，并将同一份独立 Docker 配置挂给 Watchtower：

```sh
mkdir -p .watchtower-auth
chmod 700 .watchtower-auth
docker --config ./.watchtower-auth login ghcr.io --username JamesFlare1212
docker --config ./.watchtower-auth compose -f docker-compose.yaml -f docker-compose.auth.yaml pull
docker --config ./.watchtower-auth compose -f docker-compose.yaml -f docker-compose.auth.yaml up --detach
```

登录命令交互式读取凭据，不要把 token 写入命令行参数、仓库或聊天。独立目录已加入 `.gitignore`，以只读目录挂载方式支持凭据文件更新；其 `config.json` 需要包含 GHCR 的 `auths`，不要依赖 Watchtower 镜像中不存在的宿主机 credential helper。[私有镜像认证](https://containrrr.dev/watchtower/private-registries/)说明了配置读取方式。

### 从源码构建

默认 Compose 不在服务器构建镜像。需要本地源码镜像时，使用独立项目与覆盖文件：

```sh
docker compose --project-name dsas-cca-local -f docker-compose.yaml -f docker-compose.build.yaml up --build --detach
```

此模式将 `app` 标记为不自动更新，Watchtower 默认不启动。端口仍由 `PORT` 决定，避免与已有部署占用同一端口。

发布镜像通过 `bun install --frozen-lockfile --production` 安装生产依赖，按白名单复制源文件。构建时先执行 `bun node_modules/playwright-core/cli.js install-deps chromium` 安装系统库，再执行 `bun run browser:install` 下载 CloakBrowser。`ensureBinary` 对官方签名校验清单和下载内容进行验证；安装失败直接使构建失败。这里不会安装 Playwright 自带的 Chromium。

浏览器缓存在 `/opt/cloakbrowser`，归 `bun` 用户所有。镜像与 Compose 均设置 `CLOAKBROWSER_AUTO_UPDATE=false`，通过重新构建和发布镜像更新浏览器。默认免费二进制无需许可证。若另行使用授权版本，可以在运行环境提供 `CLOAKBROWSER_LICENSE_KEY`；相应的授权二进制缓存需另行准备，默认镜像仅预装免费版本。不要把授权密钥放进 Dockerfile 或构建参数。

应用使用镜像内的非 root `bun` 用户，`init: true` 转发进程信号，停止宽限期为 25 秒。启动脚本只执行 `bun src/index.ts`。应用先验证配置和 Redis 连接，再启动 HTTP，最后启动后台任务；启动不要求先完成 Engage 登录。默认启用的后台任务随后可能触发登录与采集。首次采集尚未完成时，列表可以为空，而 readiness 已正常。

持久化存储：

| 卷           | 容器路径            | 内容                              |
| ------------ | ------------------- | --------------------------------- |
| `app-data`   | `/usr/src/app/data` | 版本化 Cookie 文件 `cookies.json` |
| `redis-data` | `/data`             | Redis AOF/RDB；启用 AOF、每秒刷盘 |

新建的 `app-data` 卷继承镜像目录中 `bun` 用户的所有权。自定义 bind mount 时，需要预先保证同一用户可写。Redis 也以 `redis` 用户运行，仅供 Compose 内网使用，不发布宿主机端口。Compose 会覆盖 `.env` 中的 `HOST`、`PORT`、`DATA_DIR`、`REDIS_URL` 和浏览器缓存/自动更新设置，以保持容器配置一致。

`docker compose down` 保留命名卷；`docker compose down --volumes` 会删除持久化数据。备份或还原 Redis 时同时考虑 AOF 与 RDB，并保留对应的应用配置。不要用空目录覆盖镜像内的 `/opt/cloakbrowser`。

## 使用 Coolify

[docker-compose.coolify.yaml](docker-compose.coolify.yaml) 是独立的 Coolify 配置。Coolify 拉取指定 Git 提交后，使用仓库根目录的 `Dockerfile` 构建应用镜像并部署，无需 GHCR 应用镜像或服务器上的 `.env` 文件。`pull_policy: build` 确保部署时执行构建，未变化的层仍可复用 Docker 缓存。应用和 Redis 的数据分别保存在命名卷中，保留浏览器共享内存、健康检查和 Redis 就绪依赖；更新由 Coolify 管理，不启动 Watchtower。
1. 在 Coolify 通过 GitHub App 或其他 Git 来源新建**仓库应用**，选择要跟踪的分支（例如 `master`）与 Docker Compose 构建方式。Base Directory 设为 `/`，Compose 文件位置设为 `/docker-compose.coolify.yaml`。使用普通 Compose 部署模式，保持 **Raw / deploy file as-is** 关闭。
2. 在 **Environment Variables** 填写 `API_USERNAME`、`API_PASSWORD`。此文件默认 `API_CREDENTIALS_URL_ENCODED=false`，直接填写明文；若沿用旧版分别 URL 编码的凭据，设置为 `true`。
3. Coolify 自动生成并复用 `SERVICE_PASSWORD_REDIS`，无需填写普通 Compose 使用的 `REDIS_PASSWORD`。如手动修改，使用仅含字母和数字的密码，保证拼接的 Redis URL 有效。
4. 在 `app` 的域名设置中确认或修改生成的域名，容器目标端口为 `3000`，例如 `https://api.example.com:3000`。外部访问使用 `https://api.example.com`，应用和 Redis 均不映射宿主机端口。
5. 在 **Advanced > Deployment > Auto deploy** 启用 **Deploy on push (webhooks)**（部分版本显示为 **Auto Deploy**）。通过 GitHub App 接入的仓库由集成接收推送事件；通过公开仓库 URL 或 deploy key 接入时，需将 Coolify **Webhooks > Manual Git Webhooks** 中对应 Git 提供方的 URL 和 secret 配置到仓库 webhook，并启用 push 事件。
6. 首次手动部署后，检查 `https://api.example.com/health/ready`，API 文档位于 `/v1/`。将新提交推送到所选分支后，在 Coolify 部署日志中确认对应提交触发了新的镜像构建和部署。仅在本地创建 commit 不会触发远程部署。

自动部署需要在 Coolify 和 Git 提供方完成上述事件配置，Compose 文件本身只定义构建与运行方式。请使用 Git 仓库应用，以便构建上下文包含 `Dockerfile` 和源代码。服务器构建时需要访问 Bun 镜像、依赖仓库和 CloakBrowser 下载源；Redis 仍拉取固定版本的官方镜像。

采集、限流、CORS 和 S3 等配置已显式声明，可直接在 Coolify 环境变量页面调整；S3 的 bucket 与两个访问凭据必须同时填写。此配置创建自己的持久化卷，不会自动导入已有 Compose 部署的数据。

域名、自动生成变量和 Compose 部署模式的行为参见 [Coolify Compose 文档](https://coolify.io/docs/applications/builds/docker-compose)；Git 推送触发配置参见 [自动部署](https://coolify.io/docs/applications/deployments/automatic-deployments)与[手动 Git Webhooks](https://coolify.io/docs/applications/deployments/manual-webhooks)。

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

访问 `GET /v1/` 查看交互式 HTML API 文档，包含接口、查询参数、响应示例、缓存与错误说明；`/v1` 自动跳转到 `/v1/`。在线调试支持选择接口、填写参数、预览 URL、复制 cURL、发送与取消真实请求，并展示状态码、耗时、响应头和格式化响应体（JSON 或文本）。请求发送到当前服务，遵循原有缓存与限流规则；详情与教职工请求可能触发上游采集。页面无需外部资源，打开文档本身不会触发数据采集或读取 Redis，只有点击发送才请求数据。

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

| 参数           | 规则                                           |
| -------------- | ---------------------------------------------- |
| `category`     | 已缓存的分类名称，长度 1–200                   |
| `academicYear` | 相邻年份组成的 `YYYY/YYYY`，例如 `2026/2027`   |
| `grade`        | 整数 -2–12；KG1=-2、KG2=-1、KG3=0，G1–G12=1–12 |
| `isStudentLed` | 字面量 `true` 或 `false`                       |
| `limit`        | 可选，整数 1–500；省略时不限制条数             |
| `offset`       | 可选，整数 0–999999，默认 0                    |

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

详情还提供 `descriptionZh` 和 `meetings`。`descriptionZh` 单独保留中文描述；`description` 优先使用英文，英文为空时回退到中文。`meetings` 按上游顺序保存每个时段的 `day`、`startTime`、`endTime`、`location` 和 `staff`，顶层 `staff` 是所有时段教职工的去重并集。旧 `meeting` 继续保留最后一个时段的取值。已有缓存缺少新增字段时，读取为 `null`/`[]`，下一次正常刷新后补齐；旧缓存不能还原此前未保存的时段。

识别规则优先使用字段 ID，并结合控件类型和相邻标签识别通用值控件，避免把正文中的标签词当成字段名。选择控件仅用本条响应中的 `lParms` 解析选项键；年级优先取日程中的明确范围，缺少范围时再使用显式年级控件和活动名称中的年级标记。破损范围或缺失的日程引用保持未知，不通过学年或其他活动猜填。扫描范围仍由 `MIN_ACTIVITY_ID_SCAN` / `MAX_ACTIVITY_ID_SCAN` 显式控制，需要覆盖期望采集的所有活动 ID。

`grades.min` / `grades.max` 保持数字字符串格式：KG1 为 `"-2"`、KG2 为 `"-1"`、KG3 为 `"0"`，一年级至十二年级为 `"1"`–`"12"`。例如 `KG2-KG3` 返回 `{"min":"-1","max":"0"}`，不再匹配 `grade=2` 或 `grade=3`。原有缓存中的旧年级值在下一次活动刷新后更新；部署不会清空缓存。

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

Engage 也会用 HTTP 200 返回业务错误：`d` 字符串解码后为 `isError: true`，`newRows` 中出现 `rID: "errorblock"`，错误控件 `fID: "error"` 的 `fData` 可为 `"Sequence contains no elements"`。该错误没有明确证明活动不存在，API 保持返回 503，不刷新有效 Cookie，也不将它缓存为 404。

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

这会依次执行 TypeScript、Biome、单元测试和全部离线 HTTP 语料回归。`tests/fixtures/engage-corpus/` 覆盖 ID 0–11000，输入与独立预期分别压缩保存；每个 ID 都验证传输分类、活动和教职工解析、缓存格式往返。上游业务错误和空白表单作为负例保留，不会丢弃后只测成功样本。

```sh
bun run test:corpus
bun run test:corpus:validation
```

验证分组按原始活动标题归组，近似 80/20 划分，同组不跨集合；这里是已观察活动的回归验证，不能当作未见数据泛化评估。预期结果由 `scripts/engage-corpus/oracle.ts` 直接读取源控件产生，不调用生产解析器；测试使用冻结预期，修改解析器不会自动改写答案。输入、预期和原始响应体均有 SHA-256 校验。格式化差异仅允许已有的空白、标点和名称排版规范。

比较时只对原始预期应用既定排版规则，再与解析输出逐项精确比较；正文词间空格、换行和标题括号的丢失会使测试失败。`bilingual` 仅统计原文同时具有英文和中文描述的活动，中文回退单独标为 `chinese-only`。有效活动中的新模板、改名模板或未审核的非空业务控件会阻止语料发布，避免解析器和预期同时忽略新增数据。

需要重新采集时，显式执行下列命令；它们会读取本地 `.env` 并访问真实 Engage，常规测试和 CI 不执行采集：

```sh
bun run corpus:capture
bun run test:corpus:raw
bun run corpus:build
```

原始响应保存在 Git 忽略的 `data/engage-corpus/raw/`，包含状态、响应头和未经改写的 Fetch 响应体字节；Fetch 可能已经解开传输/内容编码，因此它不是 TCP 抓包。原文可能包含个人信息或 Cookie，目录和文件使用私有权限。采集可从摘要校验通过的检查点续跑。切换采集目录可设置 `RAW_CORPUS_DIR`。

构建器先验证完整的 11001 个原文，再验证清洗副本，全部通过才发布测试集。清洗会替换人名、人员标识、自由描述和活动标题，标题中的年级/学生主导标记保留；图片换成有效的单像素 PNG，学生查找值和无关 UI 元数据去除，HTTP 头只保留重建后的安全字段。原文中的内容正确性先在私有目录验证；公开语料重点保留源控件结构及字段关系。原始教职工名称逐项检查，仅允许既有人工预期明确列出的历史纠正（以冻结摘要白名单保存）；清洗后的完整目录名称按伪名精确验证。稳定化种子仅存于原始目录，不能提交。

清洗会保留 `linkedPeriod`、地点、时间和对应选项键；构建时逐行比较这些源引用，防止把课节值替换成占位文本，或在匿名化时改变房间与时段的关系。

任何缺失、校验失败、未知响应或语义不一致都会写入 `data/engage-corpus/quarantine.json` 并阻止发布，不自动用解析器结果“更新预期”。请先检查对应原文及独立提取规则，确认修复后再构建。

真实 Redis 集成测试需要显式启用，建议使用独立的临时实例：

```sh
RUN_REDIS_TESTS=1 TEST_REDIS_URL=redis://127.0.0.1:6379/0 bun run test:integration
```

集成测试使用随机键命名空间并清理自身数据。不要把测试配置指向生产 Redis。

真实 CloakBrowser 测试使用临时本地 Engage 页面和虚构凭据，验证并发登录合并、会话复用及过期重登；同时验证交互文档的真实 HTTP 请求、参数编码、错误展示、取消恢复及移动端布局：

```sh
bun run browser:install
bun run test:browser
```

并发合并、出站限速、熔断和 HTTP 限速均以进程为单位；后台任务租约通过 Redis 协调多个进程。出站限速包含请求重试与认证恢复后的重试。多副本部署应按副本数量分配出站预算，并确保账号允许独立会话。

CI 包括检查、Redis/真实浏览器集成、容器浏览器冒烟，以及仅在前三项全部通过后执行的 GHCR 发布任务。发布会复用已冒烟验证的镜像，避免发布与验证时使用不同构建。Redis 服务与 Compose 使用相同固定版本。容器任务构建生产镜像（包括系统依赖和经验证的 CloakBrowser），然后执行：

```sh
docker build --tag dsas-cca-backend:smoke .
docker run --rm --init --network none dsas-cca-backend:smoke bun run browser:smoke
```

浏览器冒烟在禁用网络的容器中渲染本地页面，不使用真实账户。CI 还在真实 Docker daemon 上用临时容器验证 Watchtower 的应用更新、标签/scope 隔离，以及环境变量和 init 设置的保留；测试不会启动真实 Engage 采集。镜像构建本身需要访问软件包仓库及官方浏览器下载源。GitHub Actions 固定到完整提交 SHA；Dependabot 每周检查 Bun 文本锁文件、Docker、Compose 和 Actions 更新。[GitHub 当前支持 Bun 的 `bun.lock`](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories#bun)。更新 Bun 时同时核对 `packageManager`、Dockerfile 与 CI 中的版本；更新 Redis 时同时核对 Compose 与 CI 服务镜像。
