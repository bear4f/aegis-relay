import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('front-end id selectors resolve to real elements',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1])),referenced=[...js.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]\)/g)].map(x=>x[1]);const missing=[...new Set(referenced.filter(x=>!ids.has(x)))];assert.deepEqual(missing,[])});
test('admin page has no inline executable scripts',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');assert.equal(/<script(?![^>]+src=)/i.test(html),false);assert.match(html,/STYLE_CSS/);assert.match(html,/HELP_CSS/);assert.match(html,/APP_JS/)});
test('node editor uses fixed proxy takeover and supports viewing client addresses',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');assert.match(html,/高级设置/);assert.match(html,/开启（推荐，防止他人盗用）/);assert.doesNotMatch(html,/遇到 302 播放跳转时/);assert.doesNotMatch(js,/directStream/);assert.match(html,/代理全程接管/);assert.match(js,/addr-reveal/);assert.match(js,/addr-copy/);assert.match(js,/\/credentials/)});
test('node credentials support custom keys and use context-specific copy',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');assert.match(html,/id="access-key"/);assert.match(html,/留空则安全随机生成/);assert.match(js,/askConnectionKey/);assert.match(html,/完整节点地址和连接密码可由管理员随时再次查看/);assert.match(js,/恢复码（每行一个，只显示这一次）/)});
test('admin client derives API path from its script and handles expired sessions',()=>{const js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');assert.match(js,/document\.currentScript/);assert.match(js,/content-type/);assert.match(js,/登录已失效，请重新登录/);assert.doesNotMatch(js,/response\.json\(\)/)});
test('gateway errors are identified as a restarting management service',()=>{const js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');assert.match(js,/\[502,503,504\]/);assert.match(js,/容器可能正在重启/)});
test('read-only diagnostics use GET to pass restrictive reverse proxies',()=>{const js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');assert.match(js,/call\(`\/diagnostics\/\$\{route\.id\}`\)/);assert.match(js,/call\(`\/diagnostics\/\$\{id\}`\)/);assert.match(server,/req\.method===\'GET\'\|\|req\.method===\'POST\'/)});
test('admin server does not return the HTML shell for unknown API-like paths',()=>{const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');assert.match(server,/rel!==\'\/\'&&rel!==\'\/index\.html\'/);assert.match(server,/登录已失效，请重新登录/)});
test('container data directory uses the installer-managed non-root identity',()=>{const dockerfile=fs.readFileSync(new URL('../Dockerfile',import.meta.url),'utf8'),compose=fs.readFileSync(new URL('../compose.yml',import.meta.url),'utf8'),bootstrap=fs.readFileSync(new URL('../scripts/bootstrap.sh',import.meta.url),'utf8');assert.match(dockerfile,/AEGIS_UID=10001/);assert.match(compose,/user: "10001:10001"/);assert.match(bootstrap,/chown -R 10001:10001 data/)});
test('agent page supports domains, route selection and explicit offline cleanup',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');assert.match(html,/失联机器会保留/);assert.match(js,/agent-domain/);assert.match(js,/data-route-id/);assert.match(js,/从面板删除/);assert.match(server,/replaceAgentDeployments/);assert.match(server,/the local agent cannot be deleted/)});
test('glass agent page has global certificate email and a working secure enrollment flow',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../web/style.css',import.meta.url),'utf8'),server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');assert.match(html,/id="add-agent"/);assert.match(html,/id="agent-modal"/);assert.match(html,/id="certificate-email"/);assert.doesNotMatch(html,/id="agent-email"/);assert.match(html,/APP_VERSION/);assert.match(js,/\/agents\/enrollment/);assert.doesNotMatch(js,/value\('#agent-email'\)/);assert.match(css,/\.agent-notice/);assert.match(css,/\.agent-modal-card/);assert.match(server,/settings\.certificateEmail/);assert.match(server,/agent-install\.sh/);assert.match(server,/agent-upgrade\.sh/);assert.match(server,/app\.js\?v=/)});
test('agent installer never persists its single-use enrollment token',()=>{const installer=fs.readFileSync(new URL('../scripts/agent-install.sh',import.meta.url),'utf8'),compose=fs.readFileSync(new URL('../compose.agent.yml',import.meta.url),'utf8');assert.match(installer,/TOKEN_ENV/);assert.match(installer,/rm -f "\$TOKEN_ENV"/);assert.doesNotMatch(compose,/ENROLLMENT_TOKEN/)});
test('agent compatibility upgrade preserves its identity and does not re-enroll',()=>{const upgrade=fs.readFileSync(new URL('../scripts/agent-upgrade.sh',import.meta.url),'utf8'),compose=fs.readFileSync(new URL('../compose.agent.yml',import.meta.url),'utf8');assert.match(upgrade,/data\/identity\.json/);assert.doesNotMatch(upgrade,/ENROLLMENT_TOKEN|--enroll/);assert.match(upgrade,/--force-recreate/);assert.match(compose,/"127\.0\.0\.1:8080:8080"/)});
test('main and agent nginx configurations reject unrelated hostnames',()=>{for(const file of ['../scripts/configure-domain.sh','../scripts/agent-configure-domain.sh']){const script=fs.readFileSync(new URL(file,import.meta.url),'utf8');assert.match(script,/if \(\\\$host != \$DOMAIN\) \{ return 421; \}/);assert.match(script,/tr '\[:upper:\]' '\[:lower:\]'/)}});
test('dashboard shows daily values and per-machine proxy telemetry',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../web/style.css',import.meta.url),'utf8'),server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');for(const id of ['m-month-traffic','m-agents','traffic-insights','dashboard-machines'])assert.match(html,new RegExp(`id="${id}"`));assert.match(js,/machine\.telemetry/);assert.match(js,/traffic-day/);assert.match(js,/traffic-insights/);assert.match(css,/\.machine-overview/);assert.match(css,/\.traffic-track/);assert.match(server,/aggregateTelemetry/);assert.match(server,/setInterval\(send,15000\)/)});
test('panel icon is customizable from account settings via upload or server-side URL fetch',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../web/style.css',import.meta.url),'utf8'),server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8'),icon=fs.readFileSync(new URL('../src/panel-icon.js',import.meta.url),'utf8');assert.match(html,/id="icon-file"/);assert.match(html,/id="icon-url"/);assert.match(html,/id="icon-preview"/);assert.match(js,/applyPanelIcon/);assert.match(js,/\/account\/icon/);assert.match(js,/\/branding/);assert.match(css,/\.brand-mark img/);assert.match(server,/'\/branding'/);assert.match(server,/panelIcon/);assert.match(server,/fetchPanelIcon/);assert.match(icon,/guardedLookup\(false\)/);assert.match(icon,/MAX_ICON_BYTES = 256 \* 1024/);
  // The branding response must not be browser-cached, or a freshly saved icon reverts on refresh.
  const branding=server.match(/rel === '\/branding'\) return json\([^\n]*/);assert.ok(branding);assert.doesNotMatch(branding[0],/max-age/)});
test('agents support IP reverse-proxy mode with panel-driven switching between domain and IP',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8'),api=fs.readFileSync(new URL('../src/agent-api.js',import.meta.url),'utf8'),main=fs.readFileSync(new URL('../src/agent-main.js',import.meta.url),'utf8'),ip=fs.readFileSync(new URL('../scripts/agent-configure-ip.sh',import.meta.url),'utf8'),install=fs.readFileSync(new URL('../scripts/agent-install.sh',import.meta.url),'utf8'),apply=fs.readFileSync(new URL('../scripts/agent-host-domain-apply.sh',import.meta.url),'utf8');assert.match(html,/留空＝用本机 IP 反代/);assert.match(js,/proxyMode/);assert.match(js,/IP 反代/);assert.match(server,/desiredMode='ip'/);assert.match(server,/本机代理域名不能为空/);assert.match(api,/--mode ip/);assert.match(api,/desiredMode:agent\.desiredMode/);assert.match(main,/requestIpSwitch/);assert.match(main,/function effectiveMode/);assert.match(main,/proxyMode:effectiveMode\(\)/);assert.match(ip,/listen 80 default_server/);assert.match(ip,/AGENT_PROXY_MODE ip/);assert.match(install,/--mode\) MODE=/);assert.match(install,/agent-configure-ip\.sh/);assert.match(apply,/"\$MODE" = ip/);assert.match(apply,/agent-configure-ip\.sh/);const upgrade=fs.readFileSync(new URL('../scripts/agent-upgrade.sh',import.meta.url),'utf8');assert.match(upgrade,/install -m 0755 "\$TMP_DIR\/source\/scripts\/agent-configure-ip\.sh"/);assert.match(upgrade,/"\$MODE" = ip/)});
test('node table becomes cards on phones and the deploy picker is a selectable chip grid',()=>{const css=fs.readFileSync(new URL('../web/style.css',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');assert.match(css,/@media\(max-width:760px\)\{[^]*\.data-table tr\{display:block/);assert.match(css,/\.agent-route-list\{[^}]*grid-template-columns:repeat\(auto-fill/);assert.match(css,/\.agent-route-list label\.checked\{/);assert.match(js,/route-bulk route-all/);assert.match(js,/route-bulk route-none/);assert.match(js,/classList\.toggle\('checked'/)});
test('the top-right mobile menu can reach every page including account, audit and deployment',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../web/style.css',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');const menu=html.match(/<nav class="mobile-menu-panel">[\s\S]*?<\/nav>/);assert.ok(menu,'mobile menu exists');const pages=[...menu[0].matchAll(/data-page="([^"]+)"/g)].map(m=>m[1]);for(const page of ['dashboard','nodes','agents','traffic','diagnostics','notifications','audit','account','deployment'])assert.ok(pages.includes(page),`mobile menu missing ${page}`);assert.match(html,/id="nav-toggle"/);assert.match(css,/\.mobile-menu-panel\{/);assert.match(js,/nav-toggle'\)\.onclick/);assert.match(js,/function closeMenu/)});
test('the panel and agent CLIs offer an interactive console and a confirmed one-click uninstall',()=>{const panel=fs.readFileSync(new URL('../scripts/aegis-relay',import.meta.url),'utf8'),agent=fs.readFileSync(new URL('../scripts/aegis-relay-agent',import.meta.url),'utf8');for(const c of [panel,agent]){assert.match(c,/ACTION=\$\{1:-menu\}/);assert.match(c,/AegisRelay .*控制台/);assert.match(c,/do_uninstall\(\)\{/);assert.match(c,/确认卸载请输入 yes/);assert.match(c,/rm -rf -- "\$INSTALL_DIR"/);assert.match(c,/uninstall\) do_uninstall/)}assert.match(panel,/aegis-relay-domain\.path/);assert.match(agent,/aegis-relay-agent-domain\.path/)});
test('help.css no longer hardcodes a dark advanced-settings panel over the theme',()=>{const help=fs.readFileSync(new URL('../web/help.css',import.meta.url),'utf8');assert.doesNotMatch(help,/#0a1018/);assert.doesNotMatch(help,/\.advanced-settings\s*\{[^}]*background:[^};]*#[0-9a-fA-F]/)});
test('a dark theme is available via a persisted top-bar toggle',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../web/style.css',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');assert.match(html,/id="theme-toggle"/);assert.match(html,/name="color-scheme" content="light dark"/);assert.match(css,/:root\[data-theme="dark"\]\{/);assert.match(css,/--glass:/);assert.match(css,/var\(--glass\)/);assert.match(js,/function toggleTheme/);assert.match(js,/dataset\.theme/);assert.match(js,/aegis-theme/)});
test('the login page and shell carry the premium visual pass',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../web/style.css',import.meta.url),'utf8');assert.match(html,/class="auth-features"/);assert.match(html,/class="auth-grid-glow"/);assert.match(css,/\.auth-features li\{/);assert.match(css,/\.metric:after\{/);assert.match(css,/\.sidebar nav button\.active:before\{/);assert.match(css,/#traffic-table tbody tr:hover td:first-child\{/);assert.match(css,/\.empty-state svg\{[^}]*background:var\(--accent-soft\)/);assert.match(css,/\.agent-card\[data-status="stale"\]:before\{background:var\(--amber\)\}/)});
test('the desktop node table is refined: inset address field, path chip and hover accent',()=>{const css=fs.readFileSync(new URL('../web/style.css',import.meta.url),'utf8');assert.match(css,/\.cell-addr\{[^}]*background:var\(--inset\)[^}]*border-radius/);assert.match(css,/\.data-table \.cell-name \.node-path\{[^}]*background:var\(--accent-soft\)/);assert.match(css,/\.data-table tbody tr:hover td:first-child\{box-shadow:inset 3px 0 0 var\(--accent\)\}/);// the compact density overrides that fought the refinement must be gone
  assert.doesNotMatch(css,/\.data-table td\{padding:10px 14px\}/)});
test('the panel installer confirms via a menu on /dev/tty before making any changes',()=>{const bootstrap=fs.readFileSync(new URL('../scripts/bootstrap.sh',import.meta.url),'utf8');assert.match(bootstrap,/AegisRelay 面板安装/);assert.match(bootstrap,/1\) 确认，开始安装/);assert.match(bootstrap,/read -r AEGIS_CONFIRM < \/dev\/tty/);assert.match(bootstrap,/已取消，未做任何修改/);// the confirmation must sit before the apt install so a cancel changes nothing
  assert.ok(bootstrap.indexOf('AegisRelay 面板安装')<bootstrap.indexOf('apt-get update'),'confirmation runs before apt')});
test('installers ensure apparmor_parser exists so docker builds on minimal AppArmor kernels',()=>{const bootstrap=fs.readFileSync(new URL('../scripts/bootstrap.sh',import.meta.url),'utf8'),agent=fs.readFileSync(new URL('../scripts/agent-install.sh',import.meta.url),'utf8');for(const s of [bootstrap,agent]){assert.match(s,/command -v apparmor_parser/);assert.match(s,/apt-get install -y apparmor/)}});
test('a finished domain switch stops surfacing a lingering success banner',()=>{const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');assert.match(server,/ongoingDomainChange/);assert.match(server,/change\.state==='active'&&\(!change\.currentDomain\|\|change\.currentDomain===liveEndpoint\)/)});
test('install-time domain wizard confirms panel and proxy domains in two steps with same-domain default',()=>{const wizard=fs.readFileSync(new URL('../scripts/domain-wizard.sh',import.meta.url),'utf8'),bootstrap=fs.readFileSync(new URL('../scripts/bootstrap.sh',import.meta.url),'utf8'),cli=fs.readFileSync(new URL('../scripts/aegis-relay',import.meta.url),'utf8');assert.match(wizard,/步骤 1\/2 - 面板域名/);assert.match(wizard,/步骤 2\/2 - 本机 Emby 反代域名/);assert.match(wizard,/回车默认同面板域名/);assert.match(wizard,/PROXY_DOMAIN="\$PANEL_DOMAIN"/);assert.match(wizard,/< \/dev\/tty/);assert.match(wizard,/configure-domain\.sh/);assert.match(wizard,/configure-local-domain\.sh/);assert.match(bootstrap,/domain-wizard\.sh/);assert.match(bootstrap,/是否现在配置域名/);assert.match(cli,/domain-wizard\.sh/)});
test('local agent domain changes use an automatic constrained host workflow and separated client origin',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8'),bootstrap=fs.readFileSync(new URL('../scripts/bootstrap.sh',import.meta.url),'utf8'),nginx=fs.readFileSync(new URL('../scripts/configure-local-domain.sh',import.meta.url),'utf8');assert.match(html,/面板一键切换/);assert.match(js,/切换代理域名/);assert.match(js,/watchDomainSwitch/);assert.match(server,/requestDomainSwitch/);assert.match(server,/clientBaseUrl/);assert.match(server,/splitDomains/);assert.match(bootstrap,/aegis-relay-domain\.path/);assert.match(nginx,/控制面/);assert.match(nginx,/本地数据面/);assert.match(nginx,/旧代理域名已从 Nginx 路由移除/)});
test('the mobile menu exposes exactly the same pages, in the same order, as the desktop nav',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');const desktop=[...(html.match(/<nav>([\s\S]*?)<\/nav>/)||['',''])[1].matchAll(/data-page="([^"]+)"/g)].map(m=>m[1]);const mobile=[...((html.match(/mobile-menu-panel">([\s\S]*?)<\/nav>/)||['',''])[1]).matchAll(/data-page="([^"]+)"/g)].map(m=>m[1]);assert.ok(desktop.length>=8,'desktop nav should list every page');assert.deepEqual(mobile,desktop);/* 移动端功能栏必须与桌面导航同步，缺一页就会出现“移动端功能栏没有同步更新” */assert.ok(desktop.includes('access'),'访问监控 must be present in both navs')});
test('single-domain panel setup clears any stale split reverse-proxy domain, while split setup sets it',()=>{const single=fs.readFileSync(new URL('../scripts/configure-domain.sh',import.meta.url),'utf8'),split=fs.readFileSync(new URL('../scripts/configure-local-domain.sh',import.meta.url),'utf8');
  // configure-domain.sh establishes a single-domain panel, so it must clear LOCAL_PROXY_BASE_URL,
  // otherwise a panel that was once split keeps splitDomains=true against a proxy host Nginx no longer
  // serves (node requests on the panel domain then 404). The split wizard re-sets it right after.
  assert.match(single,/set_env LOCAL_PROXY_BASE_URL ""/);
  assert.match(single,/set_env PUBLIC_BASE_URL "https:\/\/\$DOMAIN"/);
  assert.match(split,/set_env LOCAL_PROXY_BASE_URL "https:\/\/\$PROXY_DOMAIN"/);});
test('new-node drawer can pick a deploy agent so the created address uses that machine domain',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  assert.match(html,/id="deploy-agent"/);assert.match(html,/id="deploy-agent-field"/);
  assert.match(js,/populateDeployAgents/);assert.match(js,/agentId:value\('#deploy-agent'\)/);
  // create endpoint deploys onto the chosen agent so credentialsFor()/routeBaseUrl uses its domain
  assert.match(server,/deployAgentId/);assert.match(server,/deploymentId\(deployAgentId,r\.id\)/);});
test('agent container recreate recovers from a port held by a stale container instead of going offline',()=>{const upgrade=fs.readFileSync(new URL('../scripts/agent-upgrade.sh',import.meta.url),'utf8'),install=fs.readFileSync(new URL('../scripts/agent-install.sh',import.meta.url),'utf8'),cli=fs.readFileSync(new URL('../scripts/aegis-relay-agent',import.meta.url),'utf8');
  // --force-recreate stops the old container first, so an unrecovered "port is already allocated"
  // failure leaves the machine with NO agent and offline in the panel. Every path that recreates the
  // container must clean up the stale container and retry.
  for(const [name,script] of [['agent-upgrade.sh',upgrade],['agent-install.sh',install],['aegis-relay-agent',cli]]){
    assert.match(script,/--remove-orphans/,`${name} should prune orphan containers`);
    assert.match(script,/docker ps -aq --filter name=aegis-relay-agent/,`${name} should find the stale container`);
    assert.match(script,/docker rm -f \$STALE/,`${name} should force-remove the stale container`);
    // Removing containers does not free a leaked docker-proxy: it holds the port with no container
    // attached, so the process itself must be reaped — scoped to this agent's own published address.
    assert.match(script,/free_agent_port/,`${name} should reap a leaked docker-proxy`);
    assert.match(script,/-host-port 8080 /,`${name} should match only port 8080 proxies`);
    assert.match(script,/-host-ip \$PUB /,`${name} should match only its own publish address`);
    assert.match(script,/systemctl restart docker/,`${name} should tell the operator the last resort`);
    // Third cause: nothing holds the port but dockerd's own reservation is stale — only a daemon
    // restart clears it. That bounces every container on the host, so it may only happen automatically
    // when this agent is the sole workload; otherwise just instruct the operator.
    assert.match(script,/docker ps -q .*\| head -n1/,`${name} should only auto-restart docker when no other container runs`);
  }});
test('a broken third-party APT repo cannot abort installers or entry reconfiguration',()=>{const files=['../scripts/agent-configure-domain.sh','../scripts/agent-configure-ip.sh','../scripts/configure-domain.sh','../scripts/configure-local-domain.sh','../scripts/agent-install.sh','../scripts/bootstrap.sh'];
  for(const file of files){const script=fs.readFileSync(new URL(file,import.meta.url),'utf8');
    // These scripts run under `set -eu`, so a bare `apt-get update` lets any unrelated dead repo on the
    // machine (e.g. a 402 from a third-party source) abort the whole install/reconfigure.
    assert.doesNotMatch(script,/^\s*apt-get update\s*$/m,`${file} must not let apt-get update abort the script`);
    assert.match(script,/apt-get update \|\| echo/,`${file} should warn and continue when apt indexes fail`);
    // The install itself stays fatal, so a genuinely missing package is still a hard error.
    assert.match(script,/apt-get install -y/,`${file} should still install packages`);}
  // A failed entry reconfiguration must be reported, not swallowed by `|| true`.
  const upgrade=fs.readFileSync(new URL('../scripts/agent-upgrade.sh',import.meta.url),'utf8');
  assert.doesNotMatch(upgrade,/agent-configure-(ip|domain)\.sh[^\n]*\|\| true/,'upgrade must not silently swallow a failed entry reconfigure');
  assert.match(upgrade,/Nginx 仍沿用旧配置/,'upgrade should warn that the new Nginx tuning was not applied');});
test('agent cards can be renamed and reordered from the panel',()=>{const js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('../web/style.css',import.meta.url),'utf8'),server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  // rename: the PATCH endpoint already accepted a name, the card just had no field for it
  assert.match(js,/class="agent-name"/);
  assert.match(js,/JSON\.stringify\(\{name,routeIds\}\)/);
  assert.match(js,/机器名称不能为空/);
  // the name is edited in place on the card title, not in a separate labelled row
  assert.match(js,/<h3><input class="agent-name"/);
  assert.doesNotMatch(js,/<label>机器名称/);
  // reorder: drag the card by a handle, same interaction as the node table
  assert.match(js,/bindAgentDrag/);assert.match(js,/persistAgentOrder/);
  assert.match(js,/dragAgentId/);
  assert.doesNotMatch(js,/move-up|move-down/);
  assert.match(css,/\.agent-card\.dragging/);
  assert.match(css,/\.agent-card\.drop-above/);
  // the status dot is drawn with h3:before, so the h3 must survive the inline input
  assert.match(css,/\.agent-card \.node-card-head h3:before/);
  // server must accept and return the order, and list machines by it
  assert.match(server,/agent\.sortOrder=numeric\(b\.sortOrder,-10000,10000\)/);
  assert.match(server,/agentView\)\.sort\(\(a,b\)=>a\.sortOrder-b\.sortOrder\)/);});
test('compose files stay parseable by docker-compose v1 and a bad one can never destroy a running agent',()=>{
  // Debian 11 ships docker-compose 1.25, which parses a file WITHOUT `version:` as the ancient v1
  // format (top-level keys = service names) and errors out on `services:`.
  for(const file of ['../compose.agent.yml','../compose.yml']){const yml=fs.readFileSync(new URL(file,import.meta.url),'utf8');
    assert.match(yml,/^version: "3\.7"$/m,`${file} must declare a compose file format version`);
    assert.match(yml,/^services:$/m,`${file} must still define services`);}
  const upgrade=fs.readFileSync(new URL('../scripts/agent-upgrade.sh',import.meta.url),'utf8');
  // The new compose file must be parse-checked and rolled back BEFORE any container is touched.
  assert.match(upgrade,/compose\.agent\.yml\.bak/,'upgrade should back up the live compose file');
  assert.match(upgrade,/if ! compose config >\/dev\/null 2>&1; then/,'upgrade should validate the new compose file');
  assert.ok(upgrade.indexOf('compose config')<upgrade.indexOf('agent_up --force-recreate'),'validation must run before the container is recreated');
  // Container removal is only ever correct for a stuck port; every other failure must leave the
  // running agent alone (an unparseable compose file previously destroyed healthy agents).
  for(const [name,file] of [['agent-upgrade.sh','../scripts/agent-upgrade.sh'],['agent-install.sh','../scripts/agent-install.sh'],['aegis-relay-agent','../scripts/aegis-relay-agent']]){
    const script=fs.readFileSync(new URL(file,import.meta.url),'utf8');
    assert.match(script,/\*"port is already allocated"\*\|\*"ddress already in use"\*\) ;;/,`${name} should only clean up on a port conflict`);
    assert.match(script,/已保留现有容器、不做任何清理/,`${name} should say it kept the container`);}});
test('compose files avoid default-value interpolation that older docker-compose rejects',()=>{
  const strip=t=>t.split('\n').filter(l=>!l.trim().startsWith('#')).join('\n');
  const agent=strip(fs.readFileSync(new URL('../compose.agent.yml',import.meta.url),'utf8'));
  const panel=strip(fs.readFileSync(new URL('../compose.yml',import.meta.url),'utf8'));
  // Old docker-compose builds (Debian 11 ships 1.25.x) have been reported to fail on ${VAR:-default}
  // with "Invalid interpolation format". Never use that form in a shipped compose file.
  for(const [name,text] of [['compose.agent.yml',agent],['compose.yml',panel]])
    assert.doesNotMatch(text,/\$\{[^}]*:-/,`${name} must not use default-value interpolation`);
  // The agent's values are constants in practice, so its file needs no interpolation at all.
  assert.doesNotMatch(agent,/\$\{/, 'compose.agent.yml should be free of variable interpolation');
  assert.match(agent,/- "127\.0\.0\.1:8080:8080"/);
  // The panel's publish IPs genuinely change (0.0.0.0 before HTTPS -> 127.0.0.1 after), so they stay
  // variables — which means the installer must guarantee they exist, or they would resolve to empty.
  assert.match(panel,/\$\{PROXY_PUBLISH_IP\}/);assert.match(panel,/\$\{ADMIN_PUBLISH_IP\}/);
  const boot=fs.readFileSync(new URL('../scripts/bootstrap.sh',import.meta.url),'utf8');
  assert.match(boot,/ensure_env ADMIN_PUBLISH_IP/);assert.match(boot,/ensure_env PROXY_PUBLISH_IP/);
  assert.ok(boot.indexOf('ensure_env PROXY_PUBLISH_IP')<boot.indexOf('docker compose up -d --build'),'defaults must be ensured before compose runs');});

// A management-only panel machine has no proxy domain of its own, so the request that saves its
// deployed nodes must not carry `domain` — otherwise the server's local-agent domain validation
// ("代理域名不能与面板域名相同" / "本机代理域名不能为空") rejects the whole PATCH and the node
// selection is silently discarded, leaving the panel machine permanently serving every node.
test('deploying nodes and switching the proxy domain are separate agent-card actions',()=>{
  const js=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),
        css=fs.readFileSync(new URL('../web/style.css',import.meta.url),'utf8');
  const save=js.match(/\.save-agent'\)\.onclick=async\(\)=>\{[\s\S]*?\};\n/);
  assert.ok(save,'the agent card must keep a .save-agent handler');
  assert.match(save[0],/routeIds/);
  assert.doesNotMatch(save[0],/domain/,'saving nodes must not submit the proxy domain');
  assert.doesNotMatch(save[0],/watchDomainSwitch/);
  const swap=js.match(/\.switch-domain'\);if\(switchDomain\)switchDomain\.onclick=async\(\)=>\{[\s\S]*?\};\n/);
  assert.ok(swap,'the proxy domain must have its own button');
  assert.match(swap[0],/JSON\.stringify\(\{domain\}\)/,'the domain button submits only the domain');
  assert.doesNotMatch(swap[0],/routeIds/);
  assert.match(swap[0],/watchDomainSwitch/);
  assert.match(js,/class="btn ghost switch-domain"/);
  assert.doesNotMatch(js,/save-agent" \$\{working\?'disabled':''\}/,'a pending domain switch must not block node deployment');
  assert.match(css,/\.agent-domain-row/);
});

// The deploy-target selector must be exclusive: if every new node were also deployed to the panel
// machine, a management-only panel would silently re-acquire every node and the operator would have
// to uncheck it again after every create. The panel stays as the fallback only when nothing usable
// was picked — a remote agent with no domain/IP yet cannot serve the client address it would hand out.
test('a picked remote agent becomes the sole deploy target for a new node',()=>{
  const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8'),
        html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const create=server.match(/rel === '\/routes'\) \{[\s\S]*?route\.created[^\n]*\n/);
  assert.ok(create,'the POST /routes handler must be findable');
  assert.match(create[0],/const deployAgentId=String\(b\.agentId\|\|''\),deployAgent=/);
  assert.match(create[0],/if\(!deployAgent\|\|!agentEntryUrl\(deployAgent\)\)ensureLocalDeployment/);
  assert.doesNotMatch(create[0],/routes\.push\(r\);ensureLocalDeployment/,'local must no longer be unconditional');
  assert.match(server,/import \{ agentEntryUrl,/);
  assert.match(html,/面板本机不会再跟着开一份/);
});
