"use strict";

import { formatModelNumber, formatModelNumberInUnitsCompact, numericSections } from "./shared/numberFormat";
import { scanSection, SectionScan, withDecimals, withExponent } from "./formatTokens";

// ─── Annotated Trend: value-axis labels (pure; fix round 2, M3) ────────────────────────────────
//
// The value axis reads in the MEASURE's own format: a percent measure shows "%", a currency
// measure keeps its symbol. Decimals come from the TICK STEP (never a fixed 1), so neighbouring
// ticks never print the same label: 0.2..0.9 steps by 0.25 and reads 0.00, 0.25, 0.50 ...
// Large values (largest tick at least 10,000) read compact (5K, 1.5M).
// Fix round 11 (A1): every label is the text of the shared formatModelNumber for the measure's
// format asked at the step's decimals (src/formatTokens.ts finds where the digits sit); nothing
// here prints digits of its own. With no format the axis asks for "0" at the step's decimals, so
// it prints no thousands separator (owner rule), as the cards and tooltips do.

/** Decimals that show every multiple of `step` exactly (2.5 -> 1, 0.25 -> 2, 50 -> 0).
 *  Fix round 7 (H3): the search starts at the step's own magnitude (5e-9 needs at least 9
 *  decimals), so a tiny step is never "an integer within tolerance" at 0 decimals. */
export function stepDecimals(step: number): number {
    if (!Number.isFinite(step) || step <= 0) return 0;
    const d0 = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
    for (let d = d0; d <= MAX_DEC; d++) {
        const k = step * Math.pow(10, d);
        if (Math.abs(k - Math.round(k)) < 1e-6 * Math.max(1, k)) return d;
    }
    return MAX_DEC;
}

const MAX_DEC = 20;
const COMPACT_FROM = 10000;
/** Fix round 7 (H3, M1): beyond compact "T" (and for fixed text longer than this) ticks read in
 *  scientific form, "5E-9", "1E308". */
const SCI_FROM = 1e15;
const FIXED_MAX_CHARS = 10;
const UNITS: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
/** .NET standard letters the axis reads at the step's decimals; "G", "X" and "D" label each tick in
 *  their own form; any other letter reads as no format. */
const STD = /^([PpEeNnFfCcDdGgXx])(\d{0,2})$/;
/** The predefined format NAMES the shared formatter reads (it is not a pattern: its letters are not
 *  literals). "Currency" labels as "C" does; the others carry no digits form and read as no format. */
const CURRENCY_NAME = /^ *currency *$/i;
const NAMED_FORMAT = /^ *(general( number)?|fixed|standard|percent|scientific|yes\/no|true\/false|on\/off) *$/i;
/** A currency sign in a custom section, as the shared formatter reads one ($, ¢ to ¥, the Unicode
 *  currency block; a locale tag "[$€-407]" carries "$"). */
const CURRENCY_MARK = /[$¢-¥₠-⃏]/;

/** One section's labeller over the magnitudes it labels: text for |v| (and its sign, which the
 *  shared formatter places). */
type Body = (v: number) => string;

/** A labeller for the ticks of one axis: `ticks` ascending multiples of `step`, `format` the
 *  measure's model format string (or null), `locale` the host locale.
 *  A negative tick uses the format's own negative section when it has one ("($2,000)"), else the
 *  shared formatter's minus; zero uses the positive section (a literal-only zero section is a word,
 *  not a position on a scale). Fix round 7 (H3): neighbouring ticks never print the same text: when
 *  the chosen form would repeat a label it gains decimals, then falls back to exponent form.
 *  Fix round 8 (H3): a negative tick takes its unit (x100 for %) and precision from its OWN section:
 *  with "0%;(0.00)" the tick -0.4 reads (0.40), never (40). */
export function axisLabeller(ticks: number[], step: number, format: string | null | undefined, locale: string): (v: number) => string {
    const isZero = (v: number): boolean => !(Math.abs(v) >= Math.abs(step) * 1e-6);
    const absMax = ticks.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const named = format && NAMED_FORMAT.test(format);
    if (format && CURRENCY_NAME.test(format)) return standardLabeller("C", null, ticks, step, absMax, locale, isZero);
    const f = format && format.trim() && !named ? format : "";
    const std = STD.exec(f.trim());
    if (std) return standardLabeller(std[1], std[2] === "" ? null : +std[2], ticks, step, absMax, locale, isZero);
    const custom = f && !/^[A-Za-z]\d{0,2}$/.test(f.trim()) ? f : "0";
    const sections = numericSections(custom);
    const pos = sections[0];
    const neg = sections.length > 1 && sections[1] !== "" && scanSection(sections[1]).hasDigits ? sections[1] : null;
    const posTicks = neg ? ticks.filter(v => isZero(v) || v > 0) : ticks;
    const negTicks = neg ? ticks.filter(v => !isZero(v) && v < 0) : [];
    // Each section's form is chosen over the ticks it labels, the same rule for both.
    const posForm = sectionForm(pos, null, posTicks, step, absMax, locale, isZero);
    const negForm = neg ? sectionForm(neg, pos, negTicks, step, absMax, locale, isZero) : null;
    return v => {
        if (isZero(v)) return posForm(0);
        if (v < 0 && negForm) return negForm(v);
        return posForm(v);
    };
}

/** The labeller of one custom section. For the negative section `posSection` is the positive one,
 *  so the shared formatter is handed "positive;negative" and picks the negative section itself. */
function sectionForm(section: string, posSection: string | null, ticks: number[], step: number, absMax: number, locale: string, isZero: (v: number) => boolean): Body {
    const sc: SectionScan = scanSection(section);
    const scale = sc.scale;
    const maxAbs = absMax * scale;
    const overflow = !Number.isFinite(maxAbs) || !Number.isFinite(step * scale);
    const fmt = (s: string): string => posSection === null ? s : `${posSection};${s}`;
    const text = (v: number, s: string): string => formatModelNumber(isZero(v) ? 0 : v, fmt(s), locale);
    // Body length (no literals) for the "text too long" test: the digits at that form, as before.
    const bare = (d: number, opt: boolean) => (a: number, u = 1): number =>
        formatModelNumber(a * scale / u, (sc.grouping && !opt && !sc.percent ? "#,0" : "0") + (d > 0 ? "." + (opt ? "#" : "0").repeat(d) : ""), locale).length;
    const fixed = (d: number): Body => { const s = withDecimals(section, sc, d); return v => text(v, s); };
    const sci = (d: number): Body => {
        const s = withExponent(section, sc, d);
        // A zero tick in a section with no exponent of its own reads "0", not "0E0".
        const z = sc.sciAt >= 0 ? s : withDecimals(section, sc, 0);
        return v => isZero(v) ? text(0, z) : text(v, s);
    };
    const compact = (d: number): Body => {
        const forms = UNITS.map(([u, l]) => [u, withDecimals(section, sc, d, true, l), l] as [number, string, string]);
        const none = withDecimals(section, sc, d, true);
        // A currency section under display units prints through the shared formatter's compact units
        // path: text inside the plot drops trailing fraction zeros ("$500K", "$1M", "$1.5M"; owner
        // rulings 2026-11-22; tooltips and cards keep 2 decimals).
        // A step that needs more than 2 decimals keeps its own form (2 would repeat a label).
        const money = CURRENCY_MARK.test(section) && d <= 2;
        return v => {
            const a = Math.abs(v) * scale;
            const hit = forms.find(([u]) => a >= u * (1 - 5e-16));
            if (!hit) return text(v, none);
            return money ? formatModelNumberInUnitsCompact(v, fmt(none), hit[0], hit[2], locale) : text(v / hit[0], hit[1]);
        };
    };
    const compactLen = (d: number) => (a: number): number => {
        const x = a * scale, hit = UNITS.find(([u]) => x >= u * (1 - 5e-16));
        return hit ? bare(d, true)(a, hit[0]) + 1 : bare(d, true)(a);
    };
    const distinct = (b: Body): boolean => {
        const ls = ticks.map(v => b(isZero(v) ? 0 : v));
        for (let i = 1; i < ls.length; i++) if (ls[i] === ls[i - 1]) return false;
        return true;
    };
    const longest = (len: (a: number) => number): number => ticks.reduce((m, v) => Math.max(m, len(Math.abs(v))), 0);
    let body: Body | null = null;
    if (sc.sciAt >= 0) {
        for (let d = sc.fracDigits; d <= MAX_DEC && !body; d++) if (distinct(sci(d))) body = sci(d);
    } else if (overflow) {
        // handled by the exponent fallback below
    } else if (sc.percent) {
        for (let d = stepDecimals(step * scale); d <= MAX_DEC && !body; d++) {
            if (longest(bare(d, false)) > FIXED_MAX_CHARS) break;
            if (distinct(fixed(d))) body = fixed(d);
        }
    } else if (maxAbs >= SCI_FROM) {
        // handled by the exponent fallback below
    } else if (maxAbs >= COMPACT_FROM) {
        const unit = maxAbs >= 1e12 ? 1e12 : maxAbs >= 1e9 ? 1e9 : maxAbs >= 1e6 ? 1e6 : 1e3;
        for (let d = stepDecimals(step * scale / unit); d <= MAX_DEC && !body; d++) {
            if (longest(compactLen(d)) > FIXED_MAX_CHARS) break;
            if (distinct(compact(d))) body = compact(d);
        }
    } else {
        for (let d = stepDecimals(step * scale); d <= MAX_DEC && !body; d++) {
            if (longest(bare(d, false)) > FIXED_MAX_CHARS) break;
            if (distinct(fixed(d))) body = fixed(d);
        }
    }
    if (!body) {
        for (let d = 0; d <= MAX_DEC && !body; d++) if (distinct(sci(d))) body = sci(d);
        if (!body) body = sci(MAX_DEC);
    }
    return body;
}

/** A .NET standard format on the axis: "N", "F", "C", "P" and "E" at the step's decimals ("N1"),
 *  "G", "X" and "D" in their own form per tick; compact and exponent fallbacks keep the text the
 *  letter puts around the digits (a currency symbol, " %"). */
function standardLabeller(letter: string, n: number | null, ticks: number[], step: number, absMax: number, locale: string, isZero: (v: number) => boolean): (v: number) => string {
    const L = letter.toUpperCase();
    const at = (v: number, f: string): string => formatModelNumber(isZero(v) ? 0 : v, f, locale);
    const distinct = (b: Body): boolean => {
        const ls = ticks.map(v => b(isZero(v) ? 0 : v));
        for (let i = 1; i < ls.length; i++) if (ls[i] === ls[i - 1]) return false;
        return true;
    };
    // The text the letter prints around the digits of 1 (C0: "$1" -> "$" before; P0: "100 %").
    const around = (): string => {
        if (L === "P") return "0 %";
        const one = at(1, letter + "0"), m = /[0-9]+/.exec(one);
        if (!m) return "0";
        const q = (s: string): string => (s ? `"${s.replace(/"/g, "")}"` : "");
        return `${q(one.slice(0, m.index))}0${q(one.slice(m.index + m[0].length))}`;
    };
    const custom = around();
    const sc = scanSection(custom);
    const scale = L === "P" ? 100 : 1;
    const maxAbs = absMax * scale;
    const sci = (d: number): Body => { const s = withExponent(custom, sc, d), z = withDecimals(custom, sc, 0); return v => isZero(v) ? at(0, z) : at(v, s); };
    const bare = (d: number, opt: boolean, u = 1) => (a: number): number =>
        formatModelNumber(a * scale / u, (L === "F" || L === "E" || L === "P" || opt ? "0" : "#,0") + (d > 0 ? "." + (opt ? "#" : "0").repeat(d) : ""), locale).length;
    const longest = (len: (a: number) => number): number => ticks.reduce((m, v) => Math.max(m, len(Math.abs(v))), 0);
    let body: Body | null = null;
    if (L === "G" || L === "X" || L === "D") {
        const b: Body = v => at(v, `${letter}${n === null ? "" : n}`);
        if (distinct(b)) body = b;
    } else if (L === "E") {
        for (let d = n === null ? 6 : n; d <= MAX_DEC && !body; d++) { const b: Body = v => at(v, `${letter}${d}`); if (distinct(b)) body = b; }
        // E is already the exponent form: where no precision tells the ticks apart (subnormal
        // values that round to one tick) the letter's own precision labels them, never the custom
        // exponent fallback (it printed "0E0E+000": the letter's "E+000" read as text).
        if (!body) body = v => at(v, `${letter}${n === null ? 6 : n}`);
    } else if (!Number.isFinite(maxAbs) || !Number.isFinite(step * scale)) {
        // exponent fallback below
    } else if (L === "P") {
        for (let d = stepDecimals(step * scale); d <= MAX_DEC && !body; d++) {
            if (longest(bare(d, false)) > FIXED_MAX_CHARS) break;
            const b: Body = v => at(v, `${letter}${d}`);
            if (distinct(b)) body = b;
        }
    } else if (maxAbs >= SCI_FROM) {
        // exponent fallback below
    } else if (maxAbs >= COMPACT_FROM) {
        const unit = maxAbs >= 1e12 ? 1e12 : maxAbs >= 1e9 ? 1e9 : maxAbs >= 1e6 ? 1e6 : 1e3;
        for (let d = stepDecimals(step * scale / unit); d <= MAX_DEC && !body; d++) {
            const forms = UNITS.map(([u, l]) => [u, withDecimals(custom, sc, d, true, l), l] as [number, string, string]);
            const none = withDecimals(custom, sc, d, true);
            // "C" under display units: the shared compact units path ("$1.5M"; owner rulings 2026-11-22).
            const b: Body = v => {
                const a = Math.abs(v), hit = forms.find(([u]) => a >= u * (1 - 5e-16));
                if (!hit) return at(v, none);
                return L === "C" && d <= 2 ? formatModelNumberInUnitsCompact(v, none, hit[0], hit[2], locale) : at(v / hit[0], hit[1]);
            };
            const len = (a: number): number => { const hit = UNITS.find(([u]) => a >= u * (1 - 5e-16)); return hit ? bare(d, true, hit[0])(a) + 1 : bare(d, true)(a); };
            if (longest(len) > FIXED_MAX_CHARS) break;
            if (distinct(b)) body = b;
        }
    } else {
        for (let d = stepDecimals(step * scale); d <= MAX_DEC && !body; d++) {
            if (longest(bare(d, false)) > FIXED_MAX_CHARS) break;
            const b: Body = v => at(v, `${letter}${d}`);
            if (distinct(b)) body = b;
        }
    }
    if (!body) {
        for (let d = 0; d <= MAX_DEC && !body; d++) if (distinct(sci(d))) body = sci(d);
        if (!body) body = sci(MAX_DEC);
    }
    return body;
}
