# AegisRelay

AegisRelay 是一个原创的、隐私优先的 Emby 多服务器反向代理管理面板。它把冗长的上游地址收敛为短别名，例如：

```text
https://relay.example.com/r/home/<独立访问密钥>/
https://relay.example.com/r/family/<独立访问密钥>/
```

上游域名、端口和协议不会出现在客户端地址中。管理员登录后可以随时查看和复制完整客户端地址；连接密码与其他配置一起保存在 AES-256-GCM 加密的数据文件中，代理校验仍使用 HMAC 摘要。

> 当前为安全预览版 `0.3.2`。首次部署建议先在测试域名验证，再承载正式节点。

## 设计来源与原创边界

本项目在获得用户授权的前提下，研究了以下公开项目的产品思路，但没有复制其源码、品牌、界面或素材：

- `bear4f/emby-proxy-toolbox`：部署友好、WebSocket/Range 支持、回滚和客户端兼容思路。
- `hkfires/EmbyProxy`：多节点、节点级密钥、TOTP 和轻量部署思路。
- `snnabb/Meridian`：单服务管理、诊断、双上游和安全文档思路。

AegisRelay 采用独立的 Node.js 标准库实现、加密 JSON 存储、分离的管理/代理监听器以及 capability URL 模型。

## 节点管理能力

- **短路径节点**：客户端使用 `/charity/<访问密钥>/`；旧版 `/r/charity/<访问密钥>/` 继续兼容。
- **可选连接密码**：默认启用独立随机密码；管理员可随时查看完整客户端地址，也可显式改为公开短路径访问。
- **多主线路**：最多配置 8 条，以分号或换行分隔。安全的 GET/HEAD 请求遇到网络错误或 502/503/504 时自动尝试下一线路；连续失败会指数退避熔断。
- **前后端分离**：播放线路可独立配置。`Videos`、`Audio`、`LiveTV` 和下载路径会走播放线路，其余 API/元数据走主线路。
- **播放链路兼容**：保留 `Range` / `If-Range` 与 `206 Partial Content`，向上游传递公网域名和 HTTPS 协议信息，并正确处理 Toolbox 基础路径及 CDN 跳转。
- **302 策略**：直连模式把外链交给客户端，节省中转流量；隐私中转模式最多跟随 5 次重定向，跨站时会移除 Cookie、Authorization 和 Emby Token，避免凭据泄漏。
- **兼容性请求头**：管理员可设置通用 `User-Agent`、`X-Emby-Client`、设备名称和设备 ID，默认关闭且留有审计记录。
- **节点首页**：每个节点可选择是否在代理首页展示名称；带密钥节点不会公开密钥。
- **线路诊断**：管理面展示连续失败、熔断状态、重试时间和最近成功时间，不显示真实上游。
- **流量治理**：按节点统计请求、播放请求、上下行流量、错误和活动连接；支持 Mbps 限速与月度 GB 配额。
- **完整控制台**：仪表盘、节点卡片、流量趋势、TLS/Emby 版本诊断、安全审计、配置导入导出和 HTTPS 部署状态集中呈现。
- **保号提醒**：可配置节点维护周期，通过 Telegram Bot 推送提醒；完成保号后在节点卡片重置周期。

兼容性请求头只适用于你拥有或已获明确授权的 Emby 上游。AegisRelay 不内置第三方客户端冒充模板，也不应用于绕过上游禁止反代、客户端限制或其他访问控制。详见 [节点管理说明](docs/NODE_MANAGEMENT.md)。

## 安全默认值

- curl 安装后的初始化阶段临时公开 `9080`；完成域名向导后自动改为仅监听 `127.0.0.1:9080`。
- 管理员必须使用至少 14 位密码和 TOTP；提供一次性恢复码。
- 密码使用高成本 `scrypt`，持久数据使用 AES-256-GCM 整体加密。
- 登录限速、30 分钟会话、HttpOnly + SameSite=Strict Cookie、CSRF Token。
- CSP、禁止 iframe、禁止 referrer、关闭缓存和 MIME sniffing。
- 默认拒绝私网、环回、链路本地和保留地址回源，降低 SSRF 风险。
- 不接受用户传入的 `X-Forwarded-For`，不把管理 Cookie 转发给上游。
- 路由访问密钥不会写入应用访问日志，审计日志会脱敏。
- Docker 默认无 root、只读文件系统、丢弃全部 capabilities、禁止提权。

详细边界见 [SECURITY.md](SECURITY.md) 与 [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)。

## 一条 curl 完成安装

支持 Debian / Ubuntu。安装器会准备 Docker、下载公开仓库到 `/opt/aegis-relay`、生成独立主密钥、Setup Token 和随机管理路径，然后启动临时初始化入口：

```bash
curl -fsSL https://raw.githubusercontent.com/bear4f/aegis-relay/main/scripts/bootstrap.sh | sudo sh
```

安装结束会显示：

```text
管理地址: http://服务器公网IP:9080/admin-随机路径
Setup Token: 一次性随机令牌
```

在云防火墙/安全组临时放行 TCP 9080，打开该管理地址，设置强密码并绑定 TOTP。初始化期间不要添加正式节点，不要把 Setup Token 发到聊天或工单。

### 域名、Nginx 与自动证书

1. 将域名的 A/AAAA 记录指向服务器。
2. 安全组放行 TCP 80 和 443。使用 Cloudflare 时，首次签证建议先设为 DNS only。
3. 完成面板初始化后执行：

```bash
sudo aegis-relay domain panel.example.com admin@example.com
```

该命令会依次完成：

- 安装并配置 Nginx；
- 同一 HTTPS 域名根路径直接打开 2FA 管理面板，节点短路径继续由代理入口处理；
- 通过 Certbot 申请 Let's Encrypt 证书并强制 HTTP 跳转 HTTPS；
- 启用 `certbot.timer` 自动续期；
- 证书成功后把 Docker 的管理端口从 `0.0.0.0:9080` 收回为 `127.0.0.1:9080`；
- 写入 `PUBLIC_BASE_URL` 并启用 Secure Cookie。

最终管理地址：

```text
https://panel.example.com/
```

最终客户端节点地址：

```text
https://panel.example.com/charity/<访问密钥>/
```

此时外网不能再直接访问 `IP:9080`。可从云安全组删除 9080 放行规则。Nginx 站点关闭 access log，避免路径密钥进入日志。

随机管理路径仍保留为兼容入口，但日常无需记忆。可选的公开节点页移动到 `https://panel.example.com/gateway/`。管理员会话保存在同一份 AES-256-GCM 加密数据文件中，因此正常更新不会要求立即重新登录；代理层会剥离管理员会话 Cookie 和 CSRF 头，绝不会把它们发送给 Emby 上游。

### 运维命令

```bash
sudo aegis-relay status
sudo aegis-relay logs
sudo aegis-relay update
systemctl status certbot.timer
certbot certificates
```

如果 DNS 或证书申请失败，脚本不会关闭 9080 临时入口；修复后重新执行 `aegis-relay domain`。Nginx 配置校验失败会自动恢复上一份站点配置。

### 数据目录权限修复

若旧版本首次创建管理员时出现 `EACCES: permission denied, open '/app/data/...'`，重新执行安装命令即可。安装器会保留 `.env` 和加密数据，并将数据目录修正为固定的非 root 运行用户：

```bash
curl -fsSL https://raw.githubusercontent.com/bear4f/aegis-relay/main/scripts/bootstrap.sh | sudo sh
```

## 使用流程

1. 用 Setup Token 初始化管理员，立即保存 TOTP Secret 和恢复码。
2. 登录后填写显示名称、短别名和上游地址。
3. 一般保持默认的“连接密码开启”和“由本机中转”即可；前后端分离、私网回源等选项位于高级设置。
4. 创建后点击节点卡片的“查看地址”，复制完整 HTTPS 地址到 Emby 客户端。
5. 怀疑泄露时点击“更换密码”；旧地址立即失效。

详细安装说明见 [部署手册](docs/DEPLOYMENT.md)。

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
