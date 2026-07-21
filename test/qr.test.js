import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMatrix, qrMatrix, qrRows, reedSolomon, syndromes } from '../src/qr.js';

const OTPAUTH = 'otpauth://totp/AegisRelay%3Aadmin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=AegisRelay&digits=6&period=30';

test('reed-solomon output is a valid codeword', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  const ec = reedSolomon(data, 10);
  assert.equal(ec.length, 10);
  assert.deepEqual(syndromes(data.concat(ec), 10), new Array(10).fill(0));
});

test('a generated code carries its payload back', () => {
  const matrix = qrMatrix(OTPAUTH);
  assert.equal(matrix.size, 17 + matrix.version * 4);
  const decoded = decodeMatrix(matrix);
  assert.equal(decoded.mode, 0b0100, 'byte mode');
  assert.equal(decoded.corruptBlocks, 0, 'every block is a valid Reed-Solomon codeword');
  assert.equal(decoded.text, OTPAUTH);
});

test('payloads of many lengths round-trip across versions', () => {
  const seen = new Set();
  for (const length of [8, 20, 40, 60, 80, 100, 120, 150, 180, 210]) {
    const text = 'a'.repeat(length);
    const matrix = qrMatrix(text);
    seen.add(matrix.version);
    const decoded = decodeMatrix(matrix);
    assert.equal(decoded.corruptBlocks, 0, `blocks valid at length ${length}`);
    assert.equal(decoded.text, text, `payload survives at length ${length}`);
  }
  assert.ok(seen.size >= 4, 'exercises several versions');
});

test('function patterns land where a scanner expects them', () => {
  const { modules, size } = qrMatrix(OTPAUTH);
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(modules[row][col], 1, 'finder outer ring');
    assert.equal(modules[row + 1][col + 1], 0, 'finder inner gap');
    assert.equal(modules[row + 3][col + 3], 1, 'finder core');
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, 'horizontal timing');
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, 'vertical timing');
  }
  assert.equal(modules[size - 8][8], 1, 'dark module');
});

test('rows form matches the matrix', () => {
  const { rows, size } = qrRows(OTPAUTH);
  assert.equal(rows.length, size);
  assert.ok(rows.every(row => row.length === size && /^[01]+$/.test(row)));
});

test('oversized payloads are rejected rather than silently truncated', () => {
  assert.throws(() => qrMatrix('x'.repeat(400)), /容量/);
});
