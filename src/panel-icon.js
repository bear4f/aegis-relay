import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { guardedLookup } from './lookup.js';
import { isPrivateIP } from './security.js';

export const MAX_ICON_BYTES = 256 * 1024;
// Aliased vendor MIME types collapse to one canonical value so the stored icon stays predictable.
const ICON_TYPES = new Map([
  ['image/png', 'image/png'], ['image/jpeg', 'image/jpeg'], ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'], ['image/svg+xml', 'image/svg+xml'],
  ['image/x-icon', 'image/x-icon'], ['image/vnd.microsoft.icon', 'image/x-icon'],
]);

export function normalizePanelIcon(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new Error('图标必须是 base64 编码的图片数据');
  const mime = ICON_TYPES.get(match[1].toLowerCase());
  if (!mime) throw new Error('仅支持 PNG、JPG、GIF、WebP、SVG 或 ICO 格式的图标');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length) throw new Error('图标内容为空');
  if (bytes.length > MAX_ICON_BYTES) throw new Error('图标不能超过 256KB');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export function fetchPanelIcon(target, { timeout = 10_000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let url; try { url = new URL(String(target || '')); } catch { return reject(new Error('图片地址无效')); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return reject(new Error('图片地址必须是 http(s) 链接'));
    if (url.username || url.password) return reject(new Error('图片地址不能包含账号信息'));
    // Literal IP hosts never reach dns.lookup, so the guarded resolver alone cannot stop them.
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal) && isPrivateIP(literal)) return reject(new Error('该地址指向受保护的内网地址，已拒绝'));
    const transport = url.protocol === 'https:' ? https : http;
    // Same SSRF guard as upstream probing: a hostname resolving to private space is refused.
    const req = transport.request(url, { method: 'GET', headers: { accept: 'image/*', 'user-agent': 'AegisRelay-Icon/1' }, timeout, lookup: guardedLookup(false) }, res => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('图片地址重定向次数过多'));
        let next; try { next = new URL(res.headers.location, url); } catch { return reject(new Error('图片地址重定向无效')); }
        return resolve(fetchPanelIcon(next.href, { timeout, redirects: redirects - 1 }));
      }
      if (status !== 200) { res.resume(); return reject(new Error(`图片下载失败（HTTP ${status}）`)); }
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const mime = ICON_TYPES.get(type);
      if (!mime) { res.resume(); return reject(new Error('该地址返回的不是支持的图片格式')); }
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > MAX_ICON_BYTES) { req.destroy(); reject(new Error('图标不能超过 256KB')); } else chunks.push(chunk); });
      res.on('end', () => { if (!size) return reject(new Error('图片内容为空')); if (size <= MAX_ICON_BYTES) resolve(`data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`); });
      res.on('error', () => reject(new Error('图片下载中断')));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', err => {
      const message = String(err?.message || '').toLowerCase();
      if (message.includes('blocked address')) return reject(new Error('该地址解析到受保护的内网地址，已拒绝'));
      if (String(err?.code || '') === 'ETIMEDOUT' || message.includes('timeout')) return reject(new Error('图片下载超时'));
      reject(new Error('图片下载失败，请检查地址和网络'));
    });
    req.end();
  });
}
