/**
 * Packaging tests.
 *
 * These guard the failure mode that already bit this plugin once: `files` in
 * package.json enumerated host modules one by one, `lib/generate.js` was added
 * later and never listed, and the tarball shipped without it — so `lib/index.js`
 * imported a module that was not in the package. A clean install would have died
 * at boot while the dev copy kept working, because it had been hand-copied.
 *
 * The check is deliberately about the *packlist*, not about the source tree:
 * what matters is what npm actually ships.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))

/** Read the plugin's package.json. */
async function readManifest() {
  return JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
}

/**
 * Ask npm what it would ship, without writing a tarball.
 * @returns the shipped paths relative to the package root.
 */
function packlist() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
    shell: true,
  })
  const parsed = JSON.parse(raw)
  return parsed[0].files.map((entry) => entry.path.replaceAll('\\', '/'))
}

test('every relative import in the host half is in the published file list', async () => {
  const shipped = new Set(packlist())
  const entries = await readdir(join(packageDir, 'lib'))
  const missing = []

  for (const entry of entries.filter((name) => name.endsWith('.js'))) {
    const source = await readFile(join(packageDir, 'lib', entry), 'utf8')
    for (const match of source.matchAll(/from\s+'\.\/([^']+)'/gu)) {
      const target = `lib/${match[1]}`
      if (!shipped.has(target)) missing.push(`${entry} imports ${target}`)
    }
  }

  assert.deepEqual(missing, [], `modules imported but not published:\n${missing.join('\n')}`)
})

test('the contract snapshot the host half reads at runtime is published', async () => {
  // `readSnapshot()` resolves '../contract/snapshot.json' at call time; if it
  // were absent the API status line would silently degrade to "unknown".
  assert.equal(packlist().includes('contract/snapshot.json'), true)
})

test('the browser half and its bundle patch are published', () => {
  const shipped = packlist()
  assert.equal(shipped.includes('lib/client.js'), true)
  assert.equal(shipped.includes('cordis.patch.yml'), true)
})

test('the manifest declares the client half the way the platform expects', async () => {
  const manifest = await readManifest()
  assert.equal(manifest.dsh.client.platform, 'web')
  // Exported so dsh-client-modules can resolve the prebuilt classic script.
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  // No version pinning: a DSH release must not invalidate the plugin (§16.1).
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-tools'].optional, true)
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/cordis'].optional, true)
})

test('the browser half has no bare import outside the frozen module table', async () => {
  // Only the nine frozen platform modules are requireable in the browser half;
  // a stray bare import would throw at load and paint a failure card.
  const FROZEN = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ])
  const source = await readFile(join(packageDir, 'lib', 'client.js'), 'utf8')
  const required = [...source.matchAll(/require\('([^']+)'\)/gu)].map((match) => match[1])
  const stray = required.filter((name) => !FROZEN.has(name))
  assert.deepEqual(stray, [])
})