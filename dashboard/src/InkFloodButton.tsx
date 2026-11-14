import * as React from "react"
import { motion, useReducedMotion } from "framer-motion"

type Props = { label?: string; variant?: "dark" | "light" }
type Ripple = { id: number; x: number; y: number }
type InteractionEvent = React.PointerEvent<HTMLSpanElement> | React.MouseEvent<HTMLSpanElement>

/** Portfolio InkButtons interaction adapted to the gateway's native action. */
export default function InkFloodButton({ label = "Add key", variant = "dark" }: Props) {
  const [active, setActive] = React.useState(false)
  const [origin, setOrigin] = React.useState({ x: 50, y: 50 })
  const [magnet, setMagnet] = React.useState({ x: 0, y: 0 })
  const [ripples, setRipples] = React.useState<Ripple[]>([])
  const nextRipple = React.useRef(0)
  const reduceMotion = useReducedMotion()

  const locate = (event: InteractionEvent) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100))
    const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100))
    setOrigin({ x, y })
    setMagnet({
      x: Math.max(-8, Math.min(8, (x - 50) * 0.16)),
      y: Math.max(-8, Math.min(8, (y - 50) * 0.16)),
    })
  }

  const ripple = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (reduceMotion) return
    const rect = event.currentTarget.getBoundingClientRect()
    const next = { id: ++nextRipple.current, x: event.clientX - rect.left, y: event.clientY - rect.top }
    setRipples((items) => [...items.slice(-2), next])
    window.setTimeout(() => setRipples((items) => items.filter((item) => item.id !== next.id)), 800)
  }

  return (
    <motion.span
      className={`ink-button-content${active ? " is-active" : ""}${variant === "light" ? " is-light" : ""}`}
      tabIndex={-1}
      animate={reduceMotion ? undefined : { x: magnet.x, y: magnet.y }}
      transition={{ duration: 0.28, ease: [0.19, 1, 0.22, 1] }}
      onPointerEnter={(event) => { locate(event); setActive(true) }}
      onPointerMove={locate}
      onPointerLeave={() => { setActive(false); setMagnet({ x: 0, y: 0 }) }}
      onMouseEnter={(event) => { locate(event); setActive(true) }}
      onMouseOver={(event) => { locate(event); setActive(true) }}
      onMouseMove={locate}
      onMouseLeave={() => { setActive(false); setMagnet({ x: 0, y: 0 }) }}
      onPointerDown={ripple}
      whileTap={reduceMotion ? undefined : { scaleX: 1.04, scaleY: 0.92 }}
    >
      <motion.span
        className="ink-button-flood"
        aria-hidden="true"
        animate={{ clipPath: reduceMotion ? "none" : active
          ? `circle(160% at ${origin.x}% ${origin.y}%)`
          : `circle(0% at ${origin.x}% ${origin.y}%)` }}
        transition={{ duration: active ? 0.6 : 0.5, ease: [0.19, 1, 0.22, 1] }}
      />
      {ripples.map((item) => (
        <motion.span
          key={item.id}
          className="ink-button-ripple"
          aria-hidden="true"
          initial={{ x: item.x - 20, y: item.y - 20, scale: 0.2, opacity: 0.65 }}
          animate={{ scale: 2, opacity: 0 }}
          transition={{ duration: 0.76, ease: [0.19, 1, 0.22, 1] }}
        />
      ))}
      <span className="ink-button-label">{label}</span>
    </motion.span>
  )
}
