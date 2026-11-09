# CodeFresh · 教程保质期（AI 知识保鲜站）

> 你收藏的教程，还能用吗？CodeFresh 用 **元宝搜索（腾讯云 SearchPro）** 实时检索公开资料，以 **GitHub 官方 Release** 为准，告诉你一篇 AI 工具教程是「仍可参考 / 建议复核 / 有明确过期证据 / 证据不足」。

![教程体检（真实数据）](docs/screenshots/01-desktop-check-real.webp)

## 功能

| 模块 | 说明 | 数据来源 |
| --- | --- | --- |
| 教程体检 | 粘贴链接或教程正文（版本号、安装命令），给出结论、版本对比和证据 | GitHub Release / Changelog + 元宝搜索 1 次 |
| 版本雷达 | 追踪 `openclaw/openclaw`，稳定版与 beta 分开，7/30/90 天发布统计、Changelog 影响分类、发布时间线 | GitHub API（15 分钟缓存） |
| 发现新教程 | 关键词 + 时效（近 7/30 天）+ 官方文档 / 入门教程筛选，可开「CSDN 专区」（`Site=blog.csdn.net`） | 元宝搜索 |
| API 设置 | 两种认证任选：**服务 API Key**（推荐）或 **腾讯云 SecretId + SecretKey**（TC3-HMAC-SHA256），支持自动检测 A→B | — |

截图：[版本雷达](docs/screenshots/02-desktop-radar.webp) · [发现新教程](docs/screenshots/03-desktop-explore-real-csdn.webp) · [使用指南](docs/screenshots/04-desktop-guide.webp) · [API 设置](docs/screenshots/05-desktop-settings-connected.webp) · [手机 390px](docs/screenshots/09-mobile-390-check.webp)

## 快速开始（本地完整模式，推荐）

需要 Node.js ≥ 20.6，零依赖。

```bash
npm start            # http://127.0.0.1:4173
```

打开页面 → 左下角「API 设置」→ 任选一种方式填入密钥 →「测试并使用」。测试会真实发起 1 次最小搜索，只有成功才显示「已连接」。

- 密钥只保存在当前页面内存里，刷新即清空；不写 localStorage / Cookie / URL / 日志。
- 本地服务只监听 `127.0.0.1`，校验 Host/Origin，签名在本机完成，密钥不会发给除腾讯云以外的任何地方。
- 可选：把密钥写进被 git 忽略的 `.env`（参考 `.env.example`），并设置 `CODEFRESH_ALLOW_ENV_CREDENTIALS=1`，界面上会出现「使用本机环境变量」按钮。**不要把 `.env` 提交到仓库。**

### 两种认证

| | 方式 A：服务 API Key | 方式 B：腾讯云标准密钥 |
| --- | --- | --- |
| 地址 | `POST https://api.wsa.cloud.tencent.com/SearchPro` | `https://wsa.tencentcloudapi.com`，Action `SearchPro`，Version `2025-05-08` |
| 鉴权 | `Authorization: Bearer <API Key>` | TC3-HMAC-SHA256（service `wsa`，不带 Region） |
| 获取 | [如何获取服务 API Key](https://cloud.tencent.com/document/product/1806/130615) | [访问管理 · API 密钥](https://console.cloud.tencent.com/cam/capi) |

两种方式返回结构一致（`Response.Pages` 为 JSON 字符串数组）；HTTP 200 时也会检查 `Response.Error`。

## GitHub Pages 预览模式 vs 本地完整模式

**实测结论：元宝搜索接口不支持浏览器跨域直连。** 以 `Origin: https://lucianaib2004.github.io` 发起 CORS 预检（OPTIONS）返回 HTTP 403，且无 `Access-Control-Allow-Origin`；实际 POST 的响应同样没有该头。因此：

- **Pages 预览**（`npm run build:pages` → `dist/`）：可看完整 UI、实时 GitHub 版本数据（`api.github.com` 支持 CORS）、基于 GitHub Release 的版本对比体检、示例报告（明确标注「示例数据」）。元宝搜索相关功能会提示「需本地运行」，不会假装连接成功。
- **本地完整模式**：全部功能可用。

## 诚实原则

- 不伪造版本号、热度、阅读量或剩余额度；没有日期就显示「日期未知」。
- 「CSDN」标签只给 URL 真正来自 csdn.net 的结果；CSDN 卡片在未检索时是「主题入口」，不是预置结果。
- 示例报告（38%）始终标注「示例」。
- 「有明确过期证据」只在 Changelog 中有与教程命令直接相关的移除/废弃/改名条目时给出；非 OpenClaw 工具最多给「建议复核」。
- 链接模式不抓取原文全文，只用搜索索引定位标题/日期，并在报告里说明。

## 测试

```bash
npm test                       # node:test，52 项，覆盖解析、签名、两种认证、错误码、雷达、体检、发现、服务端安全
node --env-file=<你的密钥文件> scripts/integration.mjs   # 真实联调（会消耗少量搜索次数，只打印状态码与 RequestId 前缀）
npm run scan:secrets           # 扫描将要提交的文件和 dist/ 是否含密钥
```

TC3 签名已用腾讯云官方文档示例逐项比对（payload hash、canonical request hash 一致）。

## 发布

`scripts/publish.sh` 只做「测试 → 构建 → 密钥扫描 → 打印发布命令」，**不会自动推送或部署**，需要仓库主人确认后手动执行。

## 目录

```
server/      本地服务（静态文件 + /api/*，仅 127.0.0.1）
src/         业务模块：providers（两种认证、请求、响应解析）、credentials、openclaw、tutorial-check、tutorial-discover
public/      前端（原生 HTML/CSS/JS + 像素风素材）
scripts/     build-pages / scan-secrets / integration / publish.sh
tests/       node:test 单元与服务端测试
```

## 声明

本项目为「元宝搜索开发者征文大赛」参赛原型（阶段：可演示原型）。「元宝」「腾讯云」「CSDN」「OpenClaw」等名称与标识归各自权利人所有，本项目与其无隶属关系，仅用于标注数据来源。开发过程中使用了 AI 辅助编码。

MIT License
