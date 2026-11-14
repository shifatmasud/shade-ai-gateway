import "@fontsource-variable/inter"
import * as React from "react"
import { createRoot } from "react-dom/client"
import { withGlassShatter } from "./src/GlassShatter"
import TextReveal from "./src/TextReveal"
import InkFloodButton from "./src/InkFloodButton"

function ShadeMark() {
  return (
    <svg viewBox="0 0 200 200" width="22" height="22" role="presentation" aria-hidden="true">
      <path d="M100 0 200 0 100 100 0 100Z" fill="currentColor" />
      <path d="M100 100 200 100 100 200 0 200Z" fill="currentColor" />
    </svg>
  )
}

const InteractiveMark = withGlassShatter(ShadeMark)
const mount = document.getElementById("framer-mark")
if (mount) createRoot(mount).render(<InteractiveMark />)

const revealMount = document.getElementById("framer-text-reveal")
if (revealMount) createRoot(revealMount).render(<TextReveal textNames="Headline Text" stagger={0.09} wordStagger={0.025} />)

const addKeyMount = document.getElementById("addKey")
if (addKeyMount) createRoot(addKeyMount).render(<InkFloodButton label="Add key" />)

const copyMount = document.getElementById("copyUrl")
if (copyMount) createRoot(copyMount).render(<InkFloodButton label="Copy" variant="light" />)
