# 实现说明（对照开发文档 T0–T9）

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| T0 | 工程骨架、零依赖、.gitignore / .env.example | 完成 |
| T1 | 两种认证：API Key（Bearer）与 AK/SK（TC3），统一响应解析、错误码映射 | 完成，真实联调通过 |
| T2 | 连接管理：内存保存、测试即真实调用、A→B 自动检测、认证失败自动断开 | 完成 |
| T3 | 本地桥接服务：127.0.0.1、Host/Origin 校验、16KB 限制、并发 4、CSP、只记录 method/path/status | 完成 |
| T4 | OpenClaw 雷达：GitHub Releases，稳定/beta 分离，7/30/90 天统计，Changelog 分类，缓存与限流降级 | 完成 |
| T5 | 教程体检：输入解析、事实抽取、1 次搜索、保守结论、示例报告标注 | 完成 |
| T6 | 发现新教程：Freshness / Site 筛选、CSDN 专区、URL 去重、日期排序 | 完成 |
| T7 | UI：按设计稿 5 屏实现，桌面一屏、手机底部导航 | 完成（截图见 docs/screenshots） |
| T8 | 测试：52 项单元/服务端测试 + 7 项真实联调 | 完成 |
| T9 | 发布 GitHub / Pages | 仅准备（scripts/publish.sh），等待确认 |

## 已知限制
- 元宝搜索不支持浏览器 CORS，Pages 版不能直接搜索。
- 链接模式不抓取全文；非 OpenClaw 工具只能给出基于搜索的判断。
- 搜索结果中可能出现第三方 OpenClaw 镜像站，界面按真实域名展示。
- 接口不返回剩余额度，界面只提供到腾讯云控制台的链接。
