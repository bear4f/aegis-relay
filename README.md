# AegisRelay

AegisRelay 是一个原创的、隐私优先的 Emby 多服务器反向代理管理面板。它把冗长的上游地址收敛为短别名，例如：

```text
https://relay.example.com/r/home/<独立访问密钥>/
https://relay.example.com/r/family/<独立访问密钥>/
```

上游域名、端口和协议不会出现在客户端地址中。每条路由的密钥只显示一次，服务端仅保留带主密钥的 HMAC 摘要。

> 当前为安全预览版 `0.1.0`。请先在私有仓库和测试服务器中评估，不建议未经审阅直接暴露到公网。

## 设计来源与原创边界

本项目在获得用户授权的前提下，研究了以下公开项目的产品思路，但没有复制其源码、品牌、界面或素材：

- `bear4f/emby-proxy-toolbox`：部署友好、WebSocket/Range 支持、回滚和客户端兼容思路。
- `hkfires/EmbyProxy`：多节点、节点级密钥、TOTP 和轻量部署思路。
- `snnabb/Meridian`：单服务管理、诊断、双上游和安全文档思路。

AegisRelay 采用独立的 Node.js 标准库实现、加密 JSON 存储、分离的管理/代理监听器以及 capability URL 模型。

## 节点管理能力

- **短路径节点**：客户端使用 `/charity/<访问密钥>/`；旧版 `/r/charity/<访问密钥>/` 继续兼容。
- **可选访问密钥**：默认启用独立随机密钥；可显式改为仅别名访问，但会增加扫描与盗用风险。
- **多主线路**：最多配置 8 条，以分号或换行分隔。安全的 GET/HEAD 请求遇到网络错误或 502/503/504 时自动尝试下一线路；连续失败会指数退避熔断。
- **前后端分离**：播放线路可独立配置。`Videos`、`Audio`、`LiveTV` 和下载路径会走播放线路，其余 API/元数据走主线路。
- **302 策略**：直连模式把外链交给客户端，节省中转流量；隐私中转模式最多跟随 5 次重定向，跨站时会移除 Cookie、Authorization 和 Emby Token，避免凭据泄漏。
- **兼容性请求头**：管理员可设置通用 `User-Agent`、`X-Emby-Client`、设备名称和设备 ID，默认关闭且留有审计记录。
- **节点首页**：每个节点可选择是否在代理首页展示名称；带密钥节点不会公开密钥。
- **线路诊断**：管理面展示连续失败、熔断状态、重试时间和最近成功时间，不显示真实上游。

兼容性请求头只适用于你拥有或已获明确授权的 Emby 上游。AegisRelay 不内置第三方客户端冒充模板，也不应用于绕过上游禁止反代、客户端限制或其他访问控制。详见 [节点管理说明](docs/NODE_MANAGEMENT.md)。

## 安全默认值

- 管理端默认仅监听 `127.0.0.1:9080`，代理端监听 `0.0.0.0:8080`。
- 管理员必须使用至少 14 位密码和 TOTP；提供一次性恢复码。
- 密码使用高成本 `scrypt`，持久数据使用 AES-256-GCM 整体加密。
- 登录限速、30 分钟会话、HttpOnly + SameSite=Strict Cookie、CSRF Token。
- CSP、禁止 iframe、禁止 referrer、关闭缓存和 MIME sniffing。
- 默认拒绝私网、环回、链路本地和保留地址回源，降低 SSRF 风险。
- 不接受用户传入的 `X-Forwarded-For`，不把管理 Cookie 转发给上游。
- 路由访问密钥不会写入应用访问日志，审计日志会脱敏。
- Docker 默认无 root、只读文件系统、丢弃全部 capabilities、禁止提权。

详细边界见 [SECURITY.md](SECURITY.md) 与 [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)。

## 快速部署

要求：Docker、Docker Compose、OpenSSL。

```bash
./scripts/install.sh
```

安装器首次运行会生成三个独立随机值，并只显示一次 Setup Token 和随机管理路径。管理端仅发布到宿主机 `127.0.0.1:9080`。推荐用 SSH 隧道完成初始化：

```bash
ssh -L 9080:127.0.0.1:9080 user@server
```

然后访问 `http://127.0.0.1:9080/<随机管理路径>`。若仅通过本地 HTTP 初始化，可临时将 `.env` 中 `SECURE_COOKIES=false`，完成后恢复为 `true` 并置于 HTTPS 反代之后。

### 生产 HTTPS

管理端建议使用独立域名、mTLS/VPN/IP allowlist，并代理到 `127.0.0.1:9080`。代理端域名转发到 `127.0.0.1:8080`。Nginx 示例见 [deploy/nginx.example.conf](deploy/nginx.example.conf)。不要让 Nginx 记录包含访问密钥的完整 URI。

## 使用流程

1. 用 Setup Token 初始化管理员，立即保存 TOTP Secret 和恢复码。
2. 登录后填写显示名称、短别名和上游地址。
3. 根据节点类型填写主线路和可选播放线路；私网 Emby 必须显式选择“允许私网回源”。
4. 选择 302 直连或隐私中转策略，保存只显示一次的客户端路径并添加到 Emby 客户端。
5. 怀疑泄露时点击“轮换密钥”；旧路径立即失效。

## 本地开发与验证

只依赖 Node.js 20+，无第三方运行时包：

```bash
npm run check
npm test
```

## 备份

一致备份必须同时包含 `data/aegis.enc.json` 和 `.env` 中的 `APP_MASTER_KEY`，二者应分开加密保存。丢失主密钥无法恢复；泄露主密钥与数据文件则等同于数据泄露。

## License

MIT。Emby 是其权利人的商标，本项目与 Emby 官方无隶属关系。
