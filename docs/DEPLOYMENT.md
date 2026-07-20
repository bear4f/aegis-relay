# AegisRelay 部署手册

## 部署状态机

### 1. 临时初始化

`bootstrap.sh` 首次安装时使用：

```env
ADMIN_PUBLISH_IP=0.0.0.0
SECURE_COOKIES=false
PUBLIC_BASE_URL=
```

这样可以通过 `http://服务器IP:9080/<随机管理路径>` 完成首次管理员设置。随机管理路径不是认证手段，真正的认证仍由强密码、TOTP、登录限速和会话 Cookie 提供。

只应短时间开放 9080。建议限制安全组来源 IP；如果无法限制，完成初始化后立即执行域名收口。

### 2. DNS 和端口

- 域名 A/AAAA 必须指向当前服务器。
- TCP 80 用于 ACME HTTP 验证和 HTTP→HTTPS 跳转。
- TCP 443 承载管理面和 Emby 节点。
- TCP 9080 只在初始化阶段临时开放。
- TCP 8080 无需在云安全组开放；生产流量由本机 Nginx 转发。

### 3. HTTPS 收口

```bash
sudo aegis-relay domain panel.example.com admin@example.com
```

只有当 Nginx 配置校验和 Certbot 签证全部成功后，脚本才会更新：

```env
ADMIN_PUBLISH_IP=127.0.0.1
SECURE_COOKIES=true
PUBLIC_BASE_URL=https://panel.example.com
```

随后强制重建容器端口映射。即使主机防火墙规则尚未删除，9080 也只会绑定回环地址。

## Nginx 路由

同一域名使用两个内部上游：

- `/<ADMIN_PATH>/...` → `127.0.0.1:9080`
- 其他路径 → `127.0.0.1:8080`

站点级 access log 默认关闭，因为 Emby 客户端访问密钥位于路径中。若必须启用日志，应先配置 URI 脱敏。

## 证书续期

Certbot 安装包提供 systemd timer：

```bash
systemctl status certbot.timer
certbot renew --dry-run
```

建议首次部署稳定后手动执行一次 dry-run。续期时 Certbot 的 Nginx 插件会自动重载证书。

## 更新与备份

更新不会覆盖 `/opt/aegis-relay/.env` 或 `/opt/aegis-relay/data`：

```bash
sudo aegis-relay update
```

必须备份：

- `/opt/aegis-relay/.env`
- `/opt/aegis-relay/data/aegis.enc.json`
- `/etc/nginx/sites-available/aegis-relay.conf`
- `/etc/letsencrypt/`

数据文件与 `APP_MASTER_KEY` 缺一不可，建议分开加密保存。

## 数据目录权限

容器固定使用 UID/GID `10001:10001`，安装器会将 `/opt/aegis-relay/data` 调整为该用户所有，并保持目录权限 `0700`。如果从早期版本更新后遇到 `EACCES`，重新运行一键安装命令即可在不覆盖 `.env` 和数据的情况下修复所有权并重建容器。
