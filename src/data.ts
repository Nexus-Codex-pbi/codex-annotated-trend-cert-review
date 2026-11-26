"use strict";

// ─── Annotated Trend: data reading (pure, no DOM, no Power BI host) ─────────────────────────
// One categorical DataView carries everything (capabilities.json):
//   Axis          (Grouping)  one row per date or ordered category
//   Values        (Measure)   the trend
//   Event note    (Measure)   free text, BLANK on rows without an event
//   Event type    (Measure)   optional text (tooltip and accessible name)
//   Note priority (Measure)   optional number: higher keeps its note first when room runs out
// Events therefore live in a second table related to the date table, surfaced per axis row by
// measures (e.g. CONCATENATEX(VALUES(Events[Note]), Events[Note], " · ")). See README.md.
//
// Policy 1180.2.4: a blank, text, NaN or infinite reading is NEVER coerced to 0. Each keeps its
// own state; only "ok" points are plotted, and every other state has a designed rendering
// (gap in the line, hollow marker on the baseline, tooltip wording, footer notice).

export type ValueState = "ok" | "blank" | "text" | "nonfinite";

export interface ColumnIn {
    values: unknown[];
    displayName: string;
    format?: string | null;
    /** Axis only: the column is typed dateTime by the model. */
    isDate?: boolean;
}

export interface ParseIn {
    axis?: ColumnIn;
    value?: ColumnIn;
    note?: ColumnIn;
    type?: ColumnIn;
    priority?: ColumnIn;
    tooltips?: ColumnIn[];
}

export interface Reading {
    value: number | null;
    state: ValueState;
    raw: unknown;
}

export interface Point {
    /** Original DataView row index: selection ids, tooltips and objects use THIS, never the sorted index. */
    row: number;
    axisRaw: unknown;
    /** Epoch ms on a date axis, else null. */
    t: number | null;
    reading: Reading;
    note: string | null;
    type: string | null;
    priority: Reading | null;
}

export interface ParseOut {
    points: Point[];
    dateAxis: boolean;
    /** Rows dropped because a date axis value was blank or not a date (counted, shown as a notice). */
    blankAxisRows: number;
    textValues: number;
    nonFiniteValues: number;
    blankValues: number;
    numericCount: number;
}

/** 1180.2.4: classify a measure reading without ever producing 0 for blank or text. */
export function readNumber(raw: unknown): Reading {
    if (raw === null || raw === undefined) return { value: null, state: "blank", raw };
    if (typeof raw === "string") {
        const s = raw.trim();
        if (s === "") return { value: null, state: "blank", raw };
        // A numeric-looking string from a text measure is still text: the model said it is text.
        return { value: null, state: "text", raw };
    }
    if (typeof raw === "boolean") return { value: null, state: "text", raw };
    if (typeof raw === "number") {
        if (!Number.isFinite(raw)) return { value: null, state: "nonfinite", raw };
        return { value: raw, state: "ok", raw };
    }
    if (raw instanceof Date) return { value: null, state: "text", raw };
    return { value: null, state: "text", raw };
}

/** Free text for a note / type: blank and whitespace-only are "no event"; numbers become their string. */
export function readText(raw: unknown): string | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
    // A date-typed cell is local midnight (that is how Power BI sends it): format from the LOCAL
    // calendar day. toISOString() is UTC and named the previous day east of Greenwich.
    if (raw instanceof Date) return isNaN(raw.getTime()) ? null : localDay(raw);
    const s = String(raw);
    return s.trim() === "" ? null : s.trim();
}

/** YYYY-MM-DD of the local calendar day. */
export function localDay(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function asTime(raw: unknown): number | null {
    if (raw instanceof Date) { const t = raw.getTime(); return isNaN(t) ? null : t; }
    if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
        const t = new Date(raw.length === 10 ? raw + "T00:00:00" : raw).getTime();
        return isNaN(t) ? null : t;
    }
    return null;
}

export function parsePoints(input: ParseIn): ParseOut {
    const out: ParseOut = { points: [], dateAxis: false, blankAxisRows: 0, textValues: 0, nonFiniteValues: 0, blankValues: 0, numericCount: 0 };
    const axis = input.axis, value = input.value;
    if (!axis || !value) return out;
    const n = axis.values.length;
    const dateAxis = !!axis.isDate;
    out.dateAxis = dateAxis;
    for (let i = 0; i < n; i++) {
        const axisRaw = axis.values[i];
        let t: number | null = null;
        if (dateAxis) {
            t = asTime(axisRaw);
            if (t === null) { out.blankAxisRows++; continue; }
        }
        const reading = readNumber(value.values[i]);
        if (reading.state === "text") out.textValues++;
        else if (reading.state === "nonfinite") out.nonFiniteValues++;
        else if (reading.state === "blank") out.blankValues++;
        else out.numericCount++;
        out.points.push({
            row: i, axisRaw, t, reading,
            note: input.note ? readText(input.note.values[i]) : null,
            type: input.type ? readText(input.type.values[i]) : null,
            priority: input.priority ? readNumber(input.priority.values[i]) : null,
        });
    }
    if (dateAxis) {
        // Power BI usually sends a date axis sorted, but an author can sort the visual by Values.
        // Draw in time order; `row` keeps the DataView index for identities (sort-desync rule).
        out.points.sort((a, b) => (a.t as number) - (b.t as number) || a.row - b.row);
    }
    return out;
}

// ─── Date grain and labels ──────────────────────────────────────────────────────────────────

export type Grain = "year" | "month" | "day" | "time";

/** Year when every date is 1 Jan midnight, month when every date is a 1st at midnight, day when
 *  every date is midnight, else time. A single date reads as its own finest true grain. */
export function detectGrain(times: number[]): Grain {
    if (times.length === 0) return "day";
    let allMidnight = true, allFirst = true, allJan = true;
    for (const t of times) {
        const d = new Date(t);
        if (d.getHours() || d.getMinutes() || d.getSeconds() || d.getMilliseconds()) allMidnight = false;
        if (d.getDate() !== 1) allFirst = false;
        if (d.getMonth() !== 0) allJan = false;
    }
    if (!allMidnight) return "time";
    if (allFirst && allJan && times.length > 1) return "year";
    if (allFirst && times.length > 1) return "month";
    return "day";
}

// Intl formatters are costly to build: one per (locale, options) for the life of the visual (F2).
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = locale + "|" + JSON.stringify(opts);
    let f = dtfCache.get(key);
    if (!f) { f = new Intl.DateTimeFormat(locale, opts); dtfCache.set(key, f); }
    return f;
}

/** Fix round 8 (Low): the visual is English only, so generated date text is English whatever the
 *  host locale: an English host locale (en-GB, en-AU ...) keeps its own order, any other reads en-US.
 *  Authored categories and captions are data and are never re-formatted. */
export function dateLocale(locale: string): string {
    return /^en(-|$)/i.test(locale || "") ? locale : "en-US";
}

/** Time options: hour and minute, seconds when the data carries them (round 7, M7), and fractional
 *  seconds (`frac` digits, 1-3) when two readings fall in the same second (round 8, M6). */
function timeOpts(seconds: boolean, frac: number): Intl.DateTimeFormatOptions {
    const o: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
    if (seconds || frac > 0) o.second = "2-digit";
    if (frac > 0) (o as { fractionalSecondDigits?: number }).fractionalSecondDigits = Math.max(1, Math.min(3, frac));
    return o;
}

/** Short label for a point: "25 Oct" (day, one calendar year), "25 Oct 2026" (day across years),
 *  "Dec 2025" (month), "2026" (year). Through Intl, in English (dateLocale). */
export function dateLabel(t: number, grain: Grain, spansYears: boolean, locale: string, seconds = false, frac = 0): string {
    const d = new Date(t);
    const loc = dateLocale(locale);
    try {
        if (grain === "year") return String(d.getFullYear());
        if (grain === "month") return dtf(loc, { month: "short", year: "numeric" }).format(d);
        if (grain === "time") return dtf(loc, { day: "numeric", month: "short", ...timeOpts(seconds, frac) }).format(d);
        return dtf(loc, spansYears ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" }).format(d);
    } catch {
        return d.toISOString().slice(0, 10);
    }
}

/** Long label (tooltips, accessible names): always carries the year. */
export function dateLabelLong(t: number, grain: Grain, locale: string, seconds = false, frac = 0): string {
    const d = new Date(t);
    const loc = dateLocale(locale);
    try {
        if (grain === "year") return String(d.getFullYear());
        if (grain === "month") return dtf(loc, { month: "long", year: "numeric" }).format(d);
        if (grain === "time") return dtf(loc, { day: "numeric", month: "short", year: "numeric", ...timeOpts(seconds, frac) }).format(d);
        return dtf(loc, { day: "numeric", month: "short", year: "numeric" }).format(d);
    } catch {
        return d.toISOString().slice(0, 10);
    }
}

/** Fix round 7 (M7): a time axis whose readings carry seconds (12:00:01 and 12:00:47) labels
 *  them with seconds; minute-aligned data keeps hour:minute. */
export function needsSeconds(times: number[]): boolean {
    for (const t of times) { const d = new Date(t); if (d.getSeconds() || d.getMilliseconds()) return true; }
    return false;
}

/** Fix round 8 (M6): fractional-second digits (0-3) the labels need: 0 unless two distinct
 *  readings fall in the same second (12:00:10.125 and 12:00:10.875), then the fewest digits that
 *  show every reading's milliseconds exactly (.125 needs 3, .5 needs 1). */
export function fractionDigits(times: number[]): number {
    const seen = new Map<number, number>();
    let collide = false;
    for (const t of times) {
        const s = Math.floor(t / 1000), prev = seen.get(s);
        if (prev !== undefined && prev !== t) { collide = true; break; }
        seen.set(s, t);
    }
    if (!collide) return 0;
    let digits = 1;
    for (const t of times) {
        const ms = ((t % 1000) + 1000) % 1000;
        if (ms % 10) return 3;
        if (ms % 100) digits = 2;
    }
    return digits;
}

export function spansYears(times: number[]): boolean {
    if (times.length < 2) return false;
    return new Date(times[0]).getFullYear() !== new Date(times[times.length - 1]).getFullYear();
}
