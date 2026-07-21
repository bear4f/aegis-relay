# AegisRelay

[![CI](https://github.com/bear4f/aegis-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/bear4f/aegis-relay/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

隐私优先的 **Emby 多服务器反向代理管理面板**。把一堆冗长的上游地址收敛成短别名，并可分发到多台代理机器：

```text
https://emby.example.com/charity/<访问密钥>/
https://emby.example.com/family/<访问密钥>/
```

上游域名、端口和协议**不会出现在客户端地址里**。零第三方运行时依赖，只用 Node.js 标准库 + AES-256-GCM 加密存储。

---

## 解决什么问题

手里有多个公益服 / 机场服 / 自建服时，通常会遇到：

| 痛点 | AegisRelay 的做法 |
|---|---|
| 每个服地址、端口各不相同，换设备要重输一堆 | 统一入口 + 短别名，客户端只记一个域名 |
| 源站在国内直连困难，家人不会配代理 | 把面板装在直连线路好的中转机上，**客户端零配置**即可观看 |
| 部分服限制播放器类型 | 按节点配置兼容请求头（UA / Client / 设备名）|
| 多个服容易忘记保号 | 按节点设置维护周期，Telegram 推送提醒 |
| 单机带宽和线路有限 | **多机数据面**：注册多台代理机，每台独立域名、各自承载不同节点 |

> 兼容请求头只适用于你**拥有或已获明确授权**的上游。本项目不内置第三方客户端冒充模板，也不应用于绕过上游的反代禁令或访问控制。详见 [节点管理说明](docs/NODE_MANAGEMENT.md)。

---

## 核心能力

**节点与地址**
- 短路径节点 `/charity/<访问密钥>/`，旧版 `/r/charity/<访问密钥>/` 继续兼容
- 连接密码**可随时开关**，也可自定义；改动后面板直接给出新的客户端地址
- 节点列表为密集表格，支持**搜索**、**拖动排序**，地址默认掩码、可就地展开与复制
- 配置导入导出；可选择是否在网关首页公开展示节点名

**播放链路**
- 保留 `Range` / `If-Range` 与 `206 Partial Content`，适配拖动进度条与断点续传
- **全程代理接管**：上游的跳转会被改写回带认证的 AegisRelay 地址，客户端不会绕过代理直连源站
- 跨站请求自动移除 Cookie、Authorization 和 Emby Token，避免凭据泄漏
- 多主线路（最多 8 条）故障转移：安全请求遇到网络错误或 502/503/504 自动切换，连续失败才熔断退避
- 前后端分离支持：`Videos` / `Audio` / `LiveTV` / 下载走独立播放线路，其余走主线路
- 面向流媒体调优：上游连接复用、DNS 结果缓存、无限速时零中间缓冲、`TCP_NODELAY`、长空闲窗口（不会掐断慢转码和暂停）

**多机数据面**
- 面板生成 10 分钟有效的**一次性安装指令**，远程机器用 Ed25519/X25519 身份注册
- 每台机器只拉取**属于自己的加密节点快照**，原子应用后回传版本
- 每台机器可用**独立域名**；在面板改域名后，受限的主机执行器自动申请证书并切换 Nginx
- 机器卡片显示在线状态、配置版本、流量占比；**代理程序落后于面板时会标出待升级**并给出更新命令

**运维与安全**
- 仪表盘、每日流量趋势、按机器流量、TLS/Emby 版本诊断、安全审计
- 按节点限速（Mbps）与月度配额（GB）
- 保号提醒（Telegram Bot）

---

## 快速开始

支持 Debian / Ubuntu。安装器会准备 Docker、下载仓库到 `/opt/aegis-relay`、生成独立主密钥、Setup Token 和随机管理路径：

```bash
curl -fsSL https://raw.githubusercontent.com/bear4f/aegis-relay/main/scripts/bootstrap.sh | sudo sh
```

安装结束会显示：

```text
管理地址: http://服务器公网IP:9080/admin-随机路径
Setup Token: 一次性随机令牌
```

在云防火墙临时放行 TCP 9080，打开该地址，设置至少 14 位密码并绑定 TOTP。

> 初始化期间不要添加正式节点，不要把 Setup Token 发到聊天或工单。

### 域名与自动证书

1. 把域名 A/AAAA 记录指向服务器，放行 TCP 80 / 443（用 Cloudflare 时首次签证建议先设为 DNS only）
2. 面板初始化完成后执行：

```bash
sudo aegis-relay domain panel.example.com admin@example.com
```

3. 随后在「代理机器 → 本地 Agent」填写一个**不同的**代理域名，面板会自动完成第二张证书与双域名切换。

切换完成后职责分离：

| 域名 | 提供 |
|---|---|
| `panel.example.com` | 2FA 管理面板、Agent 注册与配置同步 |
| `emby.example.com` | 仅 Emby 网关与播放流量 |

Nginx 会精确校验请求 Host——旧代理域名和指向同一 IP 的其他子域名返回 421 / 404；站点关闭 access log，避免路径密钥进入日志。证书通过 Certbot 签发并由 `certbot.timer` 自动续期；成功后管理端口从 `0.0.0.0:9080` 收回为 `127.0.0.1:9080`，此时可从安全组删除 9080 规则。

DNS 或证书失败时不会关闭 9080 临时入口，修复后重跑即可；Nginx 校验失败会自动回滚上一份配置。

### 添加远程代理机

先在「部署向导」保存**统一证书邮箱**，之后在「代理机器 → 添加机器」填写机器名、已解析到目标机器的域名和要部署的节点，面板会生成一条命令，在目标机器执行即可。

改这台机器的域名时**直接在面板里改**：面板下发目标域名 → 机器写入受限请求 → 主机执行器申请证书并切换 Nginx → 机器回报实际生效域名，面板全程显示进度。

---

## 运维命令

主机：

```bash
sudo aegis-relay status      # 容器状态
sudo aegis-relay logs        # 实时日志
sudo aegis-relay update      # 拉取最新版并重建
sudo aegis-relay domain panel.example.com admin@example.com
sudo aegis-relay proxy-domain emby.example.com   # 面板执行器不可用时的手动兜底
```

每台代理机器：

```bash
sudo aegis-relay-agent status
sudo aegis-relay-agent logs
sudo aegis-relay-agent update      # 策略更新后每台都要跑
sudo aegis-relay-agent domain relay.example.com admin@example.com
sudo aegis-relay-agent uninstall
```

> **更新策略时，主机和每台代理机都要各自更新**——数据面代码是共用的，但每台机器各自构建镜像。面板会把落后的机器标为「待升级」，照着提示逐台执行即可。

---

## 安全默认值

- 管理员必须使用至少 14 位密码 + TOTP，并提供一次性恢复码
- 密码用高成本 `scrypt`，持久数据整体 AES-256-GCM 加密
- 登录限速、30 分钟会话、HttpOnly + SameSite=Strict Cookie、CSRF Token
- CSP、禁止 iframe、禁止 referrer、关闭缓存与 MIME sniffing
- 默认拒绝私网、环回、链路本地和保留地址回源，降低 SSRF 风险
- 不接受用户传入的 `X-Forwarded-For`，不把管理 Cookie / CSRF 头转发给上游
- 访问密钥不写入访问日志，审计日志自动脱敏
- Agent 请求使用 Ed25519 签名 + nonce 防重放；面板响应同样签名
- 容器非 root、只读文件系统、丢弃全部 capabilities、禁止提权

边界说明见 [SECURITY.md](SECURITY.md)、[威胁模型](docs/THREAT_MODEL.md) 与 [Agent 协议](docs/AGENT_PROTOCOL.md)。

---

## 使用流程

1. 用 Setup Token 初始化管理员，**立即离线保存** TOTP Secret 和恢复码
2. 填写显示名称、短别名和上游地址（前后端分离、私网回源等在高级设置里）
3. 在节点表格的「客户端地址」列点眼睛展开、点「复制」，粘贴到 Emby 客户端
4. 怀疑泄露时点「密码」更换，旧地址立即失效；也可整体关闭连接密码

详细安装说明见 [部署手册](docs/DEPLOYMENT.md)。

---

## 开发与备份

只依赖 Node.js 20+，无第三方运行时包：

```bash
npm run check
npm test
```

一致备份必须**同时**包含 `data/aegis.enc.json` 和 `.env` 里的 `APP_MASTER_KEY`，且二者分开加密保存。丢失主密钥无法恢复；同时泄露主密钥与数据文件等同于数据泄露。

## License

MIT。Emby 是其权利人的商标，本项目与 Emby 官方无隶属关系。
