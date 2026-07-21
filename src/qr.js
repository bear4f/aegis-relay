// Minimal QR encoder (byte mode, error correction level M, versions 1-10).
// Only exists so the panel can show a scannable 2FA enrolment code without shipping a third-party
// dependency or calling an external generator with the TOTP secret in the URL.

// [total codewords, EC codewords per block, group1 blocks, group1 data, group2 blocks, group2 data]
const EC_M = {
  1:[26,10,1,16,0,0], 2:[44,16,1,28,0,0], 3:[70,26,1,44,0,0], 4:[100,18,2,32,0,0],
  5:[134,24,2,43,0,0], 6:[172,16,4,27,0,0], 7:[196,18,4,31,0,0], 8:[242,22,2,38,2,39],
  9:[292,22,3,36,2,37], 10:[346,26,4,43,1,44]
};
const ALIGN = {
  1:[], 2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30], 6:[6,34],
  7:[6,22,38], 8:[6,24,42], 9:[6,26,46], 10:[6,28,50]
};
// Bits left over after the codewords, which are placed as zeros.
const REMAINDER = {1:0,2:7,3:7,4:7,5:7,6:7,7:0,8:0,9:0,10:0};

const EXP = new Array(512), LOG = new Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  // Built lowest-degree-first; the division below indexes it leading coefficient first.
  return poly.reverse();
}

export function reedSolomon(data, ecLength) {
  const poly = generatorPoly(ecLength), remainder = new Array(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift(); remainder.push(0);
    if (factor !== 0) for (let i = 0; i < ecLength; i++) remainder[i] ^= mul(poly[i + 1], factor);
  }
  return remainder;
}

// Zero syndromes mean the codeword is a valid Reed-Solomon word; used by the tests.
export function syndromes(codewords, ecLength) {
  const out = [];
  for (let i = 0; i < ecLength; i++) {
    let value = 0;
    for (const byte of codewords) value = mul(value, EXP[i]) ^ byte;
    out.push(value);
  }
  return out;
}

function pickVersion(byteLength) {
  for (let version = 1; version <= 10; version++) {
    const [total, ec, g1b, g1d, g2b, g2d] = EC_M[version];
    const dataCodewords = total - ec * (g1b + g2b);
    const headerBits = 4 + (version <= 9 ? 8 : 16);
    if (dataCodewords * 8 >= headerBits + byteLength * 8) return version;
  }
  throw new Error('内容超出二维码容量');
}

function buildCodewords(bytes, version) {
  const [total, ecLength, g1b, g1d, g2b, g2d] = EC_M[version];
  const dataCodewords = total - ecLength * (g1b + g2b);
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(0b0100, 4);                               // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);     // character count
  for (const byte of bytes) push(byte, 8);
  for (let i = 0; i < 4 && bits.length < dataCodewords * 8; i++) bits.push(0);  // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const pad = [0xec, 0x11];
  for (let i = 0; data.length < dataCodewords; i++) data.push(pad[i % 2]);

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1b; i++) { blocks.push(data.slice(offset, offset + g1d)); offset += g1d; }
  for (let i = 0; i < g2b; i++) { blocks.push(data.slice(offset, offset + g2d)); offset += g2d; }
  const ecBlocks = blocks.map(block => reedSolomon(block, ecLength));

  const interleaved = [];
  const longest = Math.max(...blocks.map(block => block.length));
  for (let i = 0; i < longest; i++) for (const block of blocks) if (i < block.length) interleaved.push(block[i]);
  for (let i = 0; i < ecLength; i++) for (const block of ecBlocks) interleaved.push(block[i]);
  return { codewords: interleaved, ecLength, blocks, ecBlocks };
}

function emptyMatrix(size) {
  return { modules: Array.from({length:size},()=>new Array(size).fill(0)), reserved: Array.from({length:size},()=>new Array(size).fill(false)), size };
}

function placeFunctionPatterns(m, version) {
  const size = m.size;
  const setFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const y = row + r, x = col + c;
      if (y < 0 || y >= size || x < 0 || x >= size) continue;
      const border = r === -1 || r === 7 || c === -1 || c === 7;
      const ring = (r === 0 || r === 6) && c >= 0 && c <= 6;
      const side = (c === 0 || c === 6) && r >= 0 && r <= 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m.modules[y][x] = border ? 0 : (ring || side || core) ? 1 : 0;
      m.reserved[y][x] = true;
    }
  };
  setFinder(0, 0); setFinder(0, size - 7); setFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {                       // timing patterns
    const bit = i % 2 === 0 ? 1 : 0;
    m.modules[6][i] = bit; m.reserved[6][i] = true;
    m.modules[i][6] = bit; m.reserved[i][6] = true;
  }
  for (const row of ALIGN[version]) for (const col of ALIGN[version]) {
    const nearFinder = (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
    if (nearFinder) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
      m.modules[row + r][col + c] = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) ? 1 : 0;
      m.reserved[row + r][col + c] = true;
    }
  }
  m.modules[size - 8][8] = 1; m.reserved[size - 8][8] = true;  // dark module
  for (let i = 0; i < 9; i++) {                                // format info areas
    if (!m.reserved[8][i]) m.reserved[8][i] = true;
    if (!m.reserved[i][8]) m.reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) { m.reserved[8][size - 1 - i] = true; m.reserved[size - 1 - i][8] = true; }
  if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
    m.reserved[i][size - 11 + j] = true; m.reserved[size - 11 + j][i] = true;
  }
}

function bchFormat(value) {
  let rest = value << 10;
  for (let i = 14; i >= 10; i--) if ((rest >> i) & 1) rest ^= 0x537 << (i - 10);
  return ((value << 10) | rest) ^ 0x5412;
}
function bchVersion(version) {
  let rest = version << 12;
  for (let i = 17; i >= 12; i--) if ((rest >> i) & 1) rest ^= 0x1f25 << (i - 12);
  return (version << 12) | rest;
}

function placeFormat(m, mask) {
  const size = m.size, bits = bchFormat((0b00 << 3) | mask);  // 00 = error correction level M
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    if (i < 6) m.modules[8][i] = bit;
    else if (i < 8) m.modules[8][i + 1] = bit;
    else if (i === 8) m.modules[7][8] = bit;
    else m.modules[14 - i][8] = bit;
    if (i < 8) m.modules[8][size - 1 - i] = bit;
    else m.modules[size - 15 + i][8] = bit;
  }
}

function placeVersion(m, version) {
  if (version < 7) return;
  const size = m.size, bits = bchVersion(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1, row = Math.floor(i / 3), col = i % 3;
    m.modules[row][size - 11 + col] = bit;
    m.modules[size - 11 + col][row] = bit;
  }
}

const maskFn = [
  (r,c)=>(r+c)%2===0, (r,c)=>r%2===0, (r,c)=>c%3===0, (r,c)=>(r+c)%3===0,
  (r,c)=>(Math.floor(r/2)+Math.floor(c/3))%2===0, (r,c)=>((r*c)%2)+((r*c)%3)===0,
  (r,c)=>((((r*c)%2)+((r*c)%3))%2)===0, (r,c)=>((((r+c)%2)+((r*c)%3))%2)===0
];

function placeData(m, codewords, version) {
  const size = m.size, bits = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  for (let i = 0; i < REMAINDER[version]; i++) bits.push(0);
  let index = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;                       // skip the vertical timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (m.reserved[row][col]) continue;
        m.modules[row][col] = index < bits.length ? bits[index] : 0;
        index++;
      }
    }
    upward = !upward;
  }
}

function penalty(modules) {
  const size = modules.length; let score = 0;
  const run = line => {
    let total = 0, count = 1;
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i-1]) count++;
      else { if (count >= 5) total += count - 2; count = 1; }
    }
    if (count >= 5) total += count - 2;
    return total;
  };
  for (let i = 0; i < size; i++) { score += run(modules[i]); score += run(modules.map(row => row[i])); }
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = modules[r][c];
    if (v === modules[r][c+1] && v === modules[r+1][c] && v === modules[r+1][c+1]) score += 3;
  }
  const pattern = [1,0,1,1,1,0,1,0,0,0,0], reverse = [0,0,0,0,1,0,1,1,1,0,1];
  const scan = line => {
    let total = 0;
    for (let i = 0; i + 11 <= size; i++) {
      const slice = line.slice(i, i + 11);
      if (pattern.every((v,j)=>v===slice[j]) || reverse.every((v,j)=>v===slice[j])) total += 40;
    }
    return total;
  };
  for (let i = 0; i < size; i++) { score += scan(modules[i]); score += scan(modules.map(row => row[i])); }
  const dark = modules.flat().reduce((sum,v)=>sum+v,0), ratio = dark * 100 / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

export function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const version = pickVersion(bytes.length);
  const { codewords } = buildCodewords(bytes, version);
  const size = 17 + version * 4;
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = emptyMatrix(size);
    placeFunctionPatterns(m, version);
    placeVersion(m, version);
    placeData(m, codewords, version);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (!m.reserved[r][c] && maskFn[mask](r, c)) m.modules[r][c] ^= 1;
    }
    placeFormat(m, mask);
    const score = penalty(m.modules);
    if (!best || score < best.score) best = { score, modules: m.modules, mask, version };
  }
  return { size, version: best.version, mask: best.mask, modules: best.modules };
}

// Compact wire form: one string per row of '0'/'1', cheap for the browser to draw as SVG.
export function qrRows(text) {
  const { modules, size, version } = qrMatrix(text);
  return { size, version, rows: modules.map(row => row.join('')) };
}

// Reverse of qrMatrix. Not used at runtime; it exists so the test suite can prove a generated code
// actually carries the payload (data placement, masking and Reed-Solomon all have to be right).
export function decodeMatrix({ size, version, mask, modules }) {
  const m = emptyMatrix(size);
  placeFunctionPatterns(m, version);
  const grid = modules.map(row => row.slice());
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (!m.reserved[r][c] && maskFn[mask](r, c)) grid[r][c] ^= 1;
  }
  const bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) if (!m.reserved[row][col]) bits.push(grid[row][col]);
    }
    upward = !upward;
  }
  const [total, ecLength, g1b, g1d, g2b, g2d] = EC_M[version];
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length && codewords.length < total; i += 8) {
    codewords.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  }
  const lengths = [...Array(g1b).fill(g1d), ...Array(g2b).fill(g2d)];
  const blocks = lengths.map(() => []), ecBlocks = lengths.map(() => []);
  let index = 0;
  for (let i = 0; i < Math.max(...lengths); i++) {
    for (let b = 0; b < lengths.length; b++) if (i < lengths[b]) blocks[b].push(codewords[index++]);
  }
  for (let i = 0; i < ecLength; i++) for (let b = 0; b < lengths.length; b++) ecBlocks[b].push(codewords[index++]);
  const corrupt = blocks.map((block, b) => syndromes(block.concat(ecBlocks[b]), ecLength))
    .filter(list => list.some(value => value !== 0)).length;
  const data = blocks.flat();
  const stream = [];
  for (const byte of data) for (let i = 7; i >= 0; i--) stream.push((byte >> i) & 1);
  const read = (offset, length) => parseInt(stream.slice(offset, offset + length).join(''), 2);
  const mode = read(0, 4), countBits = version <= 9 ? 8 : 16, length = read(4, countBits);
  const bytes = [];
  for (let i = 0; i < length; i++) bytes.push(read(4 + countBits + i * 8, 8));
  return { mode, corruptBlocks: corrupt, text: Buffer.from(bytes).toString('utf8') };
}
