import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dataPlaneScripts=[
  'scripts/agent-configure-domain.sh',
  'scripts/agent-configure-ip.sh',
  'scripts/configure-domain.sh',
  'scripts/configure-local-domain.sh'
];

test('every generated Nginx data plane has reusable upstreams and a valid large unbuffered read window',()=>{
  for(const file of dataPlaneScripts){
    const source=fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
    assert.match(source,/upstream aegis_(?:agent|relay)_backend \{/);
    assert.match(source,/keepalive 64;/);
    assert.ok(source.includes('map \\$http_upgrade '));
    assert.ok(source.includes("{ default upgrade; '' ''; }"));
    for(const directive of ['proxy_buffering off;','proxy_set_header Range \\$http_range;','proxy_set_header If-Range \\$http_if_range;','proxy_max_temp_file_size 0;','proxy_buffer_size 256k;','proxy_buffers 4 256k;','proxy_busy_buffers_size 512k;','proxy_ignore_headers X-Accel-Buffering X-Accel-Limit-Rate;','proxy_socket_keepalive on;','proxy_limit_rate 0;','limit_rate 0;','send_timeout 3600s;'])assert.ok(source.includes(directive),`${file} is missing ${directive}`);
  }
});
