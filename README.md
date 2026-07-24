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
- 前后端分离（登录与播放分属不同网址）支持：可选、按节点开启，仅限你拥有或已获授权的上游。响应体里指向声明推流网址的绝对地址会被改写为经本反代回源，客户端始终只用你的域名取流；只有你声明的推流网址可经此路径回源（防 SSRF/开放代理），且只改写文本/清单响应，媒体流零改动不影响播放速度
- **v0.10.1 播放恢复快路径**：所有播放响应默认按原始字节零改动转发；API 与媒体使用互相隔离的连接池，`PlaybackInfo` 会预热媒体池，HLS 分片和 Range 拖动复用热连接与 TCP 拥塞窗口，不再从十几 KB 重新慢启动。明确长度的媒体若被上游中途切断，会按已送达字节发起最多两次校验后的 Range 续拉，客户端连接与响应头保持不变。主代理与探针共用同一逻辑。
- 面向流媒体调优：DNS 结果缓存、TLS 会话恢复、256 KiB 有界背压窗口、Nginx 256 KiB 无缓冲读取块、禁止临时文件和隐式限速、上下游 socket keepalive、无限速时零中间变换、`TCP_NODELAY`；下游产生背压时暂停上游失活检测，不会把暂停观看误判为断流

**多机数据面**
- 面板生成 10 分钟有效的**一次性安装指令**，远程机器用 Ed25519/X25519 身份注册
- 每台机器只拉取**属于自己的加密节点快照**，原子应用后回传版本
- 每台机器可用**独立域名**；在面板改域名后，受限的主机执行器自动申请证书并切换 Nginx
- 机器卡片显示在线状态、配置版本、流量占比；**代理程序落后于面板时会标出待升级**并给出更新命令

**运维与安全**
- 仪表盘、每日流量趋势、按机器流量、TLS/Emby 版本诊断、安全审计
- 自定义面板图标：在「个人设置」上传本地图片或填写在线图片地址，替换左上角标志与浏览器标签页图标（在线图片由服务器下载并保存副本，客户端不访问原地址）
- 按节点限速（Mbps）与月度配额（GB）
- 保号提醒（Telegram Bot）

---

## 快速开始

支持 Debian / Ubuntu。安装器会准备 Docker、下载仓库到 `/opt/aegis-relay`、生成独立主密钥、Setup Token 和随机管理路径：

```bash
curl -fsSL https://raw.githubusercontent.com/bear4f/aegis-relay/main/scripts/bootstrap.sh | sudo sh
```

安装末尾会引导两步确认并**自动申请证书**（需要域名已解析到本机、放行 TCP 80/443；用 Cloudflare 时首次签证建议先设为 DNS only）：

1. **步骤 1/2**：输入面板域名和证书邮箱
2. **步骤 2/2**：输入本机 Emby 反代域名，**回车默认与面板同域**；填不同域名则自动申请第二张证书并完成双域名切换

完成后直接显示：

```text
管理地址: https://你的面板域名/
Setup Token: 一次性随机令牌
Emby 客户端入口: https://你的反代域名/<节点别名>/<访问密钥>/
```

打开管理地址，用 Setup Token 设置至少 14 位密码并绑定 TOTP，全程无需在云防火墙开放 9080。

> 初始化期间不要添加正式节点，不要把 Setup Token 发到聊天或工单。

### 跳过引导时的域名与自动证书

安装时跳过域名引导（或非交互执行）会回到临时公网初始化模式：在云防火墙临时放行 TCP 9080，按输出的 `http://IP:9080/admin-随机路径` 完成初始化，之后任意时刻执行：

```bash
sudo aegis-relay domain                      # 交互式两步确认，同上
sudo aegis-relay domain panel.example.com admin@example.com                   # 单域名
sudo aegis-relay domain panel.example.com admin@example.com emby.example.com  # 双域名
```

已在单域名模式运行后，也可以在「代理机器 → 本地 Agent」填写一个**不同的**代理域名，面板会自动完成第二张证书与双域名切换。

双域名模式下职责分离：

| 域名 | 提供 |
|---|---|
| `panel.example.com` | 2FA 管理面板、Agent 注册与配置同步 |
| `emby.example.com` | 仅 Emby 网关与播放流量 |

Nginx 会精确校验请求 Host——旧代理域名和指向同一 IP 的其他子域名返回 421 / 404；站点关闭 access log，避免路径密钥进入日志。证书通过 Certbot 签发并由 `certbot.timer` 自动续期；成功后管理端口从 `0.0.0.0:9080` 收回为 `127.0.0.1:9080`，此时可从安全组删除 9080 规则。

DNS 或证书失败时不会关闭 9080 临时入口，修复后重跑即可；Nginx 校验失败会自动回滚上一份配置。

### 添加远程代理机

在「代理机器 → 添加机器」填写机器名、要部署的节点，以及**可选**的代理域名，面板会生成一条命令，在目标机器执行即可：

- **填写域名**：安装时把 DNS 指向目标机器，自动申请证书走 HTTPS（用「部署向导」里保存的**统一证书邮箱**）。
- **留空域名**：以本机公网 IP 作明文 HTTP 反代（`http://IP/`），无需域名和证书，适合先跑起来或临时机器。

两种模式之后都能**在面板里随时切换**：编辑该机器的「代理域名」——填入域名切到 HTTPS，清空则切回 IP 反代——面板下发受限请求，机器上的主机执行器自动申请证书或重配 Nginx 并回报进度。每台机器部署哪些节点由**节点勾选框**决定：勾选即部署生效，取消勾选即从该机器移除。

改这台机器的域名时**直接在面板里改**：面板下发目标域名 → 机器写入受限请求 → 主机执行器申请证书并切换 Nginx → 机器回报实际生效域名，面板全程显示进度。

---

## 运维命令

主机：

```bash
sudo aegis-relay             # 交互式控制台：状态/日志/更新/域名/卸载 逐项选择
sudo aegis-relay status      # 容器状态
sudo aegis-relay logs        # 实时日志
sudo aegis-relay update      # 拉取最新版并重建
sudo aegis-relay domain      # 两步确认面板域名与 Emby 反代域名（默认同域），自动申请证书
sudo aegis-relay proxy-domain emby.example.com   # 面板执行器不可用时的手动兜底
sudo aegis-relay uninstall   # 一键卸载面板（需输入 yes 确认；保留 TLS 证书）
```

每台代理机器：

```bash
sudo aegis-relay-agent             # 交互式控制台：状态/日志/更新/域名/IP/卸载 逐项选择
sudo aegis-relay-agent status
sudo aegis-relay-agent logs
sudo aegis-relay-agent update      # 策略更新后每台都要跑
sudo aegis-relay-agent domain relay.example.com admin@example.com   # 切换/配置 HTTPS 域名
sudo aegis-relay-agent ip          # 切回本机 IP 明文 HTTP 反代（面板执行器不可用时的手动兜底）
sudo aegis-relay-agent uninstall   # 一键卸载探针（需输入 yes 确认；保留 TLS 证书）
```

> **更新策略时，主机和每台代理机都要各自更新**——数据面代码是共用的，但每台机器各自构建镜像。面板会把落后的机器标为「待升级」，照着提示逐台执行即可。更新命令会同时重建当前 Nginx 入口与共享代理内核。

### 可选：高 RTT/跨境线路的宿主机 TCP 调优

AegisRelay 不会在普通更新时擅自覆盖宿主机 `sysctl` 或根队列。高 RTT、丢包或运营商 policer 明显的机器可配合 [NetShape Manager](https://github.com/bear4f/netshape-manager)：它会先检查内核是否真的支持 BBR/FQ，再按线路 Mbps、RTT 和机器内存计算 TCP 缓冲，而不是给所有 VPS 固定写入 32 MiB。先运行 `sudo netshape status` 与 `sudo netshape diagnose`；若播放期间重传持续上升，使用略低于观看端实际带宽的单连接档位通常比单纯放大缓冲更稳定。干净直连线路才建议使用 `sudo netshape adaptive`。

`kernel.panic`、`vm.swappiness` 并不能直接加快媒体首字节；真正与本项目数据面相关的是可用时的 `bbr + fq`、足够覆盖 BDP 的 `tcp_rmem/tcp_wmem`、`tcp_mtu_probing`、避免保存坏路径指标，以及无磁盘缓冲/无限速的 Nginx 配置。后者已由 AegisRelay 更新脚本自动生成。

---

## 安全默认值

- 管理员必须使用至少 14 位密码 + TOTP，并提供一次性恢复码
- 密码用高成本 `scrypt`，持久数据整体 AES-256-GCM 加密
- 登录限速、30 分钟会话、HttpOnly + SameSite=Strict Cookie、CSRF Token
- CSP、禁止 iframe、禁止 referrer、关闭缓存与 MIME sniffing
- 默认拒绝私网、环回、链路本地和保留地址回源，降低 SSRF 风险
- 不信任客户端伪造的 `X-Forwarded-For` / `X-Real-IP`——仅当请求来自本机 Nginx 时采用其注入的真实来源 IP，用于按 IP 登录限速与审计；转发上游前一律移除，也不把管理 Cookie / CSRF 头转发给上游
- Agent 注册端点按来源 IP 限速；登录、注册限速表有内存上界，无法被撑爆
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
