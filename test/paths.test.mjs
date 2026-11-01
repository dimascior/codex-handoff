import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pathIdentity } from '../lib/paths.mjs';

test('path identity: one Windows file in every spelling Codex and manual runs use', () => {
  const identity = 'c:\\users\\accountname\\.codex\\sessions\\r.jsonl';
  assert.equal(pathIdentity('\\\\?\\C:\\Users\\accountName\\.codex\\sessions\\r.jsonl'), identity, 'extended-length prefix');
  assert.equal(pathIdentity('C:/Users/accountName/.codex/sessions/r.jsonl'), identity, 'forward slashes');
  assert.equal(pathIdentity('c:\\USERS\\accountName\\.codex\\x\\..\\sessions\\.\\r.jsonl'), identity, 'case, . and ..');
  assert.equal(pathIdentity('\\\\?\\UNC\\host\\share\\r.jsonl'), '\\\\host\\share\\r.jsonl', 'extended UNC');
  assert.equal(pathIdentity('//host/share/r.jsonl'), '\\\\host\\share\\r.jsonl', 'UNC with forward slashes');
  assert.equal(pathIdentity('/home/Me/./R.jsonl'), '/home/Me/R.jsonl', 'non-Windows paths keep their case');
  assert.equal(pathIdentity(null), null);
});
