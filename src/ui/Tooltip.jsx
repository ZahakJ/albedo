import { useEffect, useRef } from 'react'

// App-wide tooltip singleton, driven by data-tip / data-tip-key attributes.
// One delegated pointerover listener; 400ms arm delay (100ms while "warm" —
// a tip was up within the last 400ms, Lightroom-style toolbar sweeps feel
// instant). Renders label + right-aligned mono shortcut, viewport-clamped.
// Motion rides --t-fast, so reduced-motion collapses it to an instant show.

const DELAY = 400
const WARM = 100
const GAP = 7

export default function TooltipHost() {
  const tipRef = useRef(null)

  useEffect(() => {
    const tip = tipRef.current
    let timer = 0
    let warmUntil = 0
    let target = null

    const hide = () => {
      clearTimeout(timer)
      timer = 0
      if (target) warmUntil = performance.now() + DELAY
      target = null
      tip.classList.remove('is-on')
    }

    const show = (el) => {
      target = el
      const label = el.getAttribute('data-tip')
      const key = el.getAttribute('data-tip-key')
      tip.querySelector('.tip-label').textContent = label
      const keyEl = tip.querySelector('.tip-key')
      keyEl.textContent = key ?? ''
      keyEl.style.display = key ? '' : 'none'
      // measure offscreen, then clamp into the viewport
      tip.style.left = '0px'
      tip.style.top = '-9999px'
      tip.classList.add('is-on')
      const r = el.getBoundingClientRect()
      const tr = tip.getBoundingClientRect()
      let x = r.left + r.width / 2 - tr.width / 2
      x = Math.max(6, Math.min(innerWidth - tr.width - 6, x))
      let y = r.bottom + GAP
      if (y + tr.height > innerHeight - 6) y = r.top - GAP - tr.height
      tip.style.left = `${Math.round(x)}px`
      tip.style.top = `${Math.round(y)}px`
    }

    const onOver = (e) => {
      const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null
      if (!el) { if (target) hide(); return }
      if (el === target) return
      clearTimeout(timer)
      const delay = performance.now() < warmUntil ? WARM : DELAY
      timer = setTimeout(() => show(el), delay)
    }
    const onOut = (e) => {
      const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null
      if (!el) return
      const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-tip]') : null
      if (to !== el) hide()
    }

    addEventListener('pointerover', onOver, true)
    addEventListener('pointerout', onOut, true)
    addEventListener('pointerdown', hide, true)
    addEventListener('keydown', hide, true)
    addEventListener('scroll', hide, true)
    addEventListener('blur', hide)
    return () => {
      clearTimeout(timer)
      removeEventListener('pointerover', onOver, true)
      removeEventListener('pointerout', onOut, true)
      removeEventListener('pointerdown', hide, true)
      removeEventListener('keydown', hide, true)
      removeEventListener('scroll', hide, true)
      removeEventListener('blur', hide)
    }
  }, [])

  return (
    <div ref={tipRef} className="tip" role="tooltip" aria-hidden="true">
      <span className="tip-label" />
      <span className="tip-key mono" />
    </div>
  )
}
