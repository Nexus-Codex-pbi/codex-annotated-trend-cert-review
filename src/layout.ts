"use strict";

// ─── Annotated Trend: layout (pure: no DOM, no host; text widths come in through `measure`) ─────
//
// THE COLLISION RULE (all three styles). Notes are placed ONE AT A TIME IN PRIORITY ORDER. A note
// is placed at the first candidate position that touches none of: an already placed note, an
// already placed leader (A, B) or stem (C), the series line (B; A keeps its notes in a band above
// the plot and C keeps them in a key below it, so neither can touch the line), and the content
// box edge. A note with no such position moves to the overflow count ("+N more notes"); its
// marker stays on the line and its full text stays in the tooltip and accessible name.
//
// PRIORITY: Note priority measure first (higher first; blank or text priorities after every
// numeric one), then the "When notes don't fit, keep" setting (latest date first by default,
// or earliest first, or largest value first), then DataView row order.
//
// DEGRADATION on a small card, in order: (0) A's label band and C's key take at most half the
// drawing height, so the trend keeps the other half; (1) notes share rows / try every candidate position;
// (2) captions truncate with an ellipsis (A: one line; B: wrap to two lines then ellipsis;
// C: one key line), never the date; (3) the lowest-priority notes move to the overflow count;
// (4) when the plot itself has no room (A's band, C's key or B's plot), every note is in the
// overflow count and the line and markers remain; (5) below the minimum drawing size the visual
// scrolls instead of shrinking further.

export type Measure = (text: string) => number;

export interface Rect { x: number; y: number; w: number; h: number; }

// ─── Scales ─────────────────────────────────────────────────────────────────────────────────

export interface NiceScale { lo: number; hi: number; step: number; ticks: number[]; }

/** A zero-anchored domain (0 is always inside it: lines and columns are read against zero)
 *  rounded out to a 1 / 2 / 2.5 / 5 x 10^k step. */
export function niceScale(min: number, max: number, targetTicks = 4, zero = true): NiceScale {
    // zero = false (F7 Start at zero Off / Auto with a bare line): the domain follows the data alone.
    let lo = zero ? Math.min(0, min) : min, hi = zero ? Math.max(0, max) : max;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    if (lo === hi) hi = lo + 1;
    // Fix round 7 (M1): at |v| >= 2^53, lo + 1 is lo again: widen a constant by a representable
    // increment (a hundredth of its magnitude) instead.
    if (lo === hi) hi = lo + Math.pow(10, Math.floor(Math.log10(Math.abs(lo))) - 2);
    const parts = Math.max(1, targetTicks - 1);
    let raw = (hi - lo) / parts;
    // Fix round 7 (M1): [-1e308, 1e308] overflows hi - lo; divide before subtracting.
    if (!Number.isFinite(raw)) raw = hi / parts - lo / parts;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const unit = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    // A subnormal step (raw 5e-324) has no power-of-ten magnitude (10^-324 is 0): the step is raw.
    const step = mag > 0 && Number.isFinite(norm) ? unit * mag : raw;
    // + 1e-9: a bound already on a step (0 for all-positive data) is its own tick, never one step past it.
    const nlo = Math.floor(lo / step + 1e-9) * step;
    const nhi = Math.ceil(hi / step - 1e-9) * step;
    const ticks: number[] = [];
    // Fix round 7 (M1): halves, so -1e308 + 2 steps of 1e308 is not Infinity (exact in binary: the same bits for ordinary ranges).
    for (let v = nlo, k = 0; v <= nhi + step * 1e-6 && k < 50; v = (nlo / 2 + (++k) * (step / 2)) * 2) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    // Fix round 7 (M1): a scale that still is not finite (a step of 1e308 rounds a bound out to
    // infinity) clamps its bounds to the largest finite number and keeps its finite ticks.
    if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(nlo) || !Number.isFinite(nhi) || ticks.some(t => !Number.isFinite(t)) || ticks.length === 0) {
        const L = Number.isFinite(nlo) ? nlo : -Number.MAX_VALUE, H = Number.isFinite(nhi) ? nhi : Number.MAX_VALUE;
        const kept = ticks.filter(t => Number.isFinite(t));
        if (!Number.isFinite(step) || step <= 0 || kept.length === 0) {
            // [-MAX, MAX]: the step itself overflows. Round the range scaled down by 1e10, then
            // scale back, keeping the finite ticks and clamping the bounds to the largest finite.
            if (Math.abs(lo) > 1e300 || Math.abs(hi) > 1e300) {
                const S = 1e10, q = niceScale(lo / S, hi / S, targetTicks, false);
                const qk = q.ticks.map(t => t * S).filter(t => Number.isFinite(t));
                const fin = (v: number, d: number) => Number.isFinite(v) ? v : d;
                if (qk.length) return { lo: Math.min(fin(q.lo * S, -Number.MAX_VALUE), qk[0]), hi: Math.max(fin(q.hi * S, Number.MAX_VALUE), qk[qk.length - 1]), step: q.step * S, ticks: qk };
            }
            return { lo: 0, hi: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
        }
        return { lo: Math.min(L, kept[0]), hi: Math.max(H, kept[kept.length - 1]), step, ticks: kept };
    }
    return { lo: nlo, hi: nhi, step, ticks };
}

/** Round 4 item 6: value-axis labels thin out as a native axis does (automatically, no setting):
 *  every k-th tick, counted from `anchor` (the zero tick, else the first), for the smallest k whose
 *  neighbouring labels stand at least `minGap` px apart (line box plus a clear gap), so no two
 *  labels touch. Returns the kept tick indices, ascending; a single tick when even that fails. */
export function thinTicks(ys: number[], minGap: number, anchor = 0): number[] {
    const n = ys.length;
    if (n <= 1) return ys.map((_, i) => i);
    const a = Math.max(0, Math.min(n - 1, anchor));
    for (let k = 1; k < n; k++) {
        const kept: number[] = [];
        for (let i = a % k; i < n; i += k) kept.push(i);
        let ok = kept.length >= 2;
        for (let j = 1; ok && j < kept.length; j++) if (Math.abs(ys[kept[j]] - ys[kept[j - 1]]) < minGap) ok = false;
        if (ok) return kept;
    }
    return [a];
}

export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
    // Fix round 7 (M1): halves keep d1 - d0 finite at [-1e308, 1e308]; halving is exact in binary
    // floating point, so every ordinary range maps to the same bits as (v - d0) * k did.
    const den = d1 / 2 - d0 / 2;
    const k = d1 === d0 ? 0 : ((r1 - r0) / 2) / den;
    // A subnormal span ([0, 1e-323]) overflows k: take the fraction of the span first.
    if (!Number.isFinite(k)) return v => r0 + ((v / 2 - d0 / 2) / den) * (r1 - r0);
    return v => r0 + ((v / 2 - d0 / 2) * k) * 2;
}

export interface XLayout { xs: number[]; band: number; }

/** x of each point. Date axis: true time spacing. Other axes: even spacing in DataView order.
 *  Columns get a band (the smallest time gap on a date axis) and sit centred in it. */
export function xPositions(times: (number | null)[], dateAxis: boolean, left: number, right: number, columns: boolean): XLayout {
    const n = times.length, w = Math.max(0, right - left);
    if (n === 0) return { xs: [], band: 0 };
    if (n === 1) return { xs: [left + w / 2], band: columns ? Math.min(40, w * 0.1) : 0 };
    if (dateAxis) {
        const ts = times as number[];
        const t0 = ts[0], t1 = ts[n - 1];
        if (!columns) {
            if (t1 === t0) return { xs: ts.map(() => left + w / 2), band: 0 };
            const x = linear(t0, t1, left, right);
            return { xs: ts.map(x), band: 0 };
        }
        let gap = Infinity;
        for (let i = 1; i < n; i++) { const g = ts[i] - ts[i - 1]; if (g > 0 && g < gap) gap = g; }
        if (!Number.isFinite(gap)) return { xs: ts.map(() => left + w / 2), band: Math.min(40, w * 0.1) };
        const x = linear(t0 - gap / 2, t1 + gap / 2, left, right);
        return { xs: ts.map(x), band: x(t0 + gap / 2) - x(t0 - gap / 2) };
    }
    if (!columns) return { xs: times.map((_, i) => left + (i / (n - 1)) * w), band: 0 };
    const band = w / n;
    return { xs: times.map((_, i) => left + (i + 0.5) * band), band };
}

// ─── Gaps in a date axis ────────────────────────────────────────────────────────────────────

const DAY_MS = 864e5;

/** breaks[i] = true when the line must NOT join point i-1 to point i: on a date axis, a gap wider
 *  than 1.5 typical steps means dates with no row (Power BI omits a row whose measures are all
 *  blank), and bridging them would draw values that were never reported. The typical step is the
 *  median gap, never less than the grain's own unit (day 1 d, month 28 d, year 365 d). A daily
 *  series with no weekend point at all is a business-day series: weekend days are not gaps.
 *  `times` ascending epoch ms (local midnight for dates). Fewer than 3 points: no breaks. */
export function gapBreaks(times: number[], grain: string): boolean[] {
    const n = times.length;
    const out: boolean[] = new Array(n).fill(false);
    if (n < 3) return out;
    const weekdaysOnly = grain === "day" && times.every(t => { const d = new Date(t).getDay(); return d !== 0 && d !== 6; });
    // M5: a clock change moves real time by an hour against wall-clock time. Power BI sends a
    // date-time as wall-clock time read in the local zone, so at DST end 01:00 -> 02:00 is two real
    // hours; real UTC-stamped data crosses DST start the other way. The gap is the SMALLER of the
    // real and the wall-clock difference: neither reading of a whole series bridges a real hole.
    const wall = (t: number): number => { const d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()); };
    const gap = (i: number): number => {
        let g = Math.min(times[i] - times[i - 1], wall(times[i]) - wall(times[i - 1]));
        if (weekdaysOnly) {
            const d = new Date(times[i - 1]);
            for (let k = 0; k < 400; k++) {
                d.setDate(d.getDate() + 1);
                if (d.getTime() >= times[i]) break;
                const w = d.getDay();
                if (w === 0 || w === 6) g -= DAY_MS;
            }
        }
        return g;
    };
    const gaps: number[] = [];
    for (let i = 1; i < n; i++) gaps.push(gap(i));
    const sorted = gaps.filter(g => g > 0).sort((a, b) => a - b);
    if (!sorted.length) return out;
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const unit = grain === "year" ? 365 * DAY_MS : grain === "month" ? 28 * DAY_MS : grain === "day" ? DAY_MS : 0;
    const typical = Math.max(median, unit);
    for (let i = 1; i < n; i++) if (gaps[i - 1] > 1.5 * typical) out[i] = true;
    return out;
}

/** Index of the point nearest to `x` (xs ascending). */
export function nearestIndex(xs: number[], x: number): number {
    if (xs.length === 0) return -1;
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

/** Fix round 7 (H1): index of the drawn mark nearest to (x, y), a point without a value counting
 *  at `fallbackY` (the baseline its hollow marker sits on).
 *  Fix round 8 (H1): every mark whose x lies within `band` (one CSS pixel, in drawing units) of the
 *  horizontally nearest one competes on its rendered geometry: the nearest by straight-line
 *  distance wins. A pointer reports whole pixels, so two readings 27 minutes apart (0.41 px) were
 *  told apart by x alone and the upper vertex returned the lower reading. Ties keep the lower index. */
export function nearestPoint(xs: number[], ys: (number | null)[], x: number, y: number, fallbackY: number, band = 0.01): number {
    const i = nearestIndex(xs, x);
    if (i < 0) return i;
    const reach = Math.abs(xs[i] - x) + Math.max(0.01, band);
    let lo = i, hi = i;
    while (lo > 0 && Math.abs(xs[lo - 1] - x) <= reach) lo--;
    while (hi < xs.length - 1 && Math.abs(xs[hi + 1] - x) <= reach) hi++;
    let best = i, bestD = Infinity;
    for (let k = lo; k <= hi; k++) {
        const yk = ys[k];
        const dx = xs[k] - x, dy = (yk === null || yk === undefined ? fallbackY : yk) - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = k; }
    }
    return best;
}

/** First index with xs[i] >= x (xs ascending). */
export function lowerBound(xs: number[], x: number): number {
    let lo = 0, hi = xs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
}

// ─── Priority ───────────────────────────────────────────────────────────────────────────────

export type Keep = "latest" | "earliest" | "largest";

export interface PriorityIn {
    id: number;
    /** Position in drawing order (time order on a date axis). */
    order: number;
    row: number;
    value: number | null;
    priority: number | null;
}

export function priorityOrder(items: PriorityIn[], keep: Keep): number[] {
    const arr = items.slice();
    arr.sort((a, b) => {
        const pa = a.priority, pb = b.priority;
        if (pa !== null && pb !== null && pa !== pb) return pb - pa;
        if ((pa === null) !== (pb === null)) return pa === null ? 1 : -1;
        if (keep === "largest") {
            if (a.value !== null && b.value !== null && a.value !== b.value) return b.value - a.value;
            if ((a.value === null) !== (b.value === null)) return a.value === null ? 1 : -1;
        } else if (a.order !== b.order) {
            return keep === "earliest" ? a.order - b.order : b.order - a.order;
        }
        return a.row - b.row;
    });
    return arr.map(x => x.id);
}

/** Fix round 10 (R7): which notes show when not all fit. One fixed order that depends on the data and
 *  settings only, never on the card size, and whose every prefix is spread across the period: the
 *  first note of `priorityOrder` (the highest priority, then the latest, earliest or largest as Keep
 *  says), then repeatedly the note farthest in time (`order`: the time, or the position on a category
 *  axis) from every note already chosen, taking the higher priorities first. Ties: the note Keep
 *  prefers (the later date for latest, the earlier for earliest, the larger value for largest), then
 *  the author's row order. Only the first `limit` ranks are spread; the rest follow in priority order
 *  (they are never tried: the visual's capacities stay far below the limit it asks for). */
export function spreadOrder(items: PriorityIn[], keep: Keep, limit = Infinity): number[] {
    const prio = priorityOrder(items, keep);
    const n = prio.length, k = Math.min(n, Math.max(0, Math.floor(limit)));
    if (k <= 1) return prio;
    const byId = new Map(items.map(x => [x.id, x]));
    const its = prio.map(id => byId.get(id) as PriorityIn);
    // The tier key: a numeric priority (higher first), then no priority.
    const tierOf = (x: PriorityIn) => x.priority === null ? -Infinity : x.priority;
    const minD = new Float64Array(n).fill(Infinity);
    const taken = new Uint8Array(n);
    const out: number[] = [];
    const prefer = (a: PriorityIn, b: PriorityIn): boolean => {   // a ahead of b on a distance tie
        if (keep === "largest") {
            const va = a.value ?? -Infinity, vb = b.value ?? -Infinity;
            if (va !== vb) return va > vb;
            if (a.order !== b.order) return a.order > b.order;
        } else if (a.order !== b.order) return keep === "earliest" ? a.order < b.order : a.order > b.order;
        return a.row < b.row;
    };
    // Fix round 10 (timing): one pass per pick over typed arrays (the distance update and the choice
    // together); the 10,000-note leader spent 19.5% of an update here with two passes and object reads.
    const ord = new Float64Array(n), tiers = new Float64Array(n);
    for (let i = 0; i < n; i++) { ord[i] = its[i].order; tiers[i] = tierOf(its[i]); }
    let pick = 0;   // priorityOrder's first note
    for (let r = 0; r < k; r++) {
        taken[pick] = 1;
        out.push(its[pick].id);
        if (r === k - 1) break;
        const t = ord[pick];
        let best = -1, bestTier = -Infinity, bestD = -1;
        for (let i = 0; i < n; i++) {
            if (taken[i]) continue;
            let d = ord[i] - t; if (d < 0) d = -d;
            if (d < minD[i]) minD[i] = d; else d = minD[i];
            const tier = tiers[i];
            if (best < 0 || tier > bestTier || (tier === bestTier && (d > bestD || (d === bestD && prefer(its[i], its[best]))))) { best = i; bestTier = tier; bestD = d; }
        }
        if (best < 0) break;
        pick = best;
    }
    for (let i = 0; i < n && out.length < n; i++) if (!taken[i]) out.push(its[i].id);
    return out;
}

// ─── Label density (round 4, item 1)────────────────────────────────────────────────────────
//
// The native line / column chart pattern: the visual places as many labels as fit without
// overlap, and a percentage scales how many it TRIES. Here the tried notes are a PREFIX of the
// priority order, so a higher density tries a superset of a lower one; every placer below decides
// note by note in that order and never removes a note it kept, so a higher density never places
// fewer notes at the same size.

export const DENSITY_DEFAULT = 100;

/** A saved or typed density as an integer 0..100: rounded, clamped; anything that is not a finite
 *  number (blank, text, NaN) is the default. */
export function clampDensity(raw: unknown, fallback = DENSITY_DEFAULT): number {
    const v = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(v)) return fallback;
    return Math.max(0, Math.min(100, Math.round(v)));
}

/** How many of `n` notes (priority order) are tried at `density`: 0 tries the single
 *  highest-priority note, 100 tries all of them, and the count between never decreases. */
export function labelDensityAttempts(n: number, density: number): number {
    if (n <= 0) return 0;
    const d = clampDensity(density);
    return Math.max(1, Math.min(n, Math.ceil(n * d / 100)));
}

// ─── Text fitting ───────────────────────────────────────────────────────────────────────────

/** User-perceived characters, so an ellipsis never splits an emoji, a flag or a combining mark. */
// Fix round 9 (R3): one segmenter for the module (it holds no text; constructing one per call was
// 12.6% of the 10,000-note leader update in round 8's profile).
let segmenter: { segment(s: string): Iterable<{ segment: string }> } | null | undefined;
// ...and each text is split once per update (the visual empties this at every update, so nothing
// survives a data, settings or size change). Callers never modify the returned array.
const graphemeMemo = new Map<string, string[]>();
export function resetTextCaches(): void { graphemeMemo.clear(); truncMemo.clear(); }
export function graphemes(s: string): string[] {
    const hit = graphemeMemo.get(s);
    if (hit) return hit;
    const g = splitGraphemes(s);
    graphemeMemo.set(s, g);
    return g;
}
function splitGraphemes(s: string): string[] {
    if (segmenter === undefined) {
        const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
        segmenter = Seg ? new Seg(undefined, { granularity: "grapheme" }) : null;
    }
    if (segmenter) return Array.from(segmenter.segment(s), x => x.segment);
    return Array.from(s);
}

export const ELLIPSIS = "…";

// Fix round 9 (R3): a text truncated to a width once per update (the leader search re-arranges the
// kept set for every new note and truncated the same caption to the same room each time). Emptied
// with the grapheme memo at every update.
const truncMemo = new Map<Measure, Map<string, { text: string; truncated: boolean }>>();
export function truncateToWidth(s: string, maxW: number, measure: Measure): { text: string; truncated: boolean } {
    let byM = truncMemo.get(measure);
    if (!byM) { byM = new Map(); truncMemo.set(measure, byM); }
    const key = maxW + "\u0000" + s;
    const hit = byM.get(key);
    if (hit) return { text: hit.text, truncated: hit.truncated };
    const r = truncateOnce(s, maxW, measure);
    byM.set(key, r);
    return { text: r.text, truncated: r.truncated };
}
function truncateOnce(s: string, maxW: number, measure: Measure): { text: string; truncated: boolean } {
    if (measure(s) <= maxW) return { text: s, truncated: false };
    const g = graphemes(s);
    let lo = 0, hi = g.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measure(g.slice(0, mid).join("").trimEnd() + ELLIPSIS) <= maxW) lo = mid; else hi = mid - 1;
    }
    if (lo === 0) return { text: measure(ELLIPSIS) <= maxW ? ELLIPSIS : "", truncated: true };
    return { text: g.slice(0, lo).join("").trimEnd() + ELLIPSIS, truncated: true };
}

/** Greedy word wrap into at most `maxLines`; a word wider than the line breaks by grapheme
 *  (CJK has no spaces); text left over truncates the last line with an ellipsis. */
export function wrapLines(s: string, maxW: number, maxLines: number, measure: Measure): { lines: string[]; truncated: boolean } {
    const words = s.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = "";
    let i = 0;
    const pushPiece = (piece: string) => { lines.push(piece); };
    while (i < words.length && lines.length < maxLines) {
        const w = words[i];
        const trial = cur ? cur + " " + w : w;
        if (measure(trial) <= maxW) { cur = trial; i++; continue; }
        if (cur) { pushPiece(cur); cur = ""; continue; }
        // a single word wider than the line: take as many graphemes as fit
        const g = graphemes(w);
        let k = 0;
        while (k < g.length && measure(g.slice(0, k + 1).join("")) <= maxW) k++;
        if (k === 0) k = 1;
        pushPiece(g.slice(0, k).join(""));
        words[i] = g.slice(k).join("");
        if (!words[i]) i++;
    }
    if (cur && lines.length < maxLines) { lines.push(cur); cur = ""; }
    const rest = cur || i < words.length;
    if (!rest) return { lines, truncated: false };
    // Text is left over: the last line carries as much of it as fits, then an ellipsis. The joined
    // tail is always wider than the line (its first word did not fit), so truncation applies.
    const tail = [lines[lines.length - 1], cur, ...words.slice(i)].filter(Boolean).join(" ");
    lines[lines.length - 1] = truncateToWidth(tail, maxW, measure).text;
    return { lines, truncated: true };
}

// ─── A: leader-line labels ──────────────────────────────────────────────────────────────────

export const LEADER = { gap: 6, pad: 10, clear: 3, minCaption: 36 };

/** minRow (fix round 7, M4): the first label row from which this note's leader passes over no
 *  other note's marker (rows count down from the top; a lower row is a shorter leader). */
export interface LeaderNote { id: number; x: number; date: string; caption: string; minRow?: number; }
export interface LeaderPlaced {
    id: number; row: number; anchor: "end" | "start";
    left: number; right: number; x: number;
    date: string; caption: string; truncated: boolean;
}

/** Rows of labels above the plot, row 0 on top. A label sits on one side of its own leader
 *  ("end": right edge `gap` px left of the leader; "start": the mirror). A leader occupies its x
 *  from its own row down to the plot, so: a label may not contain (± clear) the x of any leader
 *  whose row is at or above the label's row, and a leader may not pass through any label at or
 *  below its row. Labels in one row keep `pad` px apart.
 *
 *  WHICH notes get a label is decided in priority order: a note is KEPT when the kept set plus it
 *  still lays out; otherwise it overflows and the kept set is unchanged. WHERE the kept set goes
 *  is decided by `arrangeLeaders`: rightmost leader first, each into the top-most row and side
 *  that is legal, so labels step down-and-left beside their leaders (the drawn look A). In that
 *  arrangement each label first tries its full caption in every row and side, then (only if no
 *  full position exists) a caption truncated to the room on that side up to the nearest blocking
 *  leader or label, never under `minCaption`.
 *  At most `maxTries` notes are tried; the rest overflow (bounds the cost at the row limit). */
export function placeLeaders(
    notes: LeaderNote[], band: { left: number; right: number; rows: number },
    measureDate: Measure, measureCaption: Measure, opts = LEADER, maxTries = 120,
    /** Fix round 6 item 3 (the visual's size guard): the row and side a smaller size gave each
     *  note; a hinted note tries that place first (full caption, then truncated), then the usual
     *  search. Every rule is unchanged. */
    hint?: Map<number, { row: number; anchor: "end" | "start" }>,
    /** Fix round 10 (R7): the notes kept are the longest PREFIX of `notes` that lays out: the first
     *  note that cannot be placed ends it, and every later note overflows (no later note is placed
     *  ahead of a dropped one). */
    prefix = false,
): { placed: LeaderPlaced[]; overflow: number[] } {
    let kept: LeaderNote[] = [];
    let placed: LeaderPlaced[] = [];
    const overflow: number[] = [];
    let tries = 0, stopped = false;
    for (const n of notes) {
        if (stopped || band.rows <= 0 || tries >= maxTries || (n.minRow ?? 0) >= band.rows) { overflow.push(n.id); stopped = prefix; continue; }
        tries++;
        const trial = arrangeLeaders(kept.concat([n]), band, measureDate, measureCaption, opts, hint);
        if (trial) { kept = kept.concat([n]); placed = trial; } else { overflow.push(n.id); stopped = prefix; }
    }
    // Fix round 10 (R7a item 2): the prefix is the LARGEST k whose first k notes the layout places
    // all of, each k laid out from scratch, not the first k whose addition fails: the layout runs
    // right to left, so adding a note can unblock one before it. Searched downward from the longest
    // prefix the hard limits allow (the try budget, a note whose shortest label needs a row the
    // band lacks); the first k that lays out wins.
    if (prefix && stopped && band.rows > 0) {
        let lim = kept.length;
        while (lim < notes.length && lim < maxTries && (notes[lim].minRow ?? 0) < band.rows) lim++;
        for (let k = lim; k > kept.length + 1; k--) {
            const trial = arrangeLeaders(notes.slice(0, k), band, measureDate, measureCaption, opts, hint);
            if (trial) {
                kept = notes.slice(0, k); placed = trial;
                const ids = new Set(kept.map(m => m.id));
                return { placed, overflow: notes.filter(m => !ids.has(m.id)).map(m => m.id) };
            }
        }
    }
    return { placed, overflow };
}

/** Lay out a whole set (see placeLeaders), or null when any member has no legal position. */
export function arrangeLeaders(
    notes: LeaderNote[], band: { left: number; right: number; rows: number },
    measureDate: Measure, measureCaption: Measure, opts = LEADER,
    hint?: Map<number, { row: number; anchor: "end" | "start" }>,
): LeaderPlaced[] | null {
    const placed: LeaderPlaced[] = [];
    const ok = (row: number, left: number, right: number, x: number): boolean => {
        if (left < band.left - 0.01 || right > band.right + 0.01) return false;
        for (const p of placed) {
            if (p.row === row && !(right + opts.pad <= p.left || left >= p.right + opts.pad)) return false;
            if (p.row <= row && p.x >= left - opts.clear && p.x <= right + opts.clear) return false;
            if (p.row >= row && x >= p.left - opts.clear && x <= p.right + opts.clear) return false;
        }
        return true;
    };
    const order = notes.slice().sort((a, b) => b.x - a.x || a.id - b.id);
    for (const n of order) {
        const dw = n.date ? measureDate(n.date) : 0;
        const cw = n.caption ? measureCaption(n.caption) : 0;
        let done: LeaderPlaced | null = null;
        const want = hint?.get(n.id);
        const tries: [number, number, "end" | "start"][] = [];
        if (want && want.row < band.rows) for (let pass = 0; pass < 2; pass++) tries.push([pass, want.row, want.anchor]);
        for (let pass = 0; pass < 2; pass++) for (let row = 0; row < band.rows; row++) for (const anchor of ["end", "start"] as const) tries.push([pass, row, anchor]);
        for (const [pass, row, anchor] of tries) {
            if (done) break;
            if (row < (n.minRow ?? 0)) continue;
            let caption = n.caption, truncated = false, w = dw + cw;
            const edge = anchor === "end" ? n.x - opts.gap : n.x + opts.gap;
            const room = anchor === "end" ? edge - band.left : band.right - edge;
            if (pass === 0 && w > room) continue;
            if (pass === 1) {
                // Truncate only when the full caption has no legal place on this side. The room
                // ends at the nearest blocker in this row on this side (a leader at or above the
                // row, less `clear`; a label in the row, less `pad`), else at the band edge, so a
                // truncated caption fits before it instead of overflowing (degradation step 2).
                let lim = anchor === "end" ? band.left : band.right;
                for (const p of placed) {
                    if (anchor === "end") {
                        if (p.row <= row && p.x < edge) lim = Math.max(lim, p.x + opts.clear + 0.01);
                        if (p.row === row && p.right <= edge) lim = Math.max(lim, p.right + opts.pad);
                    } else {
                        if (p.row <= row && p.x > edge) lim = Math.min(lim, p.x - opts.clear - 0.01);
                        if (p.row === row && p.left >= edge) lim = Math.min(lim, p.left - opts.pad);
                    }
                }
                const roomHere = anchor === "end" ? edge - lim : lim - edge;
                const capRoom = roomHere - dw;
                if (w <= roomHere || !n.caption || capRoom < opts.minCaption) continue;
                const t = truncateToWidth(n.caption, capRoom, measureCaption);
                caption = t.text; truncated = t.truncated; w = dw + measureCaption(caption);
            }
            const left = anchor === "end" ? edge - w : edge;
            const right = anchor === "end" ? edge : edge + w;
            if (ok(row, left, right, n.x)) { done = { id: n.id, row, anchor, left, right, x: n.x, date: n.date, caption, truncated }; break; }
        }
        if (!done) return null;
        placed.push(done);
    }
    return placed;
}

// ─── Geometry helpers ───────────────────────────────────────────────────────────────────────

export function inflate(r: Rect, d: number): Rect { return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d }; }
export function rectsOverlap(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function inside(r: Rect, x: number, y: number): boolean { return x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h; }
function segCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
    const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
    const o1 = o(ax, ay, bx, by, cx, cy), o2 = o(ax, ay, bx, by, dx, dy), o3 = o(cx, cy, dx, dy, ax, ay), o4 = o(cx, cy, dx, dy, bx, by);
    return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0;
}
/** Does segment (a,b) touch the interior of rect r? */
export function segmentHitsRect(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
    if (inside(r, ax, ay) || inside(r, bx, by)) return true;
    if (Math.max(ax, bx) <= r.x || Math.min(ax, bx) >= r.x + r.w || Math.max(ay, by) <= r.y || Math.min(ay, by) >= r.y + r.h) return false;
    const x0 = r.x, x1 = r.x + r.w, y0 = r.y, y1 = r.y + r.h;
    if (ax === bx || ay === by) return true; // axis-aligned and inside the bounding overlap
    return segCross(ax, ay, bx, by, x0, y0, x1, y0) || segCross(ax, ay, bx, by, x1, y0, x1, y1)
        || segCross(ax, ay, bx, by, x0, y1, x1, y1) || segCross(ax, ay, bx, by, x0, y0, x0, y1);
}

export interface Series { xs: number[]; ys: (number | null)[]; }

/** Does any drawn segment of the series (or an isolated drawn point) touch rect r? */
export function seriesHitsRect(s: Series, r: Rect): boolean {
    const n = s.xs.length;
    if (n === 0) return false;
    let i = Math.max(0, lowerBound(s.xs, r.x) - 1);
    for (; i < n; i++) {
        const x = s.xs[i], y = s.ys[i];
        if (x > r.x + r.w && (i === 0 || s.xs[i - 1] > r.x + r.w)) break;
        if (y === null) continue;
        const nx = i + 1 < n ? s.xs[i + 1] : null, ny = i + 1 < n ? s.ys[i + 1] : null;
        if (nx !== null && ny !== null && ny !== undefined) {
            if (segmentHitsRect(x, y, nx, ny, r)) return true;
        } else if (inside(r, x, y)) return true;
    }
    return false;
}

/** Distance between segments (a,b) and (c,d). */
export function segDist(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
    const pt = (px: number, py: number, sx: number, sy: number, ex: number, ey: number) => {
        const vx = ex - sx, vy = ey - sy, L = vx * vx + vy * vy;
        const t = L ? Math.max(0, Math.min(1, ((px - sx) * vx + (py - sy) * vy) / L)) : 0;
        return Math.hypot(px - sx - t * vx, py - sy - t * vy);
    };
    if (segCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
    return Math.min(pt(ax, ay, cx, cy, dx, dy), pt(bx, by, cx, cy, dx, dy), pt(cx, cy, ax, ay, bx, by), pt(dx, dy, ax, ay, bx, by));
}

/** Fix round 6 item 6 (look A): the lowest end, at most `y2`, of a vertical leader at x from y1
 *  down that keeps `need` px off every drawn segment and isolated point of the series (at a dip
 *  the line's flanks rise either side of the point, so the leader stops above them). Steps of
 *  1 px; returns y1 when no end below y1 is clear. */
export function leaderDropEnd(s: Series, breaks: boolean[] | undefined, x: number, y1: number, y2: number, need: number): number {
    const near = dropNear(s, breaks, x, need);
    const clear = (end: number) => near.every(([a, b, c, d]) => segDist(x, y1, x, end, a, b, c, d) >= need);
    for (let end = y2; end > y1; end -= 1) if (clear(end)) return end;
    return y1;
}

/** The drawn segments (and isolated points) of the series within `need` px of x. */
function dropNear(s: Series, breaks: boolean[] | undefined, x: number, need: number): [number, number, number, number][] {
    const n = s.xs.length;
    const near: [number, number, number, number][] = [];
    for (let i = Math.max(0, lowerBound(s.xs, x - need) - 1); i < n && s.xs[i] <= x + need; i++) {
        const y = s.ys[i];
        if (y === null || y === undefined) continue;
        const ny = i + 1 < n && !(breaks && breaks[i + 1]) ? s.ys[i + 1] : null;
        if (ny !== null && ny !== undefined) near.push([s.xs[i], y, s.xs[i + 1], ny]);
        const py = i > 0 && !(breaks && breaks[i]) ? s.ys[i - 1] : null;
        if ((py === null || py === undefined) && (ny === null || ny === undefined)) near.push([s.xs[i], y, s.xs[i], y]);
    }
    return near;
}

/** Fix round 9 (R3): leaderDropEnd for one leader (x, y2, need) at many label rows (y1), sharing one
 *  scan. Every ink near x lies at or below `ymin` (the highest drawn y there); for a point (x, y) above
 *  ymin the ink is never nearer than from (x, ymin), so for any y1 <= ymin the leader [y1, end] clears
 *  exactly when [min(ymin, end), end] does: the answer per end does not depend on y1. The first clear
 *  end of leaderDropEnd's order (y2, y2 - 1, ...) above y1 is returned, so the result is leaderDropEnd's. A y1 below ymin runs leaderDropEnd itself. */
export function leaderDropEndFor(s: Series, breaks: boolean[] | undefined, x: number, y2: number, need: number): (y1: number) => number {
    const near = dropNear(s, breaks, x, need);
    let ymin = Infinity;
    for (const [, b, , d] of near) ymin = Math.min(ymin, b, d);
    // A leader that clears stays clear when shortened (its points are a subset), so the clear ends
    // y2 - k form a run k >= k*: the first clear end of the 1 px scan is y2 - k*, found by bisection.
    // Above ymin - need every end is clear (no ink within need), which bounds the search.
    const clear = (end: number) => { const top = Math.min(ymin, end); return near.every(([a, b, c, d]) => segDist(x, top, x, end, a, b, c, d) >= need); };
    let first: number | null = null;
    return (y1: number): number => {
        if (!(y1 <= ymin)) return leaderDropEnd(s, breaks, x, y1, y2, need);
        if (first === null) {
            let lo = 0, hi = Number.isFinite(ymin) ? Math.max(0, Math.ceil(y2 - (ymin - need)) + 1) : 0;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (clear(y2 - mid)) hi = mid; else lo = mid + 1; }
            first = y2 - lo;
        }
        return first > y1 ? first : y1;
    };
}

// ─── B: callout cards ───────────────────────────────────────────────────────────────────────

export const CALLOUT = { padX: 9, gapToPoint: 14, gap: 6, lineClear: 3, markerClear: 5, maxW: 240, maxFrac: 0.6, levelStep: 4, maxLines: 2, tip: 5,
    /** Item 9 (fix round 3): a connector longer than this share of the plot width reads as a rule
     *  across the chart, not a pointer: the note goes to "+N more notes" instead. */
    maxLeaderFrac: 0.4,
    /** Item 9: a card keeps this clearance from every corner of the line (a vertex a few px from a
     *  card edge reads as touching it, high contrast most of all). */
    vertexClear: 8,
    /** Round 4 item 2: a connector keeps this far off a placed note's marker centre (the drawn
     *  marker radius is 4) and `leaderClear` px off every other note's connector. */
    markerR: 4.5, leaderClear: 2,
    /** Round 4 item 2: candidate count up to which a note without room re-lays the kept set out in anchor order. */
    arrangeMax: 30,
    /** Fix round 6 item 3: the bounded search after the anchor orders (set size, places per note,
     *  places tried over the whole call, so its cost is bounded however many notes are left out). */
    searchMax: 6, searchOptions: 64, searchNodes: 3000,
    /** Round 5 item 1: the longer gaps an elbow's drop may leave before the point when the 5 px
     *  tip would touch the line (a sharp peak or dip); never more than 12 px, so it still points. */
    tipSteps: [8, 12] as number[],
    /** Fix round 6 item 6: a connector keeps this far off the line's centre: half the line width
     *  plus half the connector width (1.2) plus a 0.5 px margin. The visual passes its own line
     *  width; 1.85 is the default 1.5 px line. */
    inkHalf: 1.85,
    /** Fix round 6 item 6: the longer gaps a beside connector may leave before the point when
     *  its 4 px start would touch the line (a slope through the point); never more than 12 px. */
    besideSteps: [8, 12] as number[],
    /** Fix round 7 (M3): the note font size (px) the card text is drawn at; the card title is one
     *  px larger. Card height and baselines come from it (cardMetrics). */
    noteSize: 11 };

/** Fix round 7 (M3): a card's text metrics for note font size `n` (title n + 1 bold, lines n):
 *  each baseline leaves the glyph ascent (0.95 em) above it and the descent (0.3 em) below, so
 *  text never overlaps text or spills past the card. At the default 11 px these are the fixed
 *  offsets every earlier round used (title 16, first line 31, line step 14, height 22 + 14 n). */
export function cardMetrics(n = 11): { title: number; first: number; step: number; bottom: number; empty: number } {
    const title = Math.max(16, Math.ceil(4 + 0.95 * (n + 1)));
    const first = title + Math.max(15, Math.ceil(1.25 * n + 1));
    const step = Math.max(14, Math.ceil(1.25 * n));
    const bottom = Math.max(5, Math.ceil(0.3 * n + 1));
    const empty = title + Math.max(10, Math.ceil(0.3 * (n + 1) + 3));
    return { title, first, step, bottom, empty };
}

export function calloutHeight(lines: number, noteSize = 11): number {
    const m = cardMetrics(noteSize);
    return lines > 0 ? m.first + (lines - 1) * m.step + m.bottom : m.empty;
}

export interface CalloutNote { id: number; px: number; py: number; title: string; caption: string; }
/** Where a smaller size put a card (the size guard's seed): its side and centre in card-area fractions. */
export interface CalloutHint { side: string; fx: number; fy: number; }
export interface CalloutPlaced { id: number; rect: Rect; title: string; lines: string[]; truncated: boolean; leader: [number, number][]; side: string;
    /** The placement tier (0 clean; 3 last resort; round 5: a connector over the line is never placed): the size guard compares it. */
    tier?: number; }
export interface CalloutCandidate { r: Rect; leader: [number, number][]; side: string; len: number; slide: number; }

export interface Envelope { x0: number; lo: number[]; hi: number[]; }

/** The vertical extent of the drawn ink in every 1 px column (column k covers x0+k .. x0+k+1):
 *  the series line (each segment's part inside the column, isolated points) and solid columns.
 *  Built once per placement, O(points + width), so a row's blocked spans cost O(width) (H1). */
export function inkEnvelope(series: Series,
    columns?: { xs: number[]; tops: (number | null)[]; bottoms: (number | null)[]; band: number }): Envelope {
    const n = series.xs.length;
    const hb = columns ? Math.max(0.5, columns.band / 2) : 0;
    let minX = Infinity, maxX = -Infinity;
    if (n) { minX = series.xs[0]; maxX = series.xs[n - 1]; }
    if (columns && columns.xs.length) { minX = Math.min(minX, columns.xs[0] - hb); maxX = Math.max(maxX, columns.xs[columns.xs.length - 1] + hb); }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return { x0: 0, lo: [], hi: [] };
    const x0 = Math.floor(minX), count = Math.floor(maxX) - x0 + 1;
    const lo: number[] = new Array(count).fill(Infinity), hi: number[] = new Array(count).fill(-Infinity);
    const put = (k: number, a: number, b: number) => {
        if (k < 0 || k >= count) return;
        const m = a < b ? a : b, M = a < b ? b : a;
        if (m < lo[k]) lo[k] = m;
        if (M > hi[k]) hi[k] = M;
    };
    for (let i = 0; i < n; i++) {
        const xa0 = series.xs[i], ya0 = series.ys[i];
        if (ya0 === null || ya0 === undefined) continue;
        const ya1 = i + 1 < n ? series.ys[i + 1] : null;
        if (ya1 === null || ya1 === undefined) { put(Math.floor(xa0) - x0, ya0, ya0); continue; }
        const xa1 = series.xs[i + 1];
        const k0 = Math.floor(xa0) - x0, k1 = Math.floor(xa1) - x0;
        if (xa1 <= xa0 || k0 === k1) { put(k0, ya0, ya1); continue; }
        const at = (x: number) => ya0 + (ya1 - ya0) * (x - xa0) / (xa1 - xa0);
        for (let k = k0; k <= k1; k++) {
            const l = Math.max(xa0, x0 + k), r = Math.min(xa1, x0 + k + 1);
            put(k, at(l), at(r));
        }
    }
    if (columns) {
        for (let i = 0; i < columns.xs.length; i++) {
            const top = columns.tops[i], bot = columns.bottoms[i];
            if (top === null || bot === null) continue;
            for (let k = Math.floor(columns.xs[i] - hb) - x0; k <= Math.floor(columns.xs[i] + hb) - x0; k++) put(k, top, bot);
        }
    }
    return { x0, lo, hi };
}

/** Blocked x-ranges for a card's own (uninflated) x-extent on rows y..y+h: every ink column whose
 *  extent reaches the row band widened by lineClear, itself widened by lineClear. Sorted, merged. */
// Fix round 6 item 8: the envelope as runs of equal [lo, hi] (computed once per envelope; an
// envelope is never changed after inkEnvelope returns it). On columns a run is a column's width
// or a gap, so a band query reads ~2 runs per column instead of every pixel column. Each run
// [k0, k1] gives exactly the merged per-pixel blocks [x0 + k0 - c, x0 + k1 + 1 + c].
const envRuns = new WeakMap<Envelope, { k0: number[]; k1: number[]; lo: number[]; hi: number[] }>();
function runsOf(env: Envelope): { k0: number[]; k1: number[]; lo: number[]; hi: number[] } {
    let r = envRuns.get(env);
    if (r) return r;
    r = { k0: [], k1: [], lo: [], hi: [] };
    for (let k = 0; k < env.lo.length; k++) {
        const n = r.k0.length;
        if (n && r.lo[n - 1] === env.lo[k] && r.hi[n - 1] === env.hi[k]) r.k1[n - 1] = k;
        else { r.k0.push(k); r.k1.push(k); r.lo.push(env.lo[k]); r.hi.push(env.hi[k]); }
    }
    envRuns.set(env, r);
    return r;
}

export function bandBlocks(env: Envelope, y: number, h: number, opts = CALLOUT): [number, number][] {
    const c = opts.lineClear, b0 = y - c, b1 = y + h + c;
    const out: [number, number][] = [];
    const R = runsOf(env);
    for (let i = 0; i < R.k0.length; i++) {
        if (!(R.hi[i] >= b0 && R.lo[i] <= b1)) continue;
        const a = env.x0 + R.k0[i] - c, b = env.x0 + R.k1[i] + 1 + c;
        const last = out[out.length - 1];
        if (last && a <= last[1]) last[1] = b; else out.push([a, b]);
    }
    return out;
}

const EPS = 0.02;

/** Card x positions on one row, nearest first: `dir` -1 = left of `edge` (the card's right edge
 *  at most `edge`), +1 = right of it (left edge at least `edge`). At most `max` positions, one per
 *  free gap between blocks, each as close to `edge` as its gap allows and no more than `maxDist`
 *  from it (a card never slides further than its own width: the connector would read as a rule). */
export function slideX(edge: number, w: number, dir: number, blocks: [number, number][], lo: number, hi: number, maxDist = Infinity, max = 2): number[] {
    const out: number[] = [];
    const m = blocks.length;
    if (dir < 0) {
        // Gaps right of the one holding `edge` cannot take a card that ends at or before `edge`.
        let k0 = 0, hiK = m;   // first block starting after `edge` (binary search)
        while (k0 < hiK) { const mid = (k0 + hiK) >> 1; if (blocks[mid][0] <= edge) k0 = mid + 1; else hiK = mid; }
        for (let k = k0; k >= 0 && out.length < max; k--) {
            const g0 = k > 0 ? blocks[k - 1][1] + EPS : -Infinity, g1 = k < m ? blocks[k][0] - EPS : Infinity;
            if (g1 < edge - maxDist) break;
            const right = Math.min(edge, g1, hi);
            if (right - w >= Math.max(g0, lo) && right >= edge - maxDist) out.push(right - w);
        }
    } else {
        let k1 = 0, hiK = m;   // first block ending at or after `edge`
        while (k1 < hiK) { const mid = (k1 + hiK) >> 1; if (blocks[mid][1] < edge) k1 = mid + 1; else hiK = mid; }
        for (let k = k1; k <= m && out.length < max; k++) {
            const g0 = k > 0 ? blocks[k - 1][1] + EPS : -Infinity, g1 = k < m ? blocks[k][0] - EPS : Infinity;
            if (g0 > edge + maxDist) break;
            const left = Math.max(edge, g0, lo);
            if (left + w <= Math.min(g1, hi) && left <= edge + maxDist) out.push(left);
        }
    }
    return out;
}

/** Every position a w x h card may take for the point (px, py), shortest connector first (H1).
 *  BESIDE: level with the point, right then left, slid along the row to the nearest gap the line
 *  leaves (connector level from the point). ELBOWS: on either side at every row of the plot (rows
 *  `levelStep` px apart from the plot top, plus the row flush with the floor), each slid to the
 *  nearest gap; the connector runs level from the card edge to the point's x, then drops (or
 *  rises) to `tip` px short of the point. Ranked by connector length; ties: beside, then above
 *  before below, right before left. `blocksAt` returns bandBlocks for a row. */
export function calloutCandidates(px: number, py: number, w: number, h: number, plot: Rect,
    blocksAt: (y: number, key: string) => [number, number][], opts = CALLOUT): CalloutCandidate[] {
    const out: { c: CalloutCandidate; rank: number }[] = [];
    const g = opts.gapToPoint, lo = plot.x, hi = plot.x + plot.w;
    const by = py - h / 2;
    if (by >= plot.y - 0.01 && by + h <= plot.y + plot.h + 0.01) {
        const bl = blocksAt(by, "beside");
        for (const x of slideX(px + g, w, 1, bl, lo, hi, w)) out.push({ c: { r: { x, y: by, w, h }, leader: [[px + 4, py], [x, py]], side: "right", len: x - px - 4, slide: x - (px + g) }, rank: 0 });
        for (const x of slideX(px - g, w, -1, bl, lo, hi, w)) out.push({ c: { r: { x, y: by, w, h }, leader: [[px - 4, py], [x + w, py]], side: "left", len: px - 4 - x - w, slide: (px - g) - (x + w) }, rank: 1 });
    }
    const step = Math.max(1, opts.levelStep);
    const rows: [number, string][] = [];
    for (let j = 0; plot.y + j * step + h <= plot.y + plot.h + 0.01; j++) rows.push([plot.y + j * step, String(j)]);
    rows.push([plot.y + plot.h - h, "floor"]);
    for (const [y, key] of rows) {
        if (y < plot.y - 0.01) continue;
        const midY = y + h / 2;
        const above = midY < py;
        const tipY = above ? py - opts.tip : py + opts.tip;
        if (above ? midY >= tipY : midY <= tipY) continue;   // level with the point: "beside" covers it
        const drop = Math.abs(midY - tipY);
        const vert = above ? "top" : "bottom";
        const bl = blocksAt(y, key);
        for (const x of slideX(px + g, w, 1, bl, lo, hi, w)) out.push({ c: { r: { x, y, w, h }, leader: [[x, midY], [px, midY], [px, tipY]], side: `${vert}-right`, len: (x - px) + drop, slide: x - (px + g) }, rank: above ? 2 : 4 });
        for (const x of slideX(px - g, w, -1, bl, lo, hi, w)) out.push({ c: { r: { x, y, w, h }, leader: [[x + w, midY], [px, midY], [px, tipY]], side: `${vert}-left`, len: (px - x - w) + drop, slide: (px - g) - (x + w) }, rank: above ? 3 : 5 });
    }
    out.sort((a, b) => a.c.len - b.c.len || a.rank - b.rank);
    return out.map(o => o.c);
}

export function placeCallouts(
    notes: CalloutNote[], plot: Rect, series: Series, markers: { x: number; y: number }[],
    measureTitle: Measure, measureBody: Measure, opts = CALLOUT,
    columns?: { xs: number[]; tops: (number | null)[]; bottoms: (number | null)[]; band: number },
    fill?: { zeroY: number },
    /** Round 4 item 2: allow the anchor-order re-layout. The visual decides it from the CANDIDATE
     *  count (not the notes tried), so every Label density sees the same rule. */
    arrange = notes.length <= opts.arrangeMax,
    /** Round 4 item 4 (the visual's size guard): where a smaller size put each card, as the card
     *  centre in card-area fractions and its side. A hinted note tries the candidates nearest
     *  that place first (same side first); the tiers and every rule are unchanged. */
    hint?: Map<number, CalloutHint>,
    /** Fix round 6 item 3: run the bounded search (the visual turns it off for its size-guard probes). */
    search = true,
    /** Fix round 10 (R7): keep the longest prefix of `notes` that places (see placeLeaders). */
    prefix = false,
    /** Fix round 10 (R7): at most this many notes are tried (the capacity from room alone). */
    capacity = Infinity,
): { placed: CalloutPlaced[]; overflow: number[]; skipped?: number[] } {
    // Area mode (H2): the share of a card lying between the line and the baseline, sampled in 12
    // columns. A card mostly over the fill hides the shape it annotates: a last resort.
    const overFill = (r: Rect, zeroY: number): number => {
        const n = series.xs.length;
        if (n === 0 || r.h <= 0) return 0;
        let under = 0;
        for (let k = 0; k < 12; k++) {
            const x = r.x + (k + 0.5) * r.w / 12;
            const i = lowerBound(series.xs, x);
            if (i <= 0 || i >= n) continue;
            const ya = series.ys[i - 1], yb = series.ys[i];
            if (ya === null || yb === null || ya === undefined || yb === undefined) continue;
            const xa = series.xs[i - 1], xb = series.xs[i];
            const ly = xb > xa ? ya + (yb - ya) * (x - xa) / (xb - xa) : ya;
            under += Math.max(0, Math.min(r.y + r.h, zeroY) - Math.max(r.y, ly));
        }
        return under / (12 * r.h);
    };
    // Columns mark: a card must clear every column it spans (xs ascending, so a binary search).
    const hitsColumn = (r: Rect): boolean => {
        if (!columns) return false;
        const half = Math.max(0.5, columns.band / 2) + opts.lineClear;
        for (let i = lowerBound(columns.xs, r.x - half); i < columns.xs.length && columns.xs[i] <= r.x + r.w + half; i++) {
            const top = columns.tops[i], bot = columns.bottoms[i];
            if (top === null || bot === null) continue;
            if (top - opts.lineClear < r.y + r.h && bot + opts.lineClear > r.y) return true;
        }
        return false;
    };
    const placed: CalloutPlaced[] = [];
    const overflow: number[] = [];
    const maxW = Math.min(opts.maxW, plot.w * opts.maxFrac);
    const inner = maxW - 2 * opts.padX;
    // Markers indexed by x: a candidate rect only scans the markers inside its x span (F2).
    const byX = markers.slice().sort((a, b) => a.x - b.x);
    const mx = byX.map(m => m.x);
    // Round 4 item 2 (round 3's T8 / T9 as hard rules): every connector is axis-aligned (a beside
    // run, or an elbow's run and drop), so a segment is its own box. A candidate's connector may
    // not touch a placed connector (boxes `leaderClear` apart) nor pass over a PLACED note's marker
    // (the marker centre inside the segment box grown by `markerR`), and its own marker may not lie
    // under a placed connector. A note without room keeps only a small hollow marker; connectors
    // may pass those (at the row limit 200 candidates leave one every few px).
    const segBox = (ax: number, ay: number, bx: number, by: number, d: number): Rect =>
        ({ x: Math.min(ax, bx) - d, y: Math.min(ay, by) - d, w: Math.abs(bx - ax) + 2 * d, h: Math.abs(by - ay) + 2 * d });
    const closedOverlap = (a: Rect, b: Rect): boolean => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
    const inBox = (r: Rect, x: number, y: number): boolean => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    const placedPts: [number, number][] = [];
    const leaderClash = (leader: [number, number][], px: number, py: number): boolean => {
        for (const p of placed) for (let j = 1; j < p.leader.length; j++) {
            const [cx, cy] = p.leader[j - 1], [dx, dy] = p.leader[j];
            if (inBox(segBox(cx, cy, dx, dy, opts.markerR), px, py)) return true;
        }
        for (let k = 1; k < leader.length; k++) {
            const [ax, ay] = leader[k - 1], [bx, by] = leader[k];
            const mb = segBox(ax, ay, bx, by, opts.markerR);
            for (const [qx, qy] of placedPts) if (inBox(mb, qx, qy)) return true;
            const lb = segBox(ax, ay, bx, by, opts.leaderClear / 2);
            for (const p of placed) for (let j = 1; j < p.leader.length; j++) {
                const [cx, cy] = p.leader[j - 1], [dx, dy] = p.leader[j];
                if (closedOverlap(lb, segBox(cx, cy, dx, dy, opts.leaderClear / 2))) return true;
            }
        }
        return false;
    };
    // Fix round 11 (A3): a place is legal when it passes both halves; the half that reads the cards
    // already placed is tested second, so a note whose places fail only there is known to have a
    // place on its own without trying it again with the cards taken away (R7a's alone test).
    const legalPlaced = (r: Rect, leader: [number, number][], px: number, py: number) => {
        if (leaderClash(leader, px, py)) return false;
        for (const p of placed) {
            if (rectsOverlap(inflate(r, opts.gap), p.rect)) return false;
            for (let k = 1; k < p.leader.length; k++) {
                const [ax, ay] = p.leader[k - 1], [bx, by] = p.leader[k];
                if (segmentHitsRect(ax, ay, bx, by, inflate(r, 2))) return false;
            }
            for (let k = 1; k < leader.length; k++) {
                const [ax, ay] = leader[k - 1], [bx, by] = leader[k];
                if (segmentHitsRect(ax, ay, bx, by, inflate(p.rect, 2))) return false;
            }
        }
        return true;
    };
    const legalAlone = (r: Rect) => {
        if (r.x < plot.x - 0.01 || r.y < plot.y - 0.01 || r.x + r.w > plot.x + plot.w + 0.01 || r.y + r.h > plot.y + plot.h + 0.01) return false;
        const box = inflate(r, opts.markerClear);
        for (let i = lowerBound(mx, box.x); i < byX.length && byX[i].x <= box.x + box.w; i++) if (inside(box, byX[i].x, byX[i].y)) return false;
        // Ink: every candidate comes from slideX over bandBlocks of the 1 px ink envelope, which
        // already keeps the card's own x-extent off every column whose ink reaches the card's rows
        // widened by lineClear, itself widened by lineClear. A series point inside the card grown
        // by lineClear lies in some column k whose [lo, hi] holds its y, so that column blocks
        // [k - lineClear, k + 1 + lineClear], which meets the card: such a card is never a
        // candidate. The exact per-point scan that stood here (seriesHitsRect, 60% of self time at
        // 10,000 notes, review 3) was therefore redundant and is gone (fix round 3, item 6); the
        // column test stays (columns pass an empty series).
        if (hitsColumn(r)) return false;
        // Item 9: clear of every CORNER of the line by vertexClear: a vertex whose neighbours both
        // stand at least 2 x vertexClear away in x (on a dense series the vertices are not corners
        // the eye sees, and lineClear already holds the card off the line). Binary search, then
        // the vertices under the grown card.
        const vc = opts.vertexClear, vb = inflate(r, vc), xs = series.xs, ys = series.ys;
        for (let i = lowerBound(xs, vb.x); i < xs.length && xs[i] <= vb.x + vb.w; i++) {
            const vy = ys[i];
            if (vy === null || vy === undefined || !inside(vb, xs[i], vy)) continue;
            if ((i === 0 || xs[i] - xs[i - 1] >= 2 * vc) && (i === xs.length - 1 || xs[i + 1] - xs[i] >= 2 * vc)) return false;
        }
        return true;
    };
    // A connector may not cross or touch the series line: each segment is tested as a strip
    // `inkHalf` px either side (fix round 6 item 6: the 1 px strip of rounds 3-5 let a connector
    // run 1 px from the centre of a 1.5 px line, its ink touching).
    const ink = opts.inkHalf;
    const leaderHitsSeries = (leader: [number, number][]): boolean => {
        for (let k = 1; k < leader.length; k++) {
            const [ax, ay] = leader[k - 1], [bx, by] = leader[k];
            const strip: Rect = { x: Math.min(ax, bx) - ink, y: Math.min(ay, by) - ink, w: Math.abs(bx - ax) + 2 * ink, h: Math.abs(by - ay) + 2 * ink };
            if (seriesHitsRect(series, strip)) return true;
        }
        return false;
    };
    // Fix round 6 items 2 and 7: a connector keeps `markerClear` off EVERY other candidate's
    // marker (a note without room keeps a small hollow marker, and a connector through it reads
    // as pointing at it), and on the Columns mark it enters no column: other columns grown by
    // `leaderClear`, its own column's interior (so a card below a column never drops up through it).
    const connectorBlocked = (leader: [number, number][], px: number, py: number): boolean => {
        for (let k = 1; k < leader.length; k++) {
            const [ax, ay] = leader[k - 1], [bx, by] = leader[k];
            const mb = segBox(ax, ay, bx, by, opts.markerClear);
            for (let i = lowerBound(mx, mb.x); i < byX.length && byX[i].x <= mb.x + mb.w; i++) {
                const m = byX[i];
                if (m.x === px && m.y === py) continue;
                if (inBox(mb, m.x, m.y)) return true;
            }
            if (columns) {
                const half = Math.max(0.5, columns.band / 2), lc = opts.leaderClear;
                const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
                for (let i = lowerBound(columns.xs, x0 - half - lc); i < columns.xs.length && columns.xs[i] <= x1 + half + lc; i++) {
                    const top = columns.tops[i], bot = columns.bottoms[i];
                    if (top === null || bot === null) continue;
                    const d = columns.xs[i] === px ? -0.5 : lc;
                    if (x1 > columns.xs[i] - half - d && x0 < columns.xs[i] + half + d && y1 > top - d && y0 < bot + d) return true;
                }
            }
        }
        return false;
    };
    // Round 5 item 1: the connector as drawn if it clears the line, else null. An elbow whose run
    // clears the line but whose drop meets it (a sharp peak or dip: both flanks close in on the
    // point, so the last px of the drop sit between them) stops further short of the point, at
    // most `tipMax` px, rather than touch the line.
    // Each segment is tested once (the run is shared by every tip): at the row limit the run of a
    // long elbow spans thousands of points, and testing it again per tip tripled the callout update
    // (10,000 notes: 582 ms at b1a04bc, 2003.5 ms before this). Same answer as testing whole leaders.
    const clearLeader = (leader: [number, number][]): [number, number][] | null => {
        if (leader.length === 2) {
            // Beside: a run level with the point from 4 px off it. Round 6 item 6: on a slope
            // through the point the line's ink reaches the first px, so the run starts 8, then
            // 12 px off the point instead (it still points), never past the card.
            if (!leaderHitsSeries(leader)) return leader;
            const [a, b] = leader, dir = Math.sign(b[0] - a[0]), px = a[0] - dir * 4;
            for (const s of opts.besideSteps) {
                const sx = px + dir * s;
                if (dir * (b[0] - sx) <= 0) return null;
                const l: [number, number][] = [[sx, a[1]], b];
                if (!leaderHitsSeries(l)) return l;
            }
            return null;
        }
        if (leader.length !== 3) return leaderHitsSeries(leader) ? null : leader;
        const [a, b, t] = leader;
        if (leaderHitsSeries([a, b])) return null;
        if (!leaderHitsSeries([b, t])) return leader;
        const dir = Math.sign(t[1] - b[1]), py = t[1] + dir * opts.tip;
        for (const tip of opts.tipSteps) {
            const ty = py - dir * tip;
            if (dir * (ty - b[1]) <= 0) return null;   // the drop is used up
            if (!leaderHitsSeries([b, [t[0], ty]])) return [a, b, [t[0], ty]];
        }
        return null;
    };
    const env = inkEnvelope(series, columns);
    const blockCache = new Map<string, [number, number][]>();
    // The best legal position for one note against the cards placed so far, or null.
    // Fix round 6 item 7: on Columns an elbow whose drop would run inside its own column (a card
    // below the column's top, or above a negative column's end) drops BESIDE the column: its
    // vertical leg moves to the column's edge on the card's side plus leaderClear + 0.5 px and
    // ends level with the point, 2.5 px off the column's side, so it points at that column however
    // wide the band. No room on that side: no connector.
    const columnLeg = (leader: [number, number][], px: number, py: number): [number, number][] | null => {
        if (!columns || leader.length !== 3) return leader;
        const i = lowerBound(columns.xs, px);
        if (i >= columns.xs.length || columns.xs[i] !== px) return leader;
        const top = columns.tops[i], bot = columns.bottoms[i];
        if (top === null || bot === null) return leader;
        const [a, b, t] = leader;
        if (!(Math.max(b[1], t[1]) > top + 0.5 && Math.min(b[1], t[1]) < bot - 0.5)) return leader;
        const dir = Math.sign(px - a[0]), off = Math.max(0.5, columns.band / 2) + opts.leaderClear + 0.5;
        if (dir === 0) return null;
        const x = px - dir * off;
        if (dir * (x - a[0]) <= 0) return null;
        return [a, [x, b[1]], [x, py]];
    };
    // Fix round 6 item 8: a note's text, size and candidate list depend only on the note (the bands
    // come from the ink envelope, fixed for this call), so they are built once per note, not on
    // every try (the anchor-order re-layout tries each kept note again for every new one).
    const sized = new Map<number, { t: { text: string; truncated: boolean }; wrapped: { lines: string[]; truncated: boolean }; cands: CalloutCandidate[] }>();
    /** `all` given (the search below): every legal place is collected there, in tier then
     *  candidate order, and the first is returned. `probe` given: `probe.alone` is set when the note
     *  has a legal place with no card placed (fix round 11, A3: the answer the alone test below
     *  gave by trying the note again with the cards taken away; every rule that reads a placed
     *  card only adds to the rules that do not, so a place legal with cards is legal without). */
    const tryPlace = (n: CalloutNote, all?: CalloutPlaced[], probe?: { alone: boolean }): CalloutPlaced | null => {
        let z = sized.get(n.id);
        if (!z) {
            const t = truncateToWidth(n.title, inner, measureTitle);
            const wrapped = n.caption ? wrapLines(n.caption, inner, opts.maxLines, measureBody) : { lines: [] as string[], truncated: false };
            const w = Math.min(maxW, Math.max(measureTitle(t.text), ...wrapped.lines.map(measureBody), 0) + 2 * opts.padX);
            const h = calloutHeight(wrapped.lines.length, opts.noteSize);
            const cands = calloutCandidates(n.px, n.py, w, h, plot, (y, key) => {
                if (key === "beside") return bandBlocks(env, y, h, opts);
                const k = `${h}|${key}`;
                let b = blockCache.get(k);
                if (!b) { b = bandBlocks(env, y, h, opts); blockCache.set(k, b); }
                return b;
            }, opts);
            z = { t, wrapped, cands };
            sized.set(n.id, z);
        }
        const { t, wrapped } = z;
        const { px, py } = n;
        let cands = z.cands;
        const want = hint?.get(n.id);
        if (want) {
            const tx = plot.x + want.fx * plot.w, ty = plot.y + want.fy * plot.h;
            const away = (c: CalloutCandidate) => (c.side === want.side ? 0 : 1e6) + Math.hypot(c.r.x + c.r.w / 2 - tx, c.r.y + c.r.h / 2 - ty);
            cands = cands.map(c => ({ c, d: away(c) })).sort((a, b) => a.d - b.d).map(o => o.c);
        }
        // Tiers, best first; within a tier the shortest connector wins (candidate order):
        //   0 clean card
        //   3 a LAST-RESORT card (H2): in Area mode more than half of it over the fill, or a stem
        //     longer than half the plot.
        // Fix round 5 item 1: a connector that crosses the line is NOT a tier (rounds 2-4 allowed it
        // as tiers 1 and 2): it is illegal, like a connector over another card. A note with no clean
        // place joins "+N more notes" (tooltip, accessible name and keyboard still reach it).
        // Item 6: the cheap half of the tier (last resort: stem, fill share) is read BEFORE legal(),
        // and a candidate that cannot beat the best tier found so far is skipped untested. The
        // first candidate of the lowest tier still wins, exactly as before.
        let hit: CalloutCandidate | undefined;
        let bestTier = Infinity;
        const maxLen = opts.maxLeaderFrac * plot.w;
        const found: [number, CalloutCandidate][] = [];
        for (const c of cands) {
            if (c.len > maxLen) continue;
            const stem = c.leader.length >= 3 ? Math.abs(c.leader[2][1] - c.leader[1][1]) : 0;
            const tier = stem > plot.h / 2 || (!!fill && overFill(c.r, fill.zeroY) > 0.5) ? 3 : 0;
            if (!all && tier >= bestTier) continue;
            const l0 = columnLeg(c.leader, px, py);
            if (!l0 || !legalAlone(c.r)) continue;
            if (!legalPlaced(c.r, l0, px, py)) {
                if (probe && !probe.alone) { const lc = clearLeader(l0); if (lc && !connectorBlocked(lc, px, py)) probe.alone = true; }
                continue;
            }
            // Every connector (elbow, or a beside run from 4 px off the point to the card) must clear the line.
            const leader = clearLeader(l0);
            if (!leader || connectorBlocked(leader, px, py)) continue;
            if (probe) probe.alone = true;
            const cc = leader === c.leader ? c : { ...c, leader };
            if (all) {
                found.push([tier, cc]);
                // The first `searchOptions` clean places are the answer: no need to test the rest.
                if (tier === 0 && found.filter(f => f[0] === 0).length >= opts.searchOptions) break;
                continue;
            }
            hit = cc; bestTier = tier;
            if (tier === 0) break;
        }
        const out = (c: CalloutCandidate, tier: number): CalloutPlaced => ({ id: n.id, rect: c.r, title: t.text, lines: wrapped.lines, truncated: t.truncated || wrapped.truncated, leader: c.leader, side: c.side, tier });
        if (all) {
            for (const tier of [0, 3]) for (const [k, c] of found) if (k === tier && all.length < opts.searchOptions) all.push(out(c, tier));
            return all[0] ?? null;
        }
        return hit ? out(hit, bestTier) : null;
    };
    const keep = (n: CalloutNote, p: CalloutPlaced) => { placed.push(p); placedPts.push([n.px, n.py]); };
    // WHICH notes get a card is decided in priority order, one note at a time, and a kept note is
    // never dropped, so a higher Label density (a longer prefix of the same order) never places
    // fewer. WHERE: first the note's best place among the cards already placed. Round 4 item 2:
    // when it has none (often only because a connector would cross one), the kept cards plus it
    // are laid out again in ANCHOR ORDER (left to right, then right to left); the first order that
    // places every one of them with no more connectors over the line is kept. Only on small charts (`arrange`: at most `arrangeMax`
    // candidates): at the row limit every left-out note re-laid the set out, 8.4 s at 10,000
    // notes (measured). Otherwise the note overflows.
    const kept: CalloutNote[] = [];
    const skipped: number[] = [];
    let budget = opts.searchNodes;
    let stopped = false;
    for (const n of notes) {
        if (stopped || inner < 40 || kept.length >= capacity) { overflow.push(n.id); stopped = prefix; continue; }
        const probe = { alone: false };
        const hit = tryPlace(n, undefined, prefix || arrange ? probe : undefined);
        if (hit) { keep(n, hit); kept.push(n); continue; }
        let arranged = false;
        // Fix round 11 (A3): a note with no legal place on its own cannot be placed by any order of
        // the kept cards, so neither re-layout runs for it (same result, as the search already did).
        if (arrange && kept.length > 0 && probe.alone) {
            const savedP = placed.slice(), savedQ = placedPts.slice();
            for (const dir of [1, -1]) {
                const set = kept.concat([n]).sort((a, b) => dir * (a.px - b.px) || a.id - b.id);
                placed.length = 0; placedPts.length = 0;
                let all = true;
                for (const m of set) { const h = tryPlace(m); if (!h) { all = false; break; } keep(m, h); }
                // (Round 5 item 1: no connector crosses the line in any layout, so the round 4
                // "no more crossings than before" condition is gone with the crossing tiers.)
                if (all) { arranged = true; break; }
            }
            // Fix round 6 item 3: both anchor orders failed. On a small set, a bounded search: the
            // set left to right, each note trying its first `searchOptions` legal places (tier, then
            // connector length) against the cards before it, backtracking, at most `searchNodes`
            // places tried in the whole call. Over a flat line the greedy order stacks every card on the lowest row
            // and each drop then runs through the next card (flat, 720x400: 2 cards, 440x300: 3).
            if (!arranged && search && kept.length + 1 <= opts.searchMax) {
                const set = kept.concat([n]).sort((a, b) => a.px - b.px || a.id - b.id);
                placed.length = 0; placedPts.length = 0;
                const dfs = (k: number): boolean => {
                    if (k === set.length) return true;
                    const opt: CalloutPlaced[] = [];
                    tryPlace(set[k], opt);
                    for (const p of opt) {
                        if (budget-- <= 0) return false;
                        keep(set[k], p);
                        if (dfs(k + 1)) return true;
                        placed.pop(); placedPts.pop();
                    }
                    return false;
                };
                // A note with no legal place even on its own (most of them: no room by the line,
                // the columns or the plot edge) cannot be placed by any order: no search, and its
                // places are not spent from the call's budget (round 11: never reached for one).
                arranged = dfs(0);
            }
            if (!arranged) { placed.length = 0; placed.push(...savedP); placedPts.length = 0; placedPts.push(...savedQ); }
        }
        if (arranged) kept.push(n); else {
            // Fix round 10 (R7a): a note with no legal place even on its own at this size is not a
            // candidate here: it is skipped and does not end the prefix. A candidate that cannot be
            // placed with the cards before it ends it.
            overflow.push(n.id);
            // Round 11 (A3): whether it has a place alone was read in the same pass (`probe`).
            if (prefix) {
                stopped = probe.alone;
                if (!probe.alone) skipped.push(n.id);
            }
        }
    }
    return skipped.length ? { placed, overflow, skipped } : { placed, overflow };
}


// ─── C: numbered pins ───────────────────────────────────────────────────────────────────────

export const PINS = { r: 8, stem: 6, levelStep: 18, gap: 1, columnClear: 2 };

export interface PinNote { id: number; x: number; top: number; }
export interface PinPlaced { id: number; cx: number; cy: number; level: number; top: number;
    /** The point's x (the stem's x); differs from cx only at a drawing edge (round 6 item 1). */
    x: number; }

/** `tops[i]`: the highest y the column i occupies (min of its top and the zero line), or null
 *  for no column. A pin sits above its own column at the first level whose circle clears every
 *  column within reach, the plot top, every placed pin and every placed stem, and whose own
 *  stem passes through no placed pin; levels climb until the plot top (no fixed count). At most
 *  `capacity` pins (the key's rows). */
export function placePins(
    notes: PinNote[], plot: Rect, columns: { xs: number[]; tops: (number | null)[]; band: number },
    capacity: number, opts = PINS,
    /** Fix round 6 item 1: the drawing's horizontal extent. A pin's centre stays at least
     *  r + 1 px inside it (with Content padding 0 a pin over the last point was half drawn);
     *  its stem stays on the point. Omitted: no clamp. */
    bounds?: { left: number; right: number },
    /** Fix round 10 (R7): keep the longest prefix of `notes` that places (see placeLeaders). */
    prefix = false,
): { placed: PinPlaced[]; overflow: number[] } {
    const placed: PinPlaced[] = [];
    const overflow: number[] = [];
    const reach = opts.r + Math.max(0.5, columns.band / 2);
    const minTopNear = (x: number, x2 = x) => {
        let m = Infinity;
        for (let i = lowerBound(columns.xs, Math.min(x, x2) - reach); i < columns.xs.length && columns.xs[i] <= Math.max(x, x2) + reach; i++) {
            const t = columns.tops[i];
            if (t !== null && t < m) m = t;
        }
        return m;
    };
    let stopped = false;
    for (const n of notes) {
        if (stopped || placed.length >= capacity) { overflow.push(n.id); stopped = prefix; continue; }
        let done: PinPlaced | null = null;
        const inset = opts.r + 1;
        const cx = bounds && bounds.right - bounds.left >= 2 * inset ? Math.max(bounds.left + inset, Math.min(bounds.right - inset, n.x)) : n.x;
        const near = minTopNear(n.x, cx);
        // Levels climb in levelStep until the circle would leave the plot top: a stem may grow as
        // tall as the plot (F5), so a dip between tall columns keeps its pin as the visual grows.
        // Round 5 item 2: the first level sits just clear of the tallest column within reach (not
        // a whole levelStep above its own): rev52 at 440x300 lost a pin that missed by 0.2 px,
        // whose next level left the plot, while 360x240 placed it (a larger visual, fewer pins).
        const base = Math.min(n.top - opts.r - opts.stem, near - opts.r - opts.columnClear);
        for (let level = 0; !done; level++) {
            const cy = base - level * opts.levelStep;
            if (!(cy - opts.r >= plot.y - 0.01)) break;   // written so a NaN top also stops the climb
            if (cy + opts.r + opts.columnClear > near + 0.01) continue;
            let clash = false;
            for (const q of placed) {
                if (Math.hypot(q.cx - cx, q.cy - cy) < 2 * opts.r + opts.gap) { clash = true; break; }
                if (Math.abs(q.cx - n.x) < opts.r + opts.gap && q.cy > cy && q.cy < n.top) { clash = true; break; }   // my stem through q
                if (Math.abs(q.x - cx) < opts.r + opts.gap && cy > q.cy && cy < q.top) { clash = true; break; }       // q's stem through me
            }
            if (!clash) done = { id: n.id, cx, cy, level, top: n.top, x: n.x };
        }
        if (done) placed.push(done); else { overflow.push(n.id); stopped = prefix; }
    }
    return { placed, overflow };
}
