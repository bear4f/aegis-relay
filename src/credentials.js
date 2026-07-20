export function clientCredentials(route, accessKey) {
  if (!accessKey) return { clientPath: `/${route.alias}/` };
  return { accessKey, clientPath: `/${route.alias}/${accessKey}/` };
}

export function savedCredentials(route) {
  if (route.accessMode === 'alias_only') {
    return { available: true, ...clientCredentials(route, '') };
  }
  if (!route.accessKey) return { available: false, requiresRotation: true };
  return { available: true, ...clientCredentials(route, route.accessKey) };
}
