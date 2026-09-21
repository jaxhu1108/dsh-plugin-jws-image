/**
 * dsh-plugin-jws-image — host half.
 *
 * Registers the `jws_generate_image` tool and the /api/jws-image/* routes the
 * browser half talks to. Every JWS request is made here, so the API key never
 * reaches the browser.
 *
 * @module dsh-plugin-jws-image
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** Plugin name reported by the loader. */
const name = 'tool-jws-image'
/** The tool registry is the one service this plugin cannot work without. */
const inject = ['tools']

/**
 * Register the tool and the browser-facing routes.
 * @param ctx - the Cordis plugin context.
 * @param rawConfig - the loader-supplied plugin config.
 */
function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}
  ctx.tools.register(defineTool({
    name: 'jws_generate_image',
    description: 'Generate images through the JWS image API (image.aijws.com). '
      + 'Quotes the price first, refuses to exceed the configured budget, then submits, '
      + 'polls and downloads. The result reports the actual cost and the API contract freshness.',
    parameters: {
      prompt: { type: 'string', description: 'The image prompt.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
    },
    async execute() {
      return { status: 'not-implemented', message: 'scaffold only' }
    },
  }))
}

export { apply, inject, name }