# CodeFresh 元宝搜索中转服务（relay）

GitHub Pages 上的 CodeFresh 是纯静态网页。元宝搜索（WSA）接口不返回 CORS 头，浏览器无法直接调用，所以线上版需要一个很小的中转服务：

```
浏览器（lucianaib2004.github.io）──HTTPS──> nginx ──> relay (127.0.0.1:8787) ──HTTPS──> 腾讯云元宝搜索
```

- **零依赖**，Node.js ≥ 18，直接复用仓库里 `src/providers/` 的请求构造、TC3-HMAC-SHA256 签名与响应解析。
- 上游只允许两个官方域名：`api.wsa.cloud.tencent.com/SearchPro`（服务 API Key）和 `wsa.tencentcloudapi.com`（SecretId/SecretKey）。不做任意 URL 代理。
- 请求体只保留 `Query` / `Site` / `Freshness`，其余字段丢弃。
- **不保存、不记录**密钥和请求内容：日志只有「时间 方法 路径 状态码 耗时」，不记录 IP、搜索词、请求体或请求头。
- CORS 只放行 `ALLOWED_ORIGINS`；没有 Origin 的请求只能访问 `GET /health`。
- 每 IP 限流（默认 20 次/分钟）、请求体 ≤ 16KB、上游超时 15 秒。

## 接口

| 方法 | 路径 | 请求体 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | — | 健康检查 |
| POST | `/api/wsa/search` | `{ "apiKey": "...", "body": { "Query": "...", "Site"?: "...", "Freshness"?: "d30" } }` | 服务 API Key（Bearer） |
| POST | `/api/wsa/tc3` | `{ "secretId": "...", "secretKey": "...", "body": { ... } }` | 服务端做 TC3 签名 |

返回结构与本地模式 `/api/search` 一致：成功 `{ ok: true, provider, requestId, items: [...] }`，失败 `{ ok: false, code, message, requestId }`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 只监听本机，由 nginx 对外提供 HTTPS |
| `ALLOWED_ORIGINS` | `https://lucianaib2004.github.io,http://127.0.0.1:4173` | 逗号分隔的允许来源 |
| `TRUST_PROXY` | 空 | 设为 `1` 时用 nginx 传来的 `X-Real-IP` 做限流 |
| `RATE_LIMIT_PER_MIN` | `20` | 每 IP 每分钟最多请求数 |
| `UPSTREAM_TIMEOUT_MS` | `15000` | 上游超时 |
| `RELAY_QUIET` | 空 | 设为 `1` 关闭访问日志 |

## 本机运行

```bash
node relay/server.mjs                   # 在仓库根目录执行
curl http://127.0.0.1:8787/health
```

## 部署到 Linux 服务器（systemd + nginx）

```bash
# 1. 安装 Node.js 20（以 Debian/Ubuntu 为例）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs

# 2. 拉代码到 /opt/codefresh，建一个没有登录权限的用户
sudo useradd --system --no-create-home --shell /usr/sbin/nologin codefresh
sudo git clone https://github.com/LucianaiB2004/codefresh.git /opt/codefresh
sudo chown -R root:root /opt/codefresh

# 3. 安装 systemd 服务
sudo cp /opt/codefresh/relay/deploy/codefresh-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now codefresh-relay
curl http://127.0.0.1:8787/health

# 4. nginx：把 relay/deploy/nginx-codefresh-relay.conf 的 location 放进已配好 HTTPS 的 server 块
sudo nginx -t && sudo systemctl reload nginx
curl https://你的域名/codefresh-relay/health
```

更新：`cd /opt/codefresh && sudo git pull && sudo systemctl restart codefresh-relay`。

## 让 GitHub Pages 用上中转

```bash
CODEFRESH_RELAY_URL=https://你的域名/codefresh-relay npm run build:pages
# 然后把 dist/ 发布到 gh-pages 分支
```

`CODEFRESH_RELAY_URL` 为空时，构建出的仍是只读预览版（与之前一样）。

## 测试

```bash
npm test     # 含 tests/relay.test.mjs，上游全部用 mock，不消耗额度
```
