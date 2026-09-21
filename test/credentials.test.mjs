import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isValidKey, readApiKey, writeApiKey } from '../lib/credentials.js'

test('accepts only jws_live_ keys', () => {
  assert.equal(isValidKey('jws_live_abc'), true)
  assert.equal(isValidKey('sk-abc'), false)
  assert.equal(isValidKey(''), false)
  assert.equal(isValidKey(undefined), false)
})

test('environment wins over the config file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jws-cred-'))
  try {
    await writeApiKey(dir, 'jws_live_fromfile')
    const key = await readApiKey({ env: { JWS_API_KEY: 'jws_live_fromenv' }, configDir: dir })
    assert.equal(key, 'jws_live_fromenv')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('falls back to the config file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jws-cred-'))
  try {
    await writeApiKey(dir, 'jws_live_fromfile')
    const key = await readApiKey({ env: {}, configDir: dir })
    assert.equal(key, 'jws_live_fromfile')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('missing everything yields undefined, not a throw', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jws-cred-'))
  try {
    const key = await readApiKey({ env: {}, configDir: dir })
    assert.equal(key, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeApiKey refuses an invalid key and writes 0600 otherwise', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jws-cred-'))
  try {
    await assert.rejects(() => writeApiKey(dir, 'sk-nope'), /jws_live_/u)
    await writeApiKey(dir, 'jws_live_ok')
    const written = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
    assert.equal(written.apiKey, 'jws_live_ok')
    // Windows cannot represent 0600: chmod() there only toggles the read-only
    // attribute (write 0600 lands as 0666, chmod 000 as 0444). The assertion is
    // therefore POSIX-only; `restricts the key file to owner-only permissions`
    // below proves the mode is genuinely requested on every platform.
    if (process.platform !== 'win32') {
      const mode = (await stat(join(dir, 'config.json'))).mode & 0o777
      assert.equal(mode, 0o600)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('restricts the key file to owner-only permissions', async () => {
  const source = await readFile(new URL('../lib/credentials.js', import.meta.url), 'utf8')
  assert.match(source, /mode:\s*0o600/u, 'the key file must be created 0600')
  assert.match(source, /chmod\(target,\s*0o600\)/u, 'and re-tightened after the write')
})