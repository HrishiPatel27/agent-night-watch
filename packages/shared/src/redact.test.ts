import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactValue, summarizeToolInput, digest } from './redact.js';

test('redacts common token shapes', () => {
  const s = 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and AKIAABCDEFGHIJKLMNOP ghp_abcdefghijklmnopqrstuvwxyz0123';
  const r = redactText(s);
  assert.ok(!r.includes('sk-ant-api03'));
  assert.ok(!r.includes('AKIAABCDEFGHIJKLMNOP'));
  assert.ok(!r.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'));
});

test('redacts KEY=VALUE assignments but keeps the key', () => {
  const r = redactText('export DATABASE_PASSWORD=hunter22 && echo ok');
  assert.equal(r, 'export DATABASE_PASSWORD=[REDACTED] && echo ok');
});

test('redacts url credentials but keeps host', () => {
  const r = redactText('psql postgres://admin:s3cret@db.example.com:5432/app');
  assert.equal(r, 'psql postgres://admin:[REDACTED]@db.example.com:5432/app');
});

test('redacts private key blocks', () => {
  const r = redactText('x -----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- y');
  assert.equal(r, 'x [REDACTED] y');
});

test('redactValue masks secret-looking keys entirely', () => {
  const v = redactValue({ api_key: 'abc', nested: { token: 'zzz', name: 'fine' } });
  assert.deepEqual(v, { api_key: '[REDACTED]', nested: { token: '[REDACTED]', name: 'fine' } });
});

test('summaries are redacted and bounded', () => {
  const s = summarizeToolInput('Bash', { command: `curl -H "Authorization: Bearer abcdefghijklmnop" https://x.test ${'a'.repeat(1000)}` });
  assert.ok(!s.includes('abcdefghijklmnop'));
  assert.ok(s.length <= 401);
});

test('digest is stable', () => {
  assert.equal(digest({ a: 1 }), digest({ a: 1 }));
  assert.equal(digest('x').length, 16);
});
