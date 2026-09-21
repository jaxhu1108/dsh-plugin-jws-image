/**
 * dsh-plugin-jws-image — browser half.
 *
 * A hand-written classic script: DSH ships no bundler and serves this file
 * verbatim, so this IS the source. Only the nine frozen platform modules are
 * requireable; everything is guarded because the module table is a contract
 * that can change between DSH releases.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-jws-image',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let React
    try {
      React = require('react')
    } catch {
      React = null
    }

    /** Slot candidates, best first. A renamed slot degrades instead of breaking. */
    const SLOT_CANDIDATES = [
      'conversation.composer.dock',
      'conversation.input.right',
      'conversation.input.left',
    ]

    /** Dock entry + (later) the generation window. */
    function JwsImageEntry() {
      const [open, setOpen] = React.useState(false)
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'jws-image-entry',
          onClick: () => setOpen((value) => !value),
        },
        open ? 'JWS 生图（窗口待实现）' : 'JWS 生图',
      )
    }

    /**
     * Register the composer-dock entry.
     * @param ctx - the Cordis client context.
     */
    function apply(ctx) {
      try {
        const slots = ctx?.slots
        if (slots === undefined || typeof slots.register !== 'function') return
        if (React === null) return
        for (const slot of SLOT_CANDIDATES) {
          try {
            slots.register({ name: slot, id: 'jws-image', order: 100 }, JwsImageEntry)
            return
          } catch {
            // Try the next candidate; a missing slot is not fatal.
          }
        }
      } catch {
        // The browser half must never throw: a throwing plugin paints a
        // "Failed to load plugins" card over the whole shell.
      }
    }

    exports.apply = apply
    return module.exports
  },
})