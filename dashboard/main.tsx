import "@fontsource/inter/latin-400.css"
import "@fontsource/inter/latin-500.css"
import "@fontsource/inter/latin-600.css"
import "@fontsource/inter/latin-700.css"
import * as React from "react"
import { createRoot } from "react-dom/client"
import TextReveal from "./src/TextReveal"
import { bindInk } from "./src/surface/inkButton"

const revealMount = document.getElementById("framer-text-reveal")
if (revealMount) createRoot(revealMount).render(<TextReveal textNames="Headline Text" stagger={0.09} wordStagger={0.025} />)

// Surface Tension's original one-rAF button controller also binds newly-rendered provider rows.
const inkBindings = new Map<HTMLElement, () => void>()
function syncSurfaceButtons() {
  for (const [element, dispose] of inkBindings) {
    if (!element.isConnected) { dispose(); inkBindings.delete(element) }
  }
  document.querySelectorAll<HTMLElement>("[data-surface-button]").forEach((element) => {
    if (inkBindings.has(element)) return
    const kind = element.dataset.inkKind === "sound" ? "sound" : "cta"
    inkBindings.set(element, bindInk(element, kind))
  })
}
syncSurfaceButtons()
const buttonObserver = new MutationObserver(syncSurfaceButtons)
buttonObserver.observe(document.body, { childList: true, subtree: true })
