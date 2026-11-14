/**
 * GlassShatter.tsx — Framer code override for the /404 glass logo.
 *
 * Wraps the Logo Crystal ShaderNode on the /404 page and adds the two
 * behaviours the shader alone cannot do:
 *  - Gentle cinematic glitch, logo only: every few seconds the logo does a
 *    brief ~160 ms jitter (a few pixels sideways, no change to the 404
 *    type or anything else on the page).
 *  - Tap to shatter: the logo breaks into glass shards from the tap point
 *    and reforms a few seconds later, with the locked glass sound.
 *
 * Shatter visuals are ported from Shifat's surface-tension repo
 * (github.com/shifatmasud/surface-tension):
 *  - src/gl/stages/journey/shatter.ts — tempered glass fails from a point
 *    impact: radial cracks run out from the impact, short concentric
 *    cracks join them, every cell becomes a shard that flies in slow
 *    motion, tumbling, with an iridescent edge.
 *  - src/services/audio.ts + src/services/soundKit.ts — the locked glass
 *    sound: a 2.6 s decaying-noise room impulse, wet 0.32, kept ONLY for
 *    the glass shatter; softer/calmer/cleaner palette, nothing above
 *    ~6 kHz; on phones the shatter rides its own bus at gain 0.5 with a
 *    low-pass so it never clips the phone speaker.
 *
 * Imports are limited to react and framer-motion, as Framer requires.
 * No module-level shared state: the sound engine lives in a ref.
 */

import {
    forwardRef,
    useCallback,
    useEffect,
    useRef,
    useState,
    type ComponentType,
} from "react"
import { motion } from "framer-motion"

/* The traced mark: two identical 45-degree parallelograms, stacked so they
 * meet at the centre (100,100). Same geometry as src/assets/logo/Logo.tsx. */
const LOGO_POLYS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
    [[100, 0], [200, 0], [100, 100], [0, 100]],
    [[100, 100], [200, 100], [100, 200], [0, 200]],
]

type Pt = { x: number; y: number }

function inLogo(x: number, y: number): boolean {
    const inQuad = (q: ReadonlyArray<readonly [number, number]>) => {
        let inside = false
        for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
            const [xi, yi] = q[i]
            const [xj, yj] = q[j]
            if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
        }
        return inside
    }
    return inQuad(LOGO_POLYS[0]) || inQuad(LOGO_POLYS[1])
}

interface Shard {
    points: Pt[]
    cx: number
    cy: number
    dx: number
    dy: number
    rot: number
    delay: number
}

/** Radial + concentric fracture cells around an impact point (logo space 0..200). */
function fractureCells(impact: Pt): Shard[] {
    let seed = 1771 + Math.round(impact.x * 13 + impact.y * 7)
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const radials = 12
    const rings = [28, 58, 92, 130]
    const shards: Shard[] = []
    for (let r = 0; r < rings.length; r++) {
        const r0 = r === 0 ? 4 : rings[r - 1]
        const r1 = rings[r]
        for (let i = 0; i < radials; i++) {
            if (rnd() < 0.12) continue
            const a0 = (i / radials) * Math.PI * 2 + rnd() * 0.08
            const a1 = ((i + 1) / radials) * Math.PI * 2 + rnd() * 0.08
            const p = (a: number, rr: number): Pt => ({
                x: impact.x + Math.cos(a) * rr,
                y: impact.y + Math.sin(a) * rr,
            })
            const pts = [p(a0, r0), p(a1, r0), p(a1, r1), p(a0, r1)]
            const cx = pts.reduce((s, q) => s + q.x, 0) / 4
            const cy = pts.reduce((s, q) => s + q.y, 0) / 4
            if (!inLogo(cx, cy)) continue
            const ddx = cx - impact.x
            const ddy = cy - impact.y
            const dist = Math.max(12, Math.hypot(ddx, ddy))
            const speed = 34 + (1 - dist / 130) * 86 + rnd() * 26
            shards.push({
                points: pts,
                cx,
                cy,
                dx: (ddx / dist) * speed,
                dy: (ddy / dist) * speed + 26,
                rot: (rnd() - 0.5) * 260,
                delay: rnd() * 0.05,
            })
        }
    }
    return shards
}

/* ------------------------------------------------------------------ */
/* Locked glass shatter sound (audio.ts + soundKit.ts, compact port)   */
/* ------------------------------------------------------------------ */

class ShatterSound {
    private ctx: AudioContext | null = null
    private master: GainNode | null = null
    private shatterBus: GainNode | null = null
    private convolver: ConvolverNode | null = null

    private ensure(): boolean {
        if (this.ctx) return true
        try {
            const Ctx =
                window.AudioContext ||
                (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
            this.ctx = new Ctx()
            const isPhone =
                window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 700
            this.master = this.ctx.createGain()
            this.master.gain.value = 0.9
            this.master.connect(this.ctx.destination)
            this.shatterBus = this.ctx.createGain()
            this.shatterBus.gain.value = isPhone ? 0.5 : 1
            if (isPhone) {
                const hp = this.ctx.createBiquadFilter()
                hp.type = "highpass"
                hp.frequency.value = 180
                const lp = this.ctx.createBiquadFilter()
                lp.type = "lowpass"
                lp.frequency.value = 5200
                this.shatterBus.connect(hp)
                hp.connect(lp)
                lp.connect(this.master)
            } else {
                this.shatterBus.connect(this.master)
            }
            const len = Math.floor(this.ctx.sampleRate * 2.6)
            const ir = this.ctx.createBuffer(2, len, this.ctx.sampleRate)
            for (let ch = 0; ch < 2; ch++) {
                const d = ir.getChannelData(ch)
                for (let i = 0; i < len; i++)
                    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4)
            }
            this.convolver = this.ctx.createConvolver()
            this.convolver.buffer = ir
            const wet = this.ctx.createGain()
            wet.gain.value = 0.32
            this.convolver.connect(wet)
            wet.connect(this.shatterBus)
            return true
        } catch {
            return false
        }
    }

    private env(g: GainNode, t: number, peak: number, a: number, r: number) {
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(peak, t + Math.max(0.01, a))
        g.gain.setTargetAtTime(0, t + Math.max(0.01, a), r / 4)
    }

    private voice(t: number, freq: number, panX: number) {
        const ctx = this.ctx!
        const bus = this.shatterBus!
        const dur = 0.25 + Math.random() * 0.5
        const nLen = Math.floor(ctx.sampleRate * 0.12)
        const buf = ctx.createBuffer(1, nLen, ctx.sampleRate)
        const d = buf.getChannelData(0)
        for (let i = 0; i < nLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nLen, 2)
        const src = ctx.createBufferSource()
        src.buffer = buf
        const bp = ctx.createBiquadFilter()
        bp.type = "bandpass"
        bp.frequency.value = 1500 + Math.random() * 3500
        bp.Q.value = 1.2
        const g = ctx.createGain()
        this.env(g, t, 0.14 + Math.random() * 0.18, 0.012, 0.3)
        const p = ctx.createStereoPanner()
        p.pan.value = Math.max(-1, Math.min(1, panX))
        src.connect(bp)
        bp.connect(g)
        g.connect(p)
        p.connect(bus)
        p.connect(this.convolver!)
        src.start(t)
        src.stop(t + 0.15)
        const o = ctx.createOscillator()
        o.type = "sine"
        o.frequency.setValueAtTime(freq, t)
        const og = ctx.createGain()
        this.env(og, t, 0.08 + Math.random() * 0.07, 0.03, dur)
        const op = ctx.createStereoPanner()
        op.pan.value = Math.max(-1, Math.min(1, panX))
        o.connect(og)
        og.connect(op)
        op.connect(bus)
        op.connect(this.convolver!)
        o.start(t)
        o.stop(t + dur + 0.4)
    }

    play() {
        if (!this.ensure() || !this.ctx) return
        if (this.ctx.state === "suspended") void this.ctx.resume()
        const t0 = this.ctx.currentTime + 0.02
        const partials = [2093, 2637, 3136, 3520, 4186, 4699]
        for (let i = 0; i < 48; i++) {
            const t = t0 + Math.random() * 0.14
            const f = partials[Math.floor(Math.random() * partials.length)] * (0.98 + Math.random() * 0.04)
            this.voice(t, f, Math.random() * 2 - 1)
        }
    }

    reform() {
        if (!this.ensure() || !this.ctx) return
        const t0 = this.ctx.currentTime + 0.02
        ;[523.25, 783.99, 1046.5].forEach((f, i) => {
            const o = this.ctx!.createOscillator()
            o.type = "sine"
            o.frequency.value = f
            const g = this.ctx!.createGain()
            this.env(g, t0 + i * 0.07, 0.06, 0.03, 0.9)
            o.connect(g)
            g.connect(this.master!)
            g.connect(this.convolver!)
            o.start(t0 + i * 0.07)
            o.stop(t0 + i * 0.07 + 1.2)
        })
    }
}

/* ------------------------------------------------------------------ */
/* Override                                                            */
/* ------------------------------------------------------------------ */

export function withGlassShatter(Component: ComponentType<any>): ComponentType<any> {
    return forwardRef<any, any>(function GlassShatterOverride(props, ref) {
        const { style, ...rest } = props
        const [shattered, setShattered] = useState(false)
        const [shards, setShards] = useState<Shard[]>([])
        const [glitching, setGlitching] = useState(false)
        const soundRef = useRef<ShatterSound | null>(null)
        const hostRef = useRef<HTMLDivElement>(null)
        const reformTimer = useRef<number | null>(null)

        if (!soundRef.current) soundRef.current = new ShatterSound()

        useEffect(() => {
            let alive = true
            let timeout: number
            const schedule = () => {
                timeout = window.setTimeout(() => {
                    if (!alive) return
                    setGlitching(true)
                    window.setTimeout(() => {
                        if (alive) setGlitching(false)
                    }, 170)
                    schedule()
                }, 3500 + Math.random() * 2500)
            }
            schedule()
            return () => {
                alive = false
                window.clearTimeout(timeout)
                if (reformTimer.current) window.clearTimeout(reformTimer.current)
            }
        }, [])

        const shatter = useCallback((e: React.PointerEvent) => {
            if (shattered) return
            const host = hostRef.current
            if (!host) return
            const r = host.getBoundingClientRect()
            const size = Math.min(r.width, r.height)
            const ox = r.left + (r.width - size) / 2
            const oy = r.top + (r.height - size) / 2
            const ix = ((e.clientX - ox) / size) * 200
            const iy = ((e.clientY - oy) / size) * 200
            const impact = { x: Math.max(20, Math.min(180, ix)), y: Math.max(20, Math.min(180, iy)) }
            setShards(fractureCells(impact))
            setShattered(true)
            soundRef.current!.play()
            if (reformTimer.current) window.clearTimeout(reformTimer.current)
            reformTimer.current = window.setTimeout(() => {
                setShattered(false)
                setShards([])
                soundRef.current!.reform()
            }, 2800)
        }, [shattered])

        return (
            <div
                ref={(node) => {
                    hostRef.current = node
                    if (typeof ref === "function") ref(node)
                    else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
                }}
                style={{ ...style, position: "relative", cursor: "pointer", touchAction: "manipulation" }}
                onPointerDown={shatter}
                role="img"
                aria-label="Shade AI Gateway mark — tap to shatter"
            >
                <motion.div
                    animate={glitching && !shattered ? { x: [0, -3, 2, -1, 0] } : { x: 0 }}
                    transition={{ duration: 0.16, ease: "easeOut" }}
                    style={{ opacity: shattered ? 0 : 1, transition: "opacity 120ms ease" }}
                >
                    <Component {...rest} />
                </motion.div>
                {shattered && (
                    <svg
                        viewBox="0 0 200 200"
                        preserveAspectRatio="xMidYMid meet"
                        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
                        aria-hidden="true"
                    >
                        <defs>
                            <linearGradient id="glassShard" x1="0" y1="0" x2="1" y2="1">
                                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
                                <stop offset="45%" stopColor="#121315" stopOpacity="0.92" />
                                <stop offset="100%" stopColor="#3a3f45" stopOpacity="0.9" />
                            </linearGradient>
                        </defs>
                        {shards.map((s, i) => (
                            <motion.polygon
                                key={i}
                                points={s.points.map((p) => `${p.x},${p.y}`).join(" ")}
                                fill="url(#glassShard)"
                                stroke="#ffffff"
                                strokeOpacity="0.55"
                                strokeWidth="0.6"
                                initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
                                animate={{
                                    x: s.dx,
                                    y: s.dy,
                                    rotate: s.rot,
                                    opacity: [1, 1, 0],
                                }}
                                transition={{ duration: 1.15, delay: s.delay, ease: [0.16, 1, 0.3, 1] }}
                                style={{ transformBox: "fill-box", transformOrigin: "center" }}
                            />
                        ))}
                    </svg>
                )}
            </div>
        )
    })
}
