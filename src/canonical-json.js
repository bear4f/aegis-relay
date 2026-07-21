function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function canonicalJson(value) {
  const active=new Set();
  const encode=current=>{
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('canonical JSON requires finite numbers');
      return JSON.stringify(Object.is(current,-0)?0:current);
    }
    if (typeof current !== 'object') throw new TypeError(`canonical JSON does not support ${typeof current}`);
    if (active.has(current)) throw new TypeError('canonical JSON does not support cycles');
    active.add(current);
    try {
      if (Array.isArray(current)) {
        const values=[];
        for(let i=0;i<current.length;i++){
          if(!(i in current))throw new TypeError('canonical JSON does not support sparse arrays');
          values.push(encode(current[i]));
        }
        return `[${values.join(',')}]`;
      }
      const prototype=Object.getPrototypeOf(current);
      if(prototype!==Object.prototype&&prototype!==null)throw new TypeError('canonical JSON requires plain objects');
      if(Object.getOwnPropertySymbols(current).length)throw new TypeError('canonical JSON does not support symbol keys');
      return `{${Object.keys(current).sort(compareUtf8).map(key=>`${JSON.stringify(key)}:${encode(current[key])}`).join(',')}}`;
    } finally { active.delete(current); }
  };
  return encode(value);
}
