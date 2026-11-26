"use strict";

// ─── Annotated Trend: where the digits sit in a model format string (pure) ─────────────────────
//
// Fix round 11 (A1, owner 2026-11-21: "Yes shared format for numbers"): every number this visual
// prints is TEXT from the shared formatModelNumber (src/shared/numberFormat.ts), the suite's one
// reading of a Power BI format string. This file prints nothing. It only finds the digit
// placeholders of one section so the value axis can ask the shared formatter for the same format at
// the tick step's decimals ("#,0" with ticks 0, 2.5, 5 is asked for "#,0.0"), in compact form
// ("$#,0.#\"K\"" on the value divided by 1000) or in exponent form ("0.##E0"). Sections are split
// with the shared numericSections, so a section here is the section the shared formatter reads.
//
// Round 3 to round 10 printed through this file's own formatter (formatNumber, sectionBody,
// sciBody, generalBody, hexBody, localeMinus, currencyAffixes): removed in round 11, see
// tests/README.md.

/** One section read for its digit run: [runStart, runEnd) in the section text is the run of digit
 *  placeholders with the "." and "," that touch it; `intEnd` is where its integer part ends (at the
 *  "." or the trailing scaling commas); `commas` the scaling commas after the last digit; `sciAt`
 *  the offset of an exponent ("E+00") after the run, -1 for none. `scale` is the unit the section's
 *  unquoted % and per mille apply (x100, x1000) and its scaling commas (x0.001 each). */
export interface SectionScan {
    hasDigits: boolean;
    runStart: number;
    runEnd: number;
    intEnd: number;
    commas: number;
    grouping: boolean;
    percent: boolean;
    scale: number;
    sciAt: number;
    fracDigits: number;
}

type Tok = { k: "lit" | "ph" | "op" | "sci"; c: string; s: number; e: number };

function tokens(section: string): Tok[] {
    const out: Tok[] = [];
    for (let i = 0; i < section.length; i++) {
        const ch = section[i];
        if (ch === '"' || ch === "'") {
            const end = section.indexOf(ch, i + 1);
            const stop = end < 0 ? section.length : end;
            out.push({ k: "lit", c: ch, s: i, e: stop + 1 });
            i = stop;
        } else if (ch === "\\" || ch === "_" || ch === "*") {
            out.push({ k: "lit", c: ch, s: i, e: Math.min(section.length, i + 2) });
            i++;
        } else if (ch === "[") {
            const end = section.indexOf("]", i + 1);
            const stop = end < 0 ? section.length : end;
            out.push({ k: "lit", c: ch, s: i, e: stop + 1 });
            i = stop;
        } else if ((ch === "E" || ch === "e") && /^[+-]?0/.test(section.slice(i + 1))) {
            let j = i + 1;
            if (section[j] === "+" || section[j] === "-") j++;
            while (section[j] === "0") j++;
            out.push({ k: "sci", c: ch, s: i, e: j });
            i = j - 1;
        } else if (ch === "0" || ch === "#" || ch === "." || ch === ",") {
            out.push({ k: "ph", c: ch, s: i, e: i + 1 });
        } else if (ch === "%" || ch === "‰") {
            out.push({ k: "op", c: ch, s: i, e: i + 1 });
        } else {
            out.push({ k: "lit", c: ch, s: i, e: i + 1 });
        }
    }
    return out;
}

const isDigit = (t: Tok | undefined): boolean => !!t && t.k === "ph" && (t.c === "0" || t.c === "#");

/** Read one section (see SectionScan). */
export function scanSection(section: string): SectionScan {
    const toks = tokens(section);
    const sciK = toks.findIndex(t => t.k === "sci");
    const lim = sciK >= 0 ? sciK : toks.length;
    let scale = 1, percent = false;
    for (const t of toks) {
        if (t.k === "op" && t.c === "%") { scale *= 100; percent = true; }
        else if (t.k === "op") scale *= 1000;
    }
    // A "." or "," belongs to the number only next to a digit placeholder (through other . and ,).
    const near = (k: number): boolean => {
        for (let j = k - 1; j >= 0 && toks[j].k === "ph"; j--) if (isDigit(toks[j])) return true;
        for (let j = k + 1; j < lim && toks[j].k === "ph"; j++) if (isDigit(toks[j])) return true;
        return false;
    };
    const ph: number[] = [];
    for (let k = 0; k < lim; k++) if (toks[k].k === "ph" && (isDigit(toks[k]) || near(k))) ph.push(k);
    if (!ph.length) return { hasDigits: false, runStart: section.length, runEnd: section.length, intEnd: section.length, commas: 0, grouping: false, percent, scale, sciAt: sciK >= 0 ? toks[sciK].s : -1, fracDigits: 0 };
    const first = ph[0], last = ph[ph.length - 1];
    const dot = ph.find(k => toks[k].c === ".");
    const digits = ph.filter(k => isDigit(toks[k]));
    const lastDigit = digits[digits.length - 1];
    let commas = 0;
    for (const k of ph) if (k > lastDigit && toks[k].c === ",") commas++;
    const intLastDigit = digits.filter(k => dot === undefined || k < dot).pop();
    const firstDigit = digits[0];
    const grouping = ph.some(k => toks[k].c === "," && k > firstDigit && intLastDigit !== undefined && k < intLastDigit);
    const intEnd = dot !== undefined ? toks[dot].s : (intLastDigit !== undefined ? toks[intLastDigit].e : toks[first].s);
    for (let i = 0; i < commas; i++) scale /= 1000;
    const fracDigits = dot === undefined ? 0 : digits.filter(k => k > dot).length;
    return { hasDigits: true, runStart: toks[first].s, runEnd: toks[last].e, intEnd, commas, grouping, percent, scale, sciAt: sciK >= 0 ? toks[sciK].s : -1, fracDigits };
}

/** `section` with its digit run asked for `d` decimals: `opt` writes them as "#" (trailing zeros
 *  dropped), else "0". `unit` (a quoted literal such as "K") follows the run. A section with no
 *  digits gets a plain "0" run after its text. */
export function withDecimals(section: string, sc: SectionScan, d: number, opt = false, unit = ""): string {
    const frac = d > 0 ? "." + (opt ? "#" : "0").repeat(d) : "";
    const tail = unit ? `"${unit}"` : "";
    if (!sc.hasDigits) return `${section}0${frac}${tail}`;
    const intText = section.slice(sc.runStart, sc.intEnd).replace(/,+$/, "");
    return `${section.slice(0, sc.runStart)}${intText}${frac}${",".repeat(sc.commas)}${tail}${section.slice(sc.runEnd)}`;
}

/** `section` with its digit run in exponent form at up to `d` mantissa decimals ("0.##E0"; no
 *  "+" on a positive exponent). An exponent the section already has is kept, with `d` decimals. */
export function withExponent(section: string, sc: SectionScan, d: number): string {
    if (sc.sciAt >= 0) return withDecimals(section, sc, d);
    const run = `0${d > 0 ? "." + "#".repeat(d) : ""}E0`;
    if (!sc.hasDigits) return `${section}${run}`;
    return `${section.slice(0, sc.runStart)}${run}${section.slice(sc.runEnd)}`;
}
