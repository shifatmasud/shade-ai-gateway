if (typeof window !== "undefined" && (window as any).__shWarm === undefined) (window as any).__shWarm = 1
import * as React from "react"
import { animate, inView } from "framer-motion"

const EASE = [0.19, 1, 0.22, 1]

// hold scroll-reveals until the preloader opens (event "sh:reveal"); no preloader = run at once
function inViewH(el: Element, cb: any, o?: any) {
    const w: any = typeof window !== "undefined" ? window : null
    if (!w || !w.__shPre) return inView(el as any, cb, o)
    let stop: any = () => {}, dead = false
    const go = () => { if (!dead) stop = inViewH(el as any, cb, o) }
    w.addEventListener("sh:reveal", go, { once: true })
    return () => { dead = true; w.removeEventListener("sh:reveal", go); stop() }
}

const q = (name: string, root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLElement>(`[data-framer-name="${name}"]`))
const live = () => typeof document !== "undefined"
function Ghost() { return <div style={{ width: 1, height: 1, pointerEvents: "none", opacity: 0 }} /> }

// split every text node under el into word masks (overflow hidden) with a sliding inner span
function splitMasked(el: HTMLElement) {
    const inners: HTMLElement[] = []
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []; while (tw.nextNode()) nodes.push(tw.currentNode as Text)
    for (const t of nodes) {
        const txt = t.textContent || ""; if (!txt.trim()) continue
        const frag = document.createDocumentFragment()
        for (const part of txt.split(/(\s+)/)) {
            if (!part) continue
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue }
            const m = document.createElement("span"); m.dataset.shMask = "1"
            Object.assign(m.style, { display: "inline-block", overflow: "hidden", verticalAlign: "top", padding: "0.12em 0 0.2em", margin: "-0.12em 0 -0.2em" })
            const i = document.createElement("span"); i.dataset.shIn = "1"
            Object.assign(i.style, { display: "inline-block", transform: "translateY(118%)", willChange: "transform" }); i.textContent = part
            m.appendChild(i); frag.appendChild(m); inners.push(i)
        }
        t.parentNode!.replaceChild(frag, t)
    }
    return inners
}

/**
 * Text animation only: masked, staggered word slide-up when a text layer scrolls into view (no fade, no blur).
 * Layers are picked by name. Waits for the preloader. Skipped with reduced motion.
 * @framerSupportedLayoutWidth fixed
 * @framerSupportedLayoutHeight fixed
 */
export default function TextReveal(props) {
    React.useEffect(() => {
        if (!live()) return
        const cleanups: Array<() => void> = []
        const run = () => {
            const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
            if (reduce) return
            const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean)
            for (const name of list(props.textNames)) q(name).forEach((el) => {
                if (el.dataset.shRv) return
                el.dataset.shRv = "1"
                const html = el.innerHTML
                const inners = splitMasked(el)
                if (!inners.length) { delete el.dataset.shRv; return }
                // line index from the rendered position of each word
                const tops: number[] = []; const lineOf = inners.map((i) => { const top = Math.round((i.parentElement as HTMLElement).offsetTop); let k = tops.findIndex((t) => Math.abs(t - top) < 6); if (k < 0) { tops.push(top); k = tops.length - 1 } return k })
                const seen: Record<number, number> = {}
                const stop = inViewH(el, () => {
                    inners.forEach((i, n) => { const L = lineOf[n]; const w = (seen[L] = (seen[L] ?? -1) + 1); animate(i, { y: ["118%", "0%"] }, { ...(props.transition || { duration: 1, ease: EASE }), delay: L * props.stagger + w * props.wordStagger }) })
                }, { margin: "0px 0px -10% 0px" })
                cleanups.push(() => { stop(); el.innerHTML = html; delete el.dataset.shRv })
            })
        }
        const id = requestAnimationFrame(run)
        return () => { cancelAnimationFrame(id); cleanups.forEach((c) => c()) }
    }, [JSON.stringify(props)])
    return <Ghost />
}
TextReveal.defaultProps = { textNames: "Headline Text, About Title, Row Label, Row Desc, Services Title, Contact Title, Contact Text, Contact Link, Person Name, Person Role", stagger: 0.09, wordStagger: 0.025, transition: { type: "tween", duration: 1, ease: [0.19, 1, 0.22, 1] } }
