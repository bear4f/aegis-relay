# AegisRelay 部署手册

## 部署状态机

### 0. 安装时域名引导（推荐路径）

`bootstrap.sh` 首次安装结束时（检测到交互终端）会引导两步确认并自动申请证书：

1. 步骤 1/2：面板域名 + 证书邮箱
2. 步骤 2/2：本机 Emby 反代域名，回车默认与面板同域；填不同域名则追加第二张证书并切换为双域名 Nginx 路由

确认后自动执行 Nginx 配置、Certbot 签证和容器端口收口，安装输出直接给出 `https://面板域名/` 管理地址和 Setup Token，全程无需开放 9080。跳过引导（回答 `n`、无终端或证书失败）则进入下述临时初始化模式。

### 1. 临时初始化

跳过安装时域名引导后，`bootstrap.sh` 首次安装使用：

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
sudo aegis-relay domain                      # 交互式：两步确认面板域名与 Emby 反代域名（默认同域）
sudo aegis-relay domain panel.example.com admin@example.com                   # 非交互单域名
sudo aegis-relay domain panel.example.com admin@example.com emby.example.com  # 非交互双域名
```

安装时的域名引导执行的就是同一流程。只有当 Nginx 配置校验和 Certbot 签证全部成功后，脚本才会更新：

```env
ADMIN_PUBLISH_IP=127.0.0.1
SECURE_COOKIES=true
PUBLIC_BASE_URL=https://panel.example.com
```

随后强制重建容器端口映射。即使主机防火墙规则尚未删除，9080 也只会绑定回环地址。

## Nginx 路由

同一域名使用两个内部上游：

- `/`、管理静态文件和 `/api/...` 由 `127.0.0.1:8080` 内部转交管理面；最终管理地址就是 `https://域名/`。
- `/<节点别名>/...` 由 `127.0.0.1:8080` 转发到对应 Emby 上游。
- `/<ADMIN_PATH>/...` → `127.0.0.1:9080` 作为旧地址兼容入口，日常无需使用。
- `/gateway/` 是可选的公开节点展示页。

站点级 access log 默认关闭，因为 Emby 客户端访问密钥位于路径中。若必须启用日志，应先配置 URI 脱敏。

根路径管理 Cookie 会覆盖整个域名，但代理会在转发前删除 `aegis_session` Cookie 和 CSRF 请求头，防止管理凭据进入任何 Emby 上游。管理员会话随其他配置一起加密保存，容器正常更新后仍可继续使用，闲置 30 分钟后失效。

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

## 内存占用

容器内 V8 堆默认按宿主机内存自动扩张。compose 已内置上限：面板 256MB、代理机 Agent 192MB，正常规模（≤100 节点、多台代理机）远用不满。需要调整时在 `.env` 中设置：

```env
PANEL_MAX_HEAP_MB=256
AGENT_MAX_HEAP_MB=192
```

播放流量全程管道直通、不做中间缓冲，内存占用与并发流数量近似线性、与视频码率无关。删除节点会同时清理其统计与熔断状态，长期运行不会累积。

## 数据目录权限

容器固定使用 UID/GID `10001:10001`，安装器会将 `/opt/aegis-relay/data` 调整为该用户所有，并保持目录权限 `0700`。如果从早期版本更新后遇到 `EACCES`，重新运行一键安装命令即可在不覆盖 `.env` 和数据的情况下修复所有权并重建容器。
