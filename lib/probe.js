/**
 * Capability probe.
 *
 * DSH is an RC and its optional services come and go between releases. The
 * probe records what this deployment actually offers, so an upgrade that
 * removes something is visible in one log line instead of a runtime mystery.
 *
 * @module dsh-plugin-jws-image/probe
 */

/** Optional services this plugin can use, in the order they matter. */
const OPTIONAL_SERVICES = Object.freeze(['tools', 'connection', 'attachments'])

/**
 * Ask the context which optional services exist.
 * @param ctx - the Cordis plugin context.
 * @returns the resolved services plus a warning per missing one.
 */
function probeCapabilities(ctx) {
  const services = []
  const warnings = []
  for (const service of OPTIONAL_SERVICES) {
    let resolved
    try {
      resolved = ctx.get(service)
    } catch {
      resolved = undefined
    }
    if (resolved === undefined) {
      if (service !== 'tools') warnings.push(`optional service "${service}" is unavailable`)
      continue
    }
    services.push(service)
  }
  return { services, slots: [], warnings }
}

/**
 * Render the probe as a single log line.
 * @param report - the value returned by {@link probeCapabilities}.
 * @returns one line, no newline.
 */
function formatProbe(report) {
  const parts = [`services=${report.services.join(',') || 'none'}`]
  if (report.slots.length > 0) parts.push(`slots=${report.slots.join(',')}`)
  if (report.warnings.length > 0) parts.push(`warnings=${report.warnings.length}`)
  return parts.join(' ')
}

export { formatProbe, probeCapabilities }