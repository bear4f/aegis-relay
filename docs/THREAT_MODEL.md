# Threat model

## Protected assets

上游地址、管理员凭据、TOTP 秘钥、恢复码、路由访问能力、审计记录，以及 Emby 请求中的认证头和 Cookie。

## Trust boundaries

客户端到公网代理、管理员到本机管理监听器、AegisRelay 到上游、进程到加密数据文件是四个独立边界。TLS 由前置代理终止时，前置代理属于受信任计算基。

## Main threats and controls

| Threat | Primary controls | Residual risk |
|---|---|---|
| 管理员撞库 | scrypt、TOTP、登录限速、短会话 | 主机被控后无法保护 |
| CSRF/XSS | CSRF token、Strict cookie、CSP、DOM textContent | 浏览器扩展仍可能读取页面 |
| 客户端 URL 泄露 | 单路由随机密钥、只存摘要、no-referrer、无 URI 日志、快速轮换 | 外层代理和客户端可能记录 |
| SSRF/云元数据访问 | URL 解析、默认拒绝私网/环回/链路本地、禁止 URL 凭据 | 显式允许私网后风险上升 |
| 数据文件被读取 | AES-256-GCM、0600、Docker 只读根文件系统 | 主密钥同时泄露时失效 |
| 上游身份泄露 | 不转发 Forwarded/XFF、覆盖 Host、清理 hop-by-hop 头 | Emby 自身可识别代理出口 IP |
| 开放代理 | 只有已配置别名 + 正确独立密钥可路由 | 密钥泄露前仍可被使用 |

## Non-goals

本项目不隐藏代理服务器 IP，不绕过上游授权，不提供匿名网络，也不能保护已被完全攻陷的宿主机或管理员设备。
