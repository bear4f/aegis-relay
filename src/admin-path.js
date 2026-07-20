const ROOT_STATIC_PATHS = new Set(['/', '/index.html', '/app.js', '/style.css', '/help.css']);

export function normalizeAdminPath(value) {
  const clean = String(value ?? '_aegis').replace(/^\/+|\/+$/g, '');
  return clean ? `/${clean}` : '/';
}

export function adminRelative(pathname, prefix) {
  if (prefix === '/') return pathname || '/';
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length) || '/';
}

export function isRootAdminRequest(pathname) {
  return ROOT_STATIC_PATHS.has(pathname) || pathname.startsWith('/api/');
}
