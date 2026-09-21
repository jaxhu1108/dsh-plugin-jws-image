/**
 * Credential handling, shared with the jws-api-demo skill.
 *
 * Resolution order is the environment, then `~/.config/jws-image/config.json`.
 * The key is read and written only here, on the host: the OpenAPI security
 * scheme forbids putting it in browser storage or client logs.
 *
 * @module dsh-plugin-jws-image/credentials
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Config directory shared with the skill. */
const CONFIG_DIR_NAME = '.config/jws-image'
/** File inside that directory. */
const CONFIG_FILE_NAME = 'config.json'

/**
 * Default config directory for a home directory.
 * @param home - the user's home directory.
 * @returns the absolute config directory.
 */
function resolveConfigDir(home) {
  return join(home, CONFIG_DIR_NAME)
}

/**
 * Whether a string looks like a JWS cloud API key.
 * @param key - the candidate value.
 * @returns true when it carries the documented prefix.
 */
function isValidKey(key) {
  return typeof key === 'string' && key.startsWith('jws_live_')
}

/**
 * Resolve the API key for one call. Never cached: a key stored after boot must
 * be picked up by the next call.
 * @param options - the environment and config directory to read.
 * @returns the key, or `undefined` when nothing is configured.
 */
async function readApiKey(options) {
  const { env, configDir } = options
  const fromEnv = env?.JWS_API_KEY
  if (isValidKey(fromEnv)) return fromEnv
  try {
    const parsed = JSON.parse(await readFile(join(configDir, CONFIG_FILE_NAME), 'utf8'))
    return isValidKey(parsed?.apiKey) ? parsed.apiKey : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist a key for the plugin and the skill alike.
 * @param configDir - the directory to write into.
 * @param key - the key to store.
 * @throws when the key does not carry the documented prefix.
 */
async function writeApiKey(configDir, key) {
  if (!isValidKey(key)) throw new Error('请填写生图站创建的 jws_live_ 密钥')
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  const target = join(configDir, CONFIG_FILE_NAME)
  await writeFile(target, JSON.stringify({ apiKey: key }), { mode: 0o600 })
  await chmod(target, 0o600)
}

export { CONFIG_FILE_NAME, isValidKey, readApiKey, resolveConfigDir, writeApiKey }