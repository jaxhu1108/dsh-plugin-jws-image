/**
 * dsh-plugin-jws-image — browser half.
 *
 * A hand-written classic script: DSH ships no bundler and serves this file
 * verbatim, so this IS the source. Only the frozen platform modules are
 * requireable; everything is guarded because the module table is a contract
 * that can change between DSH releases.
 *
 * REGISTRATION SHAPE — the part that is easy to get wrong:
 * a slot is a *declaration* owned by whatever renders it. `slots.register()`
 * throws `slot "<name>" is not declared` unless a parent entry's children table
 * has already declared that slot. The supported way to register into a slot we
 * do not own is `slots.inject(name, () => slots.register(...))`, which runs the
 * callback immediately when the declaration already exists and otherwise waits
 * for it (re-running it on every re-declaration). Calling `register()` directly
 * at startup both races the declarer and throws into a shell that shows a
 * "Failed to load plugins" card.
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

    /** The one service this browser half cannot work without. */
    const inject = ['slots']

    /**
     * Slot candidates, best first — the entry lands in the first candidate that
     * is declared. A renamed slot degrades to "the UI is missing" instead of
     * breaking the plugin; the host half keeps the agent tool either way.
     */
    const SLOT_CANDIDATES = [
      'conversation.composer.dock',
      'conversation.input.right',
      'conversation.input.left',
    ]

    /** Our cell key. An id of our own is added beside the shipped entries. */
    const ENTRY_ID = 'jws-image'
    /** Sort position among the entries of the chosen slot. */
    const ENTRY_ORDER = 100

    /** Inline styling, so the entry never depends on DSH's internal CSS. */
    const BUTTON_STYLE = {
      appearance: 'none',
      border: '1px solid currentColor',
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '1.4',
      opacity: 0.7,
      padding: '2px 8px',
    }

    /**
     * The dock entry.
     *
     * The generation window is Phase 2; this first cut only has to prove the
     * entry renders and responds to a click, which is the Phase 0 gate.
     */
    function JwsImageEntry() {
      const [open, setOpen] = React.useState(false)
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'jws-image-entry',
          style: BUTTON_STYLE,
          title: 'JWS 生图',
          onClick: () => setOpen((value) => !value),
        },
        open ? 'JWS 生图（窗口待实现）' : 'JWS 生图',
      )
    }

    /**
     * Register the dock entry into the first declared candidate slot.
     *
     * Only one candidate may win. `inject` runs its callback synchronously for a
     * slot that is already declared, and the candidates are awaited best-first,
     * so the preferred slot claims the entry whenever it is available. The other
     * candidates stay subscribed but register nothing, which also means a
     * fallback does not appear later if the preferred slot disappears — an
     * acceptable degradation for a dock entry.
     *
     * @param ctx - the Cordis client context.
     */
    function apply(ctx) {
      try {
        const slots = ctx?.slots
        if (slots === undefined) return
        if (typeof slots.register !== 'function') return
        // Without the declaration-aware API there is no supported way to
        // register into a slot we do not own, so degrade to "no UI" rather than
        // calling register() and throwing into the shell's startup path.
        if (typeof slots.inject !== 'function') return
        if (React === null) return

        let claimed

        for (const slot of SLOT_CANDIDATES) {
          slots.inject(slot, () => {
            if (claimed !== undefined) return undefined
            const dispose = slots.register(
              { name: slot, id: ENTRY_ID, order: ENTRY_ORDER, label: 'JWS 生图' },
              JwsImageEntry,
            )
            claimed = slot
            return () => {
              claimed = undefined
              if (typeof dispose === 'function') dispose()
            }
          })
        }
      } catch {
        // The browser half must never throw: a throwing plugin paints a
        // "Failed to load plugins" card over the whole shell.
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})