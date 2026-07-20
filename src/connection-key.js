export function customConnectionKey(value) {
  const custom = String(value || '').trim();
  if (!custom) return '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(custom)) {
    throw new Error('自定义连接密码必须为 8–64 位，只能包含字母、数字、下划线和连字符');
  }
  return custom;
}
