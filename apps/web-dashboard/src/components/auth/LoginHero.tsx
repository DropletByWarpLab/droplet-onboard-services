"use client";

import { useEffect, useRef, useState } from "react";
import { Shield, Lock, Check } from "lucide-react";
import { DropletMark } from "@/components/DropletMark";
import "./login-hero.css";

/**
 * The brand half of every public auth surface — WARP-2973.
 *
 * Replaces the flat `AuroraPanel` gradient with the login landing design
 * (`docs/design/login-landing.dc.html`): a dot-matrix field that reacts to
 * the pointer, and the Droplet mark as a slowly spinning low-poly solid.
 * Both are plain 2D canvas — no WebGL, no three.js, no new dependency.
 *
 * Colours are literal and dark in BOTH themes; they live in
 * `login-hero.css` as `--lh-*` scoped to `.lh`. Read the header of that
 * file before touching them.
 *
 * Everything here is decoration: the canvases and the status dot are
 * `aria-hidden`, and the positioning line is a `<p>`, not an `<h1>` — the
 * surface's only top-level heading belongs to the form column ("Welcome
 * back" / "You've been invited"). It used to be an `<h1>` here too, which
 * landed screen-reader users on the marketing pitch instead of the form.
 */

/* ── The solid ───────────────────────────────────────────────────────
   Same geometry and baked face colours as the app icon / Droplet.glb
   (Y-up, height 2, centred): a square equator with a vertex toward the
   camera, an apex above and a 45°-twisted square base below. */
const GEM = (() => {
  const s = 2 / 2.2;
  const mid = (1.57 - 0.63) / 2;
  const V: [number, number, number][] = [[0, (1.57 - mid) * s, 0]]; // 0: apex
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    V.push([Math.sin(a) * s, -mid * s, Math.cos(a) * s]); // 1-4: equator, 1 = front
  }
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    V.push([
      0.82 * Math.sin(a) * s,
      (-0.63 - mid) * s,
      0.82 * Math.cos(a) * s,
    ]); // 5-8: base
  }
  const LAV = "#a2adfd";
  const MID = "#604ff3";
  const BAND = "#4d3dde";
  const DARK = "#4735d4";
  const eq = (i: number) => 1 + (i & 3);
  const bs = (i: number) => 5 + (i & 3);
  const F: [number[], string][] = [];
  for (let i = 0; i < 4; i++) {
    F.push([[eq(i), eq(i + 1), 0], i % 2 ? MID : LAV]); // top facet
    F.push([[eq(i), bs(i), bs(i + 3)], i % 2 ? DARK : BAND]); // lower tri under the equator vertex
    F.push([[eq(i), eq(i + 1), bs(i)], i % 2 ? DARK : BAND]); // lower tri between equator vertices
  }
  F.push([[8, 7, 6, 5], DARK]); // base
  return { V, F };
})();

/** Indigo ramp the field's dots step through, darkest first. */
const RAMP = [
  [67, 56, 202],
  [79, 70, 229],
  [99, 102, 241],
  [129, 140, 248],
  [165, 180, 252],
  [199, 210, 254],
] as const;

const PITCH = 18; // px between dots
const FLOW = 1; // wave speed multiplier
const HEAT_R = 180; // px radius of the pointer's halo
const SPIN_IDLE = 0.5; // rad/s
const SPIN_HOVER = 1.5; // rad/s

const TRUST = [
  { icon: Shield, label: "On-prem" },
  { icon: Lock, label: "Encrypted at rest" },
  { icon: Check, label: "Yours, not licensed" },
] as const;

export function LoginHero({ className = "" }: { className?: string }) {
  const rootRef = useRef<HTMLElement | null>(null);
  const fieldRef = useRef<HTMLCanvasElement | null>(null);
  const gemRef = useRef<HTMLCanvasElement | null>(null);
  const tiltRef = useRef<HTMLDivElement | null>(null);

  // Animation state lives in refs, never in React state: the loop mutates it
  // 60×/s and none of it belongs in a render.
  const size = useRef({ w: 0, h: 0 });
  const mouse = useRef({ x: -9999, y: -9999, active: false });
  const ripples = useRef<{ x: number; y: number; t: number }[]>([]);
  const wave = useRef(0);
  const spin = useRef(SPIN_IDLE);
  const angle = useRef(0);
  const last = useRef(0);
  const reduced = useRef(false);

  // SSR-safe: the server has no hostname to render, so the line ships
  // without it and fills in on mount.
  const [hostname, setHostname] = useState("");
  useEffect(() => setHostname(window.location.hostname), []);

  useEffect(() => {
    // jsdom (and any server-side render) has neither; a viewer who asked for
    // less motion gets one static frame and no loop at all.
    reduced.current =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    /** Repaint the dot-matrix field for the current wave/pointer state. */
    function drawField() {
      const ctx = fieldRef.current?.getContext("2d");
      if (!ctx) return; // no 2D backend (jsdom) — nothing to paint
      const { w: W, h: H } = size.current;
      const t = wave.current;
      const m = mouse.current;

      ctx.clearRect(0, 0, W, H);
      const cx = W / 2;
      const cy = H * 0.45;
      const maxD = Math.hypot(W, H) * 0.55 || 1;
      const ox = (W % PITCH) / 2;
      const oy = (H % PITCH) / 2;

      for (let x = ox; x <= W; x += PITCH) {
        for (let y = oy; y <= H; y += PITCH) {
          const dc = Math.hypot(x - cx, y - cy);
          const mask = Math.max(0, 1 - dc / maxD);
          const w =
            0.5 +
            0.5 * Math.sin(dc * 0.018 - t * 2.2) * Math.sin(x * 0.004 + t * 0.6);
          let a = (0.08 + w * 0.28) * mask * mask;
          let r = 1;
          let ci = Math.min(5, Math.floor(w * 3));

          // Pointer heat, then any click ripple crossing this dot.
          let heat = 0;
          if (m.active) {
            const d = Math.hypot(x - m.x, y - m.y);
            if (d < HEAT_R) heat = Math.pow(1 - d / HEAT_R, 1.6);
          }
          for (const rp of ripples.current) {
            const d = Math.abs(Math.hypot(x - rp.x, y - rp.y) - rp.t * 300);
            if (d < 24) heat = Math.max(heat, (1 - d / 24) * (1 - rp.t));
          }
          if (heat > 0) {
            a = Math.min(1, a + heat * 0.9);
            r += heat * 2.4;
            ci = Math.min(5, ci + Math.round(heat * 3));
          }
          if (a < 0.015) continue;

          const col = RAMP[ci];
          ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 6.2832);
          ctx.fill();
        }
      }

      if (m.active) {
        const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, HEAT_R);
        g.addColorStop(0, "rgba(129,140,248,0.09)");
        g.addColorStop(1, "rgba(129,140,248,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(m.x, m.y, HEAT_R, 0, 6.2832);
        ctx.fill();
      }
    }

    /**
     * Orthographic, 22° elevation (matches the app icon), steady spin about
     * Y, painter's sort — the solid is convex, so no z-buffer is needed.
     * The backing store is 360×360 for a 180px box: DPR 2, fixed, since the
     * box never resizes.
     */
    function drawGem(now: number) {
      const ctx = gemRef.current?.getContext("2d");
      if (!ctx) return;
      const dt = last.current ? (now - last.current) / 1000 : 0;
      last.current = now;
      angle.current += dt * spin.current;

      const S = 72;
      const cx = 90;
      const cy = 92;
      const el = (22 * Math.PI) / 180;
      const ce = Math.cos(el);
      const se = Math.sin(el);
      const ca = Math.cos(angle.current);
      const sa = Math.sin(angle.current);
      const P = GEM.V.map(([x, y, z]) => {
        const rx = x * ca + z * sa;
        const rz = -x * sa + z * ca;
        // screen x, screen y, depth toward the camera
        return [cx + rx * S, cy - (y * ce - rz * se) * S, rz * ce + y * se];
      });

      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, 180, 180);
      GEM.F.map(([idx, col]) => ({
        idx,
        col,
        d: idx.reduce((a, i) => a + P[i][2], 0) / idx.length,
      }))
        .sort((a, b) => a.d - b.d)
        .forEach(({ idx, col }) => {
          ctx.fillStyle = col;
          ctx.strokeStyle = col;
          // Hairline stroke hides the AA seams between facets.
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          idx.forEach((i, k) =>
            k ? ctx.lineTo(P[i][0], P[i][1]) : ctx.moveTo(P[i][0], P[i][1]),
          );
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        });
    }

    function resize() {
      const c = fieldRef.current;
      const el = rootRef.current;
      if (!c || !el) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size.current = { w: el.clientWidth, h: el.clientHeight };
      c.width = size.current.w * dpr;
      c.height = size.current.h * dpr;
      c.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawField();
    }

    let raf = 0;
    function loop(now: number) {
      raf = window.requestAnimationFrame(loop);
      drawGem(now);
      wave.current += 0.012 * FLOW;
      for (const rp of ripples.current) rp.t += 0.014;
      ripples.current = ripples.current.filter((rp) => rp.t < 1);
      drawField();
    }

    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(rootRef.current!);

    // No 2D backend at all — a locked-down browser, or jsdom without the
    // canvas package. Nothing can be painted, so don't spin a frame loop
    // that could only bail on every tick: the hero degrades to its CSS
    // layers (copy, chips, halo) rather than taking the login page down.
    const canPaint = !!fieldRef.current?.getContext("2d");

    if (canPaint && !reduced.current) {
      raf = window.requestAnimationFrame(loop);
    } else if (canPaint) {
      drawGem(0); // one static frame; dt is 0, so the solid sits at angle 0
    }

    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  /** Pointer heat for the field + a parallax tilt on the gem (±22°). */
  function handleMove(e: React.MouseEvent<HTMLElement>) {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    mouse.current = {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      active: true,
    };

    const tilt = tiltRef.current;
    if (!tilt || reduced.current) return;
    const tr = tilt.getBoundingClientRect();
    const dx = (e.clientX - (tr.left + tr.width / 2)) / (r.width || 1);
    const dy = (e.clientY - (tr.top + tr.height / 2)) / (r.height || 1);
    tilt.style.transform = `rotateX(${(-dy * 22).toFixed(2)}deg) rotateY(${(dx * 22).toFixed(2)}deg)`;
  }

  function handleLeave() {
    mouse.current = { x: -9999, y: -9999, active: false };
    if (tiltRef.current) tiltRef.current.style.transform = "";
  }

  function handleDown(e: React.MouseEvent<HTMLElement>) {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    ripples.current.push({ x: e.clientX - r.left, y: e.clientY - r.top, t: 0 });
  }

  return (
    <section
      ref={rootRef}
      className={`lh ${className}`}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onMouseDown={handleDown}
    >
      <canvas
        ref={fieldRef}
        data-testid="login-hero-field"
        className="lh-field"
        aria-hidden="true"
      />
      <div className="lh-vignette" aria-hidden="true" />

      <div className="lh-brand">
        <DropletMark size={22} className="lh-mark" />
        <span className="lh-wordmark">Droplet</span>
      </div>

      <div className="lh-stage">
        <div
          ref={tiltRef}
          className="lh-tilt"
          onMouseEnter={() => (spin.current = SPIN_HOVER)}
          onMouseLeave={() => (spin.current = SPIN_IDLE)}
        >
          <div className="lh-halo" aria-hidden="true" />
          <div className="lh-float">
            <canvas
              ref={gemRef}
              data-testid="login-hero-gem"
              className="lh-gem"
              width={360}
              height={360}
              aria-hidden="true"
            />
          </div>
        </div>

        <div className="lh-copy">
          {/* Brand copy, NOT the page heading — see the note at the top. */}
          <p className="lh-title">
            Your company&rsquo;s brain.
            <br />
            On your premises.
          </p>
          <p className="lh-sub">
            One box runs your AI, files, cameras, and network — and nothing
            leaves the building unless you say so.
          </p>
          <ul className="lh-chips">
            {TRUST.map(({ icon: Icon, label }) => (
              <li key={label} className="lh-chip">
                <Icon size={14} aria-hidden="true" />
                {label}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="lh-status">
        <span className="lh-dot" aria-hidden="true" />
        <span>Online · on your local network</span>
        {hostname && (
          <>
            <span className="lh-sep" aria-hidden="true">
              ·
            </span>
            <span className="lh-host">{hostname}</span>
          </>
        )}
      </div>
    </section>
  );
}
