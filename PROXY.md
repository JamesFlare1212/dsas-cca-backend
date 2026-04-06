# DSAS CCA Backend - Proxy Configuration

## 代理功能说明

本应用支持可选的代理配置，用于绕过网络限制访问 engage.nkcswx.cn。

## 使用 Cloudflare WARP 代理

### 1. 启动带代理的服务

```bash
# 启动包含 warp-proxy 的服务
docker compose --profile proxy up -d
```

### 2. 配置环境变量

在 `.env` 文件中设置：

```bash
# 启用代理
USE_PROXY=true

# 使用 warp-proxy 服务（默认配置，无需修改）
# 或者自定义代理服务器
ALL_PROXY=socks5://warp-proxy:9091
```

### 3. 验证代理工作

```bash
# 查看日志确认代理已启用
docker compose logs -f app | grep "Using proxy"
```

## 使用自定义代理服务器

### HTTP/HTTPS 代理

```bash
USE_PROXY=true
HTTP_PROXY=http://your-proxy:8080
HTTPS_PROXY=http://your-proxy:8080
```

### SOCKS5 代理

```bash
USE_PROXY=true
ALL_PROXY=socks5://your-proxy:1080
```

### 需要认证的代理

```bash
USE_PROXY=true
ALL_PROXY=socks5://username:password@your-proxy:1080
```

## 环境变量说明

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `USE_PROXY` | 是否启用代理 | `false` |
| `ALL_PROXY` | 通用代理服务器 | - |
| `HTTP_PROXY` | HTTP 代理服务器 | - |
| `HTTPS_PROXY` | HTTPS 代理服务器 | - |

## Warp Proxy 服务配置

### 启动 Warp 服务

```bash
# 单独启动 warp-proxy
docker compose --profile proxy up warp-proxy

# 查看所有服务（包括 warp-proxy）
docker compose --profile ps
```

### Warp 服务端口

- **内部端口**: 9091 (SOCKS5 + HTTP 混合模式)
- **访问方式**: `socks5://warp-proxy:9091`

### 自定义 Warp 配置

可以在 `docker-compose.yaml` 中添加环境变量：

```yaml
warp-proxy:
  image: ghcr.io/mon-ius/docker-warp-socks:v5
  environment:
    # 自定义 Warp 配置
    # WARP_MODE=premium  # 如果需要 premium 模式
```

## 故障排除

### 代理未生效

1. 检查 `USE_PROXY=true` 是否已设置
2. 确认 warp-proxy 服务正在运行：
   ```bash
   docker compose ps
   ```
3. 查看应用日志：
   ```bash
   docker compose logs app | grep proxy
   ```

### Warp 连接失败

1. 检查网络连接
2. 重启 warp-proxy 服务：
   ```bash
   docker compose --profile proxy restart warp-proxy
   ```
3. 查看 warp 日志：
   ```bash
   docker compose logs warp-proxy
   ```

### 性能问题

如果代理导致请求变慢：

1. 考虑关闭代理（如果不需要）：
   ```bash
   USE_PROXY=false
   ```
2. 或者使用更快的代理服务器

## 不启用代理的使用

默认情况下代理是关闭的。正常使用：

```bash
# 正常启动（不使用代理）
docker compose up -d

# 或者明确指定不使用代理
USE_PROXY=false docker compose up -d
```

## 注意事项

1. **首次启动**: 如果使用代理，首次启动可能会慢一些，因为需要建立 Warp 连接
2. **cookies 刷新**: 启用代理后，建议重新获取 cookies：
   ```bash
   docker exec dsas-cca-backend bun run test/get-cookies.ts
   ```
3. **网络要求**: Warp 需要访问 Cloudflare 服务器，确保网络可达

## 参考

- [Docker Warp Socks GitHub](https://github.com/Mon-ius/Docker-Warp-Socks)
- [Docker Hub](https://hub.docker.com/r/monius/docker-warp-socks)
