# Security Policy

## Supported versions

安全预览阶段仅维护最新提交。请勿在公开 Issue 中提交密钥、客户端 URL、上游地址、数据库、`.env`、日志或漏洞利用细节。

## Reporting

请使用 GitHub Private Vulnerability Reporting。报告应包含受影响版本、最小复现、影响范围和建议缓解方式；所有示例必须使用已撤销的假密钥。

## Operator responsibilities

- 管理面必须位于 HTTPS、VPN、SSH 隧道或 mTLS 后方。
- 不要公开 9080；不要启用代理层 URI 日志。
- 定期轮换路由密钥，离职/设备丢失时立即轮换。
- 保持 Node.js、容器基础镜像和宿主系统更新。
- 私网回源会扩大 SSRF 后果，只对明确控制的上游启用。
- 上游 TLS 验证应保持开启。关闭验证仅用于短期诊断。
- 客户端兼容性请求头只可用于已获授权的上游，不得用来规避服务器访问控制。

## Known limitations

- 兼容普通 Emby 客户端需要把 capability key 放在路径中。它可能被客户端历史记录、浏览器历史或外层代理日志捕获；AegisRelay 自身不会记录它。
- 单管理员、单实例内存会话；暂不支持高可用共享会话。
- 尚未实现 WebAuthn、硬件密钥、细粒度 RBAC、自动 ACME 和带签名的发布制品。
- 自动重试仅用于 GET/HEAD。POST 等可能产生副作用的请求不会跨线路重放，以避免重复登录、写入或管理操作。
