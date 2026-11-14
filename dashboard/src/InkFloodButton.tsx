import * as React from "react"
import { motion, useReducedMotion } from "framer-motion"

type Props = { label?: string; variant?: "dark" | "light" }

/** A restrained radial ink fill contained by the native button surface. */
export default function InkFloodButton({ label = "Add key", variant = "dark" }: Props) {
  const [active, setActive] = React.useState(false)
  const [origin, setOrigin] = React.useState({ x: 50, y: 50 })
  const reduceMotion = useReducedMotion()

  const locate = (event: React.PointerEvent<HTMLSpanElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setOrigin({
      x: Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)),
    })
  }

  return (
    <motion.span
      className={`ink-button-content${active ? " is-active" : ""}${variant === "light" ? " is-light" : ""}`}
      animate={reduceMotion ? undefined : { scale: active ? 1 : 1 }}
      transition={{ duration: 0.22, ease: [0.19, 1, 0.22, 1] }}
      onPointerEnter={(event) => { locate(event); setActive(true) }}
      onPointerMove={locate}
      onPointerLeave={() => setActive(false)}
      whileTap={reduceMotion ? undefined : { scale: 0.985 }}
    >
      <motion.span
        className="ink-button-flood"
        animate={{ clipPath: reduceMotion ? "none" : active
          ? `circle(155% at ${origin.x}% ${origin.y}%)`
          : `circle(0% at ${origin.x}% ${origin.y}%)` }}
        transition={{ duration: active ? 0.42 : 0.32, ease: [0.19, 1, 0.22, 1] }}
      />
      <span className="ink-button-label">{label}</span>
    </motion.span>
  )
}
