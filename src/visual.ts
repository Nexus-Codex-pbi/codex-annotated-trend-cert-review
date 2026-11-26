"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import IVisualEventService = powerbi.extensibility.IVisualEventService;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import ITooltipService = powerbi.extensibility.ITooltipService;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;
import ILocalizationManager = powerbi.extensibility.ILocalizationManager;
import DataView = powerbi.DataView;
import DataViewCategoryColumn = powerbi.DataViewCategoryColumn;
import DataViewValueColumn = powerbi.DataViewValueColumn;

import { VisualFormattingSettingsModel, DEFAULTS, PADDING_DEFAULTS, PADDING_MAX, STYLE_ITEMS, KEEP_ITEMS, MARK_ITEMS, ZERO_ITEMS, PROGRESS_ITEMS, NoteStyle, Mark } from "./settings";
import { parsePoints, ParseOut, Point, Grain, detectGrain, dateLabel, dateLabelLong, spansYears, needsSeconds, fractionDigits, dateLocale, ColumnIn } from "./data";
import { axisLabeller } from "./axis";
import {
    Rect, Keep, niceScale, linear, xPositions, nearestPoint, spreadOrder, truncateToWidth,
    placeLeaders, arrangeLeaders, placeCallouts, placePins, LEADER, leaderDropEnd, leaderDropEndFor, resetTextCaches, LeaderPlaced, CalloutPlaced, PinPlaced, PINS, CALLOUT, Series, gapBreaks, calloutHeight, cardMetrics, CalloutNote,
    clampDensity, labelDensityAttempts, thinTicks,
} from "./layout";
import { toRgba, compositeOver, surfaceTone, contrastRatio, contrastInk } from "./shared/colorHelpers";
import { formatModelNumber } from "./shared/numberFormat";
import { surfaceTokens, mix } from "./shared/designTokens";
import { accentToken, bandColor, Theme } from "./shared/bandEngine";
import { ResolvedCodexTheme, resolveCodexTheme, neonColorFor, neonFilter, forcedInk } from "./shared/codexThemeSettings";
import { LicenseGate } from "./shared/licensing";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Below this drawing size the visual scrolls rather than shrinking further (degradation step 5). */
const MIN_DRAW = { w: 160, h: 100 };
/** Padding yields (proportionally) before the content box drops below this. */
const MIN_CONTENT = { w: 120, h: 80 };
/** The plot keeps at least this height; A's label band and C's key give way first. */
const MIN_PLOT = 36;
/** Fix round 7 (M4): the drawn radius of a placed note's marker (an overflow marker is 3). */
const LEADER_MARKER_R = 3.5;
/** Fix round 7 (H2): the least height the plot keeps for the trend once the title, the x labels
 *  and the footer are reserved; below it they are shed (title, then footer, then x labels), so a
 *  varying series is never drawn flat. */
const MIN_SPAN = 24;
const MAX_LEADER_ROWS = 8;
/** A's label band and C's key each take at most this share of the height above the footer. */
const BAND_SHARE = 0.5;
const C_HEADROOM = 2 * PINS.r + PINS.stem + 6;
/** Rows the categorical mapping can carry (capabilities.json dataReductionAlgorithm.top.count). */
export const ROW_LIMIT = 30000;
/** F2: notes tried and drawn per render (as placeLeaders' maxTries bounds its loop). */
export const NOTE_CANDIDATES = 200;

const HEX6 = /^#[0-9a-f]{6}$/i;

interface Colours {
    theme: Theme;
    surface: string;
    text: string;
    muted: string;
    axis: string;
    line: string;
    /** Fill of the 0.6-opacity series columns (the line colour, darkened or lightened on a bare page). */
    columns: string;
    track: string;
    hc: boolean;
    hcFg: string;
    hcLink: string;
    eventDefault: string;
    lineFilter: string;
    eventFilter: (hex: string) => string;
    /** The resolved theme while a Codex mode is forced on a painted surface (not high contrast, not Show
     *  Background off), else null: an explicit TEXT ink is then guarded by the shared forcedInk. */
    forcedCodex: ResolvedCodexTheme | null;
}

/** L2: is `r` (padded 3 px) clear of the series, its columns, every placed card, leader and pin? */
function legendClear(g: Geometry, r: Rect): boolean {
    const pad = 3, x0 = r.x - pad, x1 = r.x + r.w + pad, yb = r.y + r.h + pad, yt = r.y - pad;
    const half = g.mark === "columns" ? g.band / 2 : 0;
    const n = g.xs.length;
    for (let i = 0; i < n; i++) {
        const yi = g.ys[i];
        if (yi === null) continue;
        if (g.xs[i] + half >= x0 && g.xs[i] - half <= x1 && yi < yb) return false;
        if (i > 0 && !g.breaks[i] && g.ys[i - 1] !== null && g.xs[i - 1] < x1 && g.xs[i] > x0 && Math.min(yi, g.ys[i - 1] as number) < yb) return false;
    }
    const hits = (a: Rect) => a.x < x1 && a.x + a.w > x0 && a.y < yb && a.y + a.h > yt;
    for (const c of g.callouts) {
        if (hits(c.rect)) return false;
        const xs = c.leader.map(p => p[0]), ys = c.leader.map(p => p[1]);
        if (xs.length && hits({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 })) return false;
    }
    for (const l of g.leaders) if (l.x >= x0 && l.x <= x1) return false;
    for (const p of g.pins) if (p.cx + PINS.r >= x0 && p.cx - PINS.r <= x1) return false;
    return true;
}

interface Geometry {
    style: NoteStyle;
    mark: Mark;
    /** 0 lies inside the value domain (the zero line is drawn). */
    zeroIn: boolean;
    box: Rect;
    plot: Rect;
    xs: number[];
    ys: (number | null)[];
    /** breaks[i]: do not join point i-1 to i (a date-axis gap, F4). */
    breaks: boolean[];
    zeroY: number;
    band: number;
    yTicks: { v: number; y: number }[];
    leaders: LeaderPlaced[];
    callouts: CalloutPlaced[];
    pins: PinPlaced[];
    overflow: number[];
    /** Event indices drawn (the note candidates, ascending): placed notes plus their overflow markers. */
    candidates: number[];
    rowH: number;
    bandTop: number;
    keyTop: number;
    keyRowH: number;
    keyCols: number;
    keyColW: number;
    footerTop: number;
    xAxisY: number;
    /** Fix round 7 (H2): the footer was shed to keep the plot; its lines are in the chart's name. */
    footShed?: boolean;
    /** Fix round 7 (H2): the y of the domain's top (the scale maps dLo..dHi to plot bottom..yTop). */
    yTop?: number;
    /** L2: the in-progress legend's box inside the plot's top-left, or null (footer). */
    legendIn?: Rect | null;
    /** L2: no free place for the legend that keeps every placed note: it is not drawn. */
    legendOff?: boolean;
    /** Fix round 9 (R1): the "(so far)" date cost a note, so the cards show the plain date. */
    soFarCost?: boolean;
    /** Fix round 10 (R7): the notes tried, in the spread order; the placed notes are a prefix of it. */
    tried?: number[];
    /** Fix round 10 (R7a): callout notes with no legal place even alone at this size (not candidates). */
    notCandidates?: number[];
    /** Fix round 10 (R7): the capacity from room alone this layout used. */
    capacity?: number;
    /** Fix round 10 (R9): no other in-progress mark is drawn, so the last point's x label must show. */
    soFarMust?: boolean;
    /** Fix round 10 (R7a evidence): the leader note that ended the prefix. */
    leaderStop?: { id: number; at: number; minRow: number; rows: number; alone: boolean };
    /** Round 4 item 3: what placeCallouts was given (notes tried, card area, markers, fill
     *  baseline, fonts), kept so an independent checker can re-derive the placement. */
    /** Round 6: set when the line/area card headroom replaced the plain layout: what that layout had. */
    headroomFrom?: { cards: number; lastResort: number };
    calloutIn?: { notes: CalloutNote[]; area: Rect; markers: { x: number; y: number }[]; columns: boolean; zeroY: number | null; titleFont: string; bodyFont: string; arrange: boolean; ink: number; noteSize?: number };
}

type El = SVGElement;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, parent: Element | null, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
}
const f2 = (n: number) => (Math.round(n * 100) / 100).toString();

// ─── Bare-page contrast (Show Background off) ──────────────────────────────────────────────

/** A client x in the drawing's own units: the drawing is scaled down below the minimum size
 *  (viewBox), so the pointer offset is mapped through the screen matrix, not taken as is. */
/** Fix round 11 (A7): Ctrl, Cmd or Shift adds to the selection (Power BI's own visuals). */
function multiKey(e: MouseEvent | KeyboardEvent): boolean {
    return e.ctrlKey || e.metaKey || e.shiftKey;
}

/** The drawn width of one column at this band (the series and the selection draw the same). */
function columnWidth(band: number): number {
    return band >= 3 ? band * 0.8 : Math.max(0.6, band);
}

function svgX(svg: SVGSVGElement, clientX: number, r: DOMRect): number {
    const m = svg.getScreenCTM ? svg.getScreenCTM() : null;
    if (!m || !svg.viewBox || !svg.viewBox.baseVal || svg.viewBox.baseVal.width === 0) return clientX - r.left;
    return (clientX - m.e) / (m.a || 1);
}

/** Fix round 7 (H1): the client y in the drawing's own units (see svgX). */
function svgY(svg: SVGSVGElement, clientY: number, r: DOMRect): number {
    const m = svg.getScreenCTM ? svg.getScreenCTM() : null;
    if (!m || !svg.viewBox || !svg.viewBox.baseVal || svg.viewBox.baseVal.width === 0) return clientY - r.top;
    return (clientY - m.f) / (m.d || 1);
}

/** Desktop fix round 1: a click on a line or area selects a point only this close to its drawn
 *  mark (CSS px); anywhere else in the plot is empty space. */
const POINT_HIT = 8;
const LINE_HIT = 4;

/** Distance from (x, y) to the segment (x1, y1)-(x2, y2). */
function segmentDistance(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len)) : 0;
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** Focus from the keyboard (Tab), not from a pointer click on a focusable element. */
function keyboardFocus(el: Element): boolean {
    try { return el.matches(":focus-visible"); } catch { return true; }
}

/** Fix round 8 (H2): a context menu asked for from the keyboard (Shift+F10 or the Menu key)
 *  rather than by a pointer. Chromium reports it as a PointerEvent with no pressed button
 *  (button -1; measured: pointerType "mouse", buttons 0, at the element's centre); some builds
 *  give it an empty pointer type instead. A pointer menu carries button 2 (or 0 for Ctrl+click). */
function isKeyboardMenu(e: MouseEvent): boolean {
    const pt = (e as unknown as { pointerType?: string }).pointerType;
    return pt === "" || e.button < 0;
}

function hexToHsl(hex: string): [number, number, number] {
    const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
    const f = (p: number, q: number, t: number) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    let r = l, g = l, b = l;
    if (s > 0) {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
    }
    const x = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
    return `#${x(r)}${x(g)}${x(b)}`;
}

/** Keep the hue, move the lightness (darker on a light page, lighter on a dark one) until the
 *  colour, drawn at `opacity` over `back`, reads at `floor`:1 against it. Fix round 6 item 5: a
 *  mid-tone page (#808080, a saturated #e0007a) may read as "dark" while only the darker side can
 *  reach the floor (white on #808080 is 3.95:1, black 5.32:1): when the first direction cannot,
 *  the other is tried, and when neither can, the end (black or white) with the higher contrast. */
export function reachContrast(hex: string, back: string, floor: number, opacity = 1): string {
    const seen = (h: string) => opacity < 1 ? compositeOver(h, (1 - opacity) * 100, back) : h;
    if (contrastRatio(seen(hex), back) >= floor) return hex.toLowerCase();
    const [h, s, l] = hexToHsl(hex);
    const first = surfaceTone(back) === "dark";
    for (const lighter of [first, !first]) {
        for (let k = 1; k <= 100; k++) {
            const c = hslToHex(h, s, lighter ? Math.min(1, l + k * 0.01) : Math.max(0, l - k * 0.01));
            if (contrastRatio(seen(c), back) >= floor) return c;
        }
    }
    return contrastRatio(seen("#ffffff"), back) >= contrastRatio(seen("#000000"), back) ? "#ffffff" : "#000000";
}

/** Fix round 6 item 5: the ink for a number drawn ON a coloured disc (a pin, a key pin): the
 *  Codex dark ink or white, whichever reads better; when neither reaches 4.5:1 (a mid-tone disc),
 *  black or white, whichever reads better (one of them is always above 4.5:1). */
export function discInk(fill: string): string {
    const a = contrastInk(fill, "#14141f", "#ffffff");
    if (contrastRatio(a, fill) >= 4.5) return a;
    return contrastRatio("#000000", fill) >= contrastRatio("#ffffff", fill) ? "#000000" : "#ffffff";
}


export class Visual implements IVisual {
    private host: IVisualHost & { allowInteractions?: boolean };
    private target: HTMLElement;
    private root: HTMLDivElement;
    private events: IVisualEventService;
    private selectionManager: ISelectionManager;
    private tooltipService: ITooltipService;
    private loc: ILocalizationManager;
    private fss: FormattingSettingsService;
    private settings: VisualFormattingSettingsModel = new VisualFormattingSettingsModel();
    private licenseGate: LicenseGate;
    private lastOptions: VisualUpdateOptions | null = null;
    private destroyed = false;
    private measureCtx: CanvasRenderingContext2D | null = null;
    /** Fix round 9 (R3, measured once per update): text widths per font, shared by every layout of
     *  one update (the size guard's probes measured each text again); emptied at every update, so no
     *  width survives a data, settings or size change. */
    private measureCache = new Map<string, Map<string, number>>();

    // Per-render state used by interactions.
    private parsed: ParseOut | null = null;
    private axisCol: DataViewCategoryColumn | null = null;
    private ids = new Map<number, ISelectionId>();
    private tipFor: (p: Point) => VisualTooltipDataItem[] = () => [];
    private geom: Geometry | null = null;
    private svg: SVGSVGElement | null = null;
    private selectionLayer: SVGGElement | null = null;
    private hoverLayer: SVGGElement | null = null;
    private eventNodes: SVGGElement[] = [];
    /** Fix round 8 (H2): where a keyboard-requested plot menu opens (the active row's drawn point). */
    private menuAnchor: { x: number; y: number } | null = null;
    /** Fix round 8 (M9): the dataView's metadata.objects (what the author set explicitly). */
    private objects: powerbi.DataViewObjects | undefined = undefined;

    constructor(options: VisualConstructorOptions) {
        // NO FREE TIER: an unlicensed user gets the whole visual blocked (shared gate, fails open).
        // The check is async, so re-run the last update once it resolves.
        this.licenseGate = new LicenseGate(options.host, () => {
            if (this.lastOptions) this.update(this.lastOptions);
        });
        this.host = options.host;
        this.target = options.element;
        // 1180.2.5: the root fills the element edge to edge; nothing pads the target.
        this.target.style.margin = "0";
        this.target.style.padding = "0";
        this.target.style.overflow = "hidden";
        this.events = options.host.eventService;
        this.selectionManager = this.host.createSelectionManager();
        this.tooltipService = options.host.tooltipService;
        this.loc = this.host.createLocalizationManager();
        this.fss = new FormattingSettingsService(this.loc);

        this.root = document.createElement("div");
        this.root.className = "at-root";
        this.target.appendChild(this.root);

        // 1180.2.5: ONE contextmenu listener on options.element. A data element (event, point hover)
        // carries data-row, so its menu is the data point's; everywhere else the empty-space menu.
        this.target.addEventListener("contextmenu", (e: MouseEvent) => {
            // Fix round 8 (H2): the plot's keyboard menu leaves its row's drawn point as the anchor.
            const at = this.menuAnchor;
            this.menuAnchor = null;
            if (this.host.allowInteractions !== false) {
                const id = this.idFromEvent(e);
                this.selectionManager.showContextMenu(id ?? ({} as ISelectionId), at ?? { x: e.clientX, y: e.clientY });
            }
            e.preventDefault();
        });
        this.root.addEventListener("click", () => {
            if (this.host.allowInteractions !== false) this.selectionManager.clear().then(() => this.applySelection());
        });
        this.root.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Escape" && this.host.allowInteractions !== false) {
                this.selectionManager.clear().then(() => this.applySelection());
            }
        });
        this.selectionManager.registerOnSelectCallback((ids: ISelectionId[]) => this.applySelection(ids));
    }

    // ─── Strings ────────────────────────────────────────────────────────────────────────────

    private t(key: string, ...args: (string | number)[]): string {
        let s = this.loc.getDisplayName(key) || key;
        args.forEach((a, i) => { s = s.split(`{${i}}`).join(String(a)); });
        return s;
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────────────────────

    public update(options: VisualUpdateOptions): void {
        if (this.destroyed) return;
        this.measureCache.clear();
        resetTextCaches();
        this.events.renderingStarted(options);
        this.lastOptions = options;
        if (this.licenseGate.blockedThisFrame(options.dataViews)) {
            this.target.style.display = "none";
            this.events.renderingFinished(options);
            return;
        }
        this.target.style.display = "";
        try {
            const dv: DataView | undefined = options.dataViews?.[0];
            this.settings = this.fss.populateFormattingSettingsModel(VisualFormattingSettingsModel, dv ?? ({ metadata: { columns: [] } } as unknown as DataView));
            this.settings.resetUnknownEnums();
            this.objects = dv?.metadata?.objects;
            this.tooltipService.hide({ isTouchEvent: false, immediately: true });
            this.render(dv, options.viewport.width, options.viewport.height);
            this.events.renderingFinished(options);
        } catch (e) {
            this.events.renderingFailed(options, String(e));
        }
    }

    /** Last point in progress: On / Off, or Auto = the last axis period contains today (local
     *  calendar: same day, month or year as the grain; a time axis: within one typical step). */
    private lastInProgress(pts: Point[], times: number[], grain: Grain, dateAxis: boolean): boolean {
        const v = String(this.settings.series.lastInProgress.value?.value ?? "auto");
        if (v === "on") return pts.length > 0;
        if (v === "off" || !dateAxis || times.length === 0) return false;
        const lt = times[times.length - 1], now = Date.now();
        const a = new Date(lt), b = new Date(now);
        if (grain === "year") return a.getFullYear() === b.getFullYear();
        if (grain === "month") return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
        if (grain === "day") return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
        const step = times.length > 1 ? lt - times[times.length - 2] : 0;
        return step > 0 && now >= lt && now < lt + step;
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        const a = this.settings.annotations;
        const loc = (list: { value: string; displayName: string; key: string }[]) =>
            list.map(i => ({ value: i.value, displayName: this.loc.getDisplayName(i.key) || i.displayName }));
        const styleValue = String(a.style.value?.value ?? "leader");
        const keepValue = String(a.keep.value?.value ?? "latest");
        a.style.items = loc(STYLE_ITEMS);
        a.style.value = a.style.items.find(i => i.value === styleValue) ?? a.style.items[0];
        a.keep.items = loc(KEEP_ITEMS);
        a.keep.value = a.keep.items.find(i => i.value === keepValue) ?? a.keep.items[0];
        const sr = this.settings.series;
        const markValue = String(sr.mark.value?.value ?? "auto");
        sr.mark.items = loc(MARK_ITEMS);
        sr.mark.value = sr.mark.items.find(i => i.value === markValue) ?? sr.mark.items[0];
        const zeroValue = String(sr.startAtZero.value?.value ?? "auto");
        sr.startAtZero.items = loc(ZERO_ITEMS);
        sr.startAtZero.value = sr.startAtZero.items.find(i => i.value === zeroValue) ?? sr.startAtZero.items[0];
        const progValue = String(sr.lastInProgress.value?.value ?? "auto");
        sr.lastInProgress.items = loc(PROGRESS_ITEMS);
        sr.lastInProgress.value = sr.lastInProgress.items.find(i => i.value === progValue) ?? sr.lastInProgress.items[0];
        this.settings.codexTheme.reveal();
        return this.fss.buildFormattingModel(this.settings);
    }

    public destroy(): void {
        // Drop the in-flight licence check FIRST: its redraw callback replays update().
        this.licenseGate.dispose();
        this.destroyed = true;
        this.tooltipService?.hide({ isTouchEvent: false, immediately: true });
        while (this.root && this.root.firstChild) this.root.removeChild(this.root.firstChild);
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
        this.root = null;
        this.svg = null;
        this.geom = null;
        this.parsed = null;
        this.eventNodes = [];
        this.ids.clear();
    }

    // ─── Measurement ────────────────────────────────────────────────────────────────────────

    private measurer(font: string): (s: string) => number {
        if (!this.measureCtx) {
            const c = document.createElement("canvas");
            this.measureCtx = c.getContext ? c.getContext("2d") : null;
        }
        const ctx = this.measureCtx;
        const size = parseFloat((/(\d+(?:\.\d+)?)px/.exec(font) || ["", "11"])[1]);
        let cache = this.measureCache.get(font);
        if (!cache) { cache = new Map<string, number>(); this.measureCache.set(font, cache); }
        const memo = cache;
        return (s: string) => {
            let w = memo.get(s);
            if (w !== undefined) return w;
            if (ctx) { ctx.font = font; w = ctx.measureText(s).width; } else w = s.length * size * 0.56;
            if (!Number.isFinite(w)) w = s.length * size * 0.56;
            memo.set(s, w);
            return w;
        };
    }

    // ─── Theme ──────────────────────────────────────────────────────────────────────────────

    /** Fix round 8 (M9): the author set this property (a saved value or a whole-visual fx rule
     *  result: both arrive in dataView.metadata.objects). */
    private explicit(obj: string, prop: string): boolean {
        const o = this.objects?.[obj] as Record<string, unknown> | undefined;
        return !!o && o[prop] !== undefined && o[prop] !== null;
    }

    private resolveColours(): { c: Colours; codex: ResolvedCodexTheme; paint: string } {
        const palette = this.host.colorPalette as powerbi.extensibility.ISandboxExtendedColorPalette;
        const hc = !!palette.isHighContrast;
        const hcFg = hc ? palette.foreground.value : "";
        const hcBg = hc ? palette.background.value : "";
        const hcLink = hc ? ((palette as unknown as { hyperlink?: { value: string } }).hyperlink?.value || hcFg) : "";
        const bg = this.settings.background;
        const show = !!bg.show.value;
        const bgHex = bg.backgroundColor.value?.value || "#ffffff";
        const bgTr = show ? (bg.transparency.value ?? 0) : 100;
        const behind = palette.background?.value || "#ffffff";
        const autoSurface = hc ? hcBg : compositeOver(bgHex, bgTr, behind);
        const codex = resolveCodexTheme(this.settings.codexTheme, {
            hcActive: hc, autoTheme: surfaceTone(autoSurface), autoBgHex: bgHex, autoTransparencyPct: bgTr, behindHex: behind,
        });
        // Fix round 8 (M9, owner rule): a colour the author set explicitly (a saved swatch or an fx
        // rule result, both delivered in metadata.objects) survives every theme mode; the theme
        // supplies only the colours left at default. A forced mode therefore paints an explicit
        // background as set, and the default inks follow the tone of that surface so they read on
        // it. Done here, over the shared resolution (src/shared is not edited). High contrast keeps
        // the host's colours (its own policy).
        if (!hc && codex.mode !== "auto" && this.explicit("background", "backgroundColor")) {
            codex.bgHex = bgHex;
            codex.transparencyPct = bgTr;
            codex.surfaceHex = compositeOver(bgHex, bgTr, behind);
            codex.theme = surfaceTone(codex.surfaceHex);
        }
        if (!show) { codex.transparencyPct = 100; codex.surfaceHex = compositeOver(codex.bgHex, 100, behind); }
        const surface = hc ? hcBg : codex.surfaceHex;
        const paint = hc ? hcBg : toRgba(codex.bgHex, codex.transparencyPct);
        const theme = codex.theme;
        // F1/F11 Show Background off (every mode, HC excluded): nothing is painted, so every ink and
        // chrome colour is the one Automatic would pick for the host page (palette background and
        // foreground); a forced mode keeps only its accent/mark colours, and those default marks
        // keep their hue but move lightness to read at 3:1 on the page. Report-set colours: verbatim.
        const bare = !show && !hc;
        const inkTheme: Theme = bare ? surfaceTone(behind) : theme;
        const tok = surfaceTokens(inkTheme);
        const lift = (col: string, floor: number) => bare ? reachContrast(col, surface, floor) : col;
        // Fix round 8 (M9): an ink or mark the author set (in metadata.objects, or any value other
        // than the default) is painted verbatim in Automatic, Dark and Light alike; a default takes
        // the theme token (lifted to 4.5:1 for text, 3:1 for marks on a bare page). Round 7 swapped
        // an explicit colour for the token under a forced mode when it read below 4.5:1 / 3:1.
        const isDefault = (user: string | undefined, def: string, obj: string, prop: string) =>
            !this.explicit(obj, prop) && (user || def).toLowerCase() === def.toLowerCase();
        // Owner rule 2026-11-23 (desk10a): under a forced mode an explicit TEXT ink is kept while it reads
        // (>= 4.5:1 on the surface it sits on) and flips to the mode's token when it would be dark on dark or light
        // on light (the shared forcedInk); marks and the series stay as set. Automatic, high contrast and Show
        // Background off (the host page's inks, as Automatic) keep the explicit ink verbatim.
        // A CSS colour name can only be an fx rule result (the pane's swatch saves hex): data, painted as set (the
        // shared contrast maths cannot read a name).
        const forcedCodex = !hc && !bare && codex.mode !== "auto" ? codex : null;
        const ink = (user: string | undefined, def: string, token: string, obj: string, prop: string) =>
            isDefault(user, def, obj, prop) ? lift(token, 4.5)
                : Visual.plainTextInk((user || def).toLowerCase(), token, forcedCodex, surface);
        const mark = (user: string | undefined, def: string, token: string, obj: string, prop: string) =>
            isDefault(user, def, obj, prop) ? token : (user || def).toLowerCase();
        const s = this.settings;
        const lineDefault = isDefault(s.series.lineColor.value?.value, DEFAULTS.lineColor, "series", "lineColor");
        const lineBase = mark(s.series.lineColor.value?.value, DEFAULTS.lineColor, accentToken(theme), "series", "lineColor");
        // Fix round 11 (A6, owner 2026-11-21): an explicit line colour is drawn verbatim under Neon
        // too (only high contrast replaces it); the Neon flare colour paints the default line only.
        const neonLine = lineDefault ? neonColorFor(lineBase, codex) : lineBase;
        const line = lineDefault ? lift(neonLine, 3) : neonLine;
        const columns = bare && lineDefault ? reachContrast(neonLine, surface, 3, 0.6) : line;
        // Text: on a bare page the host foreground when it reads at 4.5:1, else the page tone's token.
        const paletteFg = palette.foreground?.value;
        const text = bare ? (paletteFg && contrastRatio(paletteFg, surface) >= 4.5 ? paletteFg.toLowerCase() : lift(tok.text, 4.5)) : tok.text;
        // Chrome (grid, zero line) on a bare page: mixed toward the ink until it reads at 1.3:1.
        let track = tok.track;
        if (bare) for (let k = 0; k <= 20 && contrastRatio(track, surface) < 1.35; k++) track = mix(tok.track, text, k * 0.05);
        const evDefault = isDefault(s.annotations.eventColor.value?.value, DEFAULTS.eventColor, "annotations", "eventColor");
        const eventBase = mark(s.annotations.eventColor.value?.value, DEFAULTS.eventColor, bandColor("warning", theme), "annotations", "eventColor");
        const c: Colours = {
            theme: inkTheme, surface, hc, hcFg, hcLink,
            text: hc ? hcFg : text,
            muted: hc ? hcFg : ink(s.annotations.noteColor.value?.value, DEFAULTS.noteColor, tok.muted, "annotations", "noteColor"),
            axis: hc ? hcFg : ink(s.axes.axisColor.value?.value, DEFAULTS.axisColor, tok.muted, "axes", "axisColor"),
            line: hc ? hcFg : line,
            columns: hc ? hcFg : columns,
            track: hc ? hcFg : track,
            eventDefault: hc ? hcLink : (evDefault ? lift(eventBase, 3) : eventBase),
            lineFilter: hc ? "none" : neonFilter(line, codex.glow),
            eventFilter: (hex: string) => hc ? "none" : neonFilter(hex, codex.glow),
            forcedCodex,
        };
        return { c, codex, paint };
    }

    // ─── Render ─────────────────────────────────────────────────────────────────────────────

    private clear(): void {
        while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
        this.svg = null; this.geom = null; this.eventNodes = []; this.selectionLayer = null; this.hoverLayer = null;
        this.ids.clear();
    }

    private padding(vw: number, vh: number): { t: number; r: number; b: number; l: number } {
        const p = this.settings.contentPadding;
        const side = (v: number | undefined, d: number) => (typeof v === "number" && Number.isFinite(v)) ? Math.max(0, Math.min(PADDING_MAX, v)) : d;
        let t = side(p.top.value, PADDING_DEFAULTS.top), r = side(p.right.value, PADDING_DEFAULTS.right);
        let b = side(p.bottom.value, PADDING_DEFAULTS.bottom), l = side(p.left.value, PADDING_DEFAULTS.left);
        // Starvation rule: padding yields proportionally before the content box drops below MIN_CONTENT.
        const roomW = Math.max(0, vw - MIN_CONTENT.w), roomH = Math.max(0, vh - MIN_CONTENT.h);
        if (l + r > roomW) { const k = (l + r) > 0 ? roomW / (l + r) : 0; l *= k; r *= k; }
        if (t + b > roomH) { const k = (t + b) > 0 ? roomH / (t + b) : 0; t *= k; b *= k; }
        return { t, r, b, l };
    }

    private render(dv: DataView | undefined, vw: number, vh: number): void {
        this.clear();
        const { c, paint } = this.resolveColours();
        // 1180.2.5 + Background: the root carries the fill edge to edge (DOM, so it also covers the title).
        this.root.style.background = paint;
        this.root.style.color = c.text;

        const cat = dv?.categorical;
        const axisCol = cat?.categories?.find(k => k.source.roles?.["axis"]) ?? null;
        const vals = cat?.values ?? ([] as unknown as powerbi.DataViewValueColumns);
        const byRole = (role: string): DataViewValueColumn | undefined => (vals as DataViewValueColumn[]).find(v => v.source.roles?.[role]);
        const valueCol = byRole("values"), noteCol = byRole("eventNote"), typeCol = byRole("eventType"), prioCol = byRole("eventPriority");
        const tipCols = (vals as DataViewValueColumn[]).filter(v => v.source.roles?.["tooltips"]);
        this.axisCol = axisCol;

        // Setup states: each names exactly the field still missing.
        if (!axisCol && !valueCol) return this.renderSetup(c, this.t("Setup_NoFields"), vw, vh, this.t("Setup_Short_NoFields"));
        if (!valueCol) return this.renderSetup(c, this.t("Setup_NeedValues", axisCol.source.displayName), vw, vh, this.t("Setup_Short_NeedValues"));
        if (!axisCol) return this.renderSetup(c, this.t("Setup_NeedAxis", valueCol.source.displayName), vw, vh, this.t("Setup_Short_NeedAxis"));

        const col = (v: DataViewValueColumn | undefined): ColumnIn | undefined => v ? { values: v.values as unknown[], displayName: v.source.displayName, format: v.source.format } : undefined;
        const parsed = parsePoints({
            axis: { values: axisCol.values as unknown[], displayName: axisCol.source.displayName, format: axisCol.source.format, isDate: !!axisCol.source.type?.dateTime },
            value: col(valueCol), note: col(noteCol), type: col(typeCol), priority: col(prioCol),
            tooltips: tipCols.map(col),
        });
        this.parsed = parsed;
        if (parsed.points.length === 0) return this.renderSetup(c, this.t("Setup_NoRows"), vw, vh, this.t("Setup_Short_NoRows"));
        // No numbers at all: the setup screen, unless there are notes. Notes on all-blank rows are still
        // the report's events; they sit on the baseline with hollow markers and the blank notice.
        if (parsed.numericCount === 0 && !parsed.points.some(p => p.note)) return this.renderSetup(c, this.t("Setup_NoNumbers", valueCol.source.displayName), vw, vh, this.t("Setup_Short_NoNumbers"));

        // Notices (footer), in a fixed order.
        const notices: string[] = [];
        // A further segment proves rows were cut; exactly the window's worth only says some MAY be missing.
        if (dv?.metadata?.segment) notices.push(this.t("Notice_Truncated", formatModelNumber(ROW_LIMIT, "#,0", this.host.locale)));
        else if ((axisCol.values?.length ?? 0) >= ROW_LIMIT) notices.push(this.t("Notice_AtLimit", formatModelNumber(ROW_LIMIT, "#,0", this.host.locale)));
        if (parsed.blankAxisRows === 1) notices.push(this.t("Notice_BlankDates_One"));
        else if (parsed.blankAxisRows > 1) notices.push(this.t("Notice_BlankDates_Many", parsed.blankAxisRows));
        if (parsed.textValues === 1) notices.push(this.t("Notice_TextValues_One"));
        else if (parsed.textValues > 1) notices.push(this.t("Notice_TextValues_Many", parsed.textValues));
        // F10: NaN/Infinity and blank readings are counted too; nothing disappears silently.
        if (parsed.nonFiniteValues === 1) notices.push(this.t("Notice_NonFinite_One"));
        else if (parsed.nonFiniteValues > 1) notices.push(this.t("Notice_NonFinite_Many", parsed.nonFiniteValues));
        if (parsed.blankValues === 1) notices.push(this.t("Notice_BlankValues_One"));
        else if (parsed.blankValues > 1) notices.push(this.t("Notice_BlankValues_Many", parsed.blankValues));
        if (!noteCol && (typeCol || prioCol)) notices.push(this.t("Notice_NoteMissing"));

        // Labels.
        const locale = this.host.locale || "en-US";
        const pts = parsed.points;
        const times = parsed.dateAxis ? pts.map(p => p.t as number) : [];
        const grain: Grain = parsed.dateAxis ? detectGrain(times) : "day";
        const breaks = parsed.dateAxis ? gapBreaks(times, grain) : pts.map(() => false);
        const multiYear = parsed.dateAxis && spansYears(times);
        const secs = grain === "time" && needsSeconds(times);
        const frac = grain === "time" ? fractionDigits(times) : 0;
        const fmtAxis = (p: Point): string => {
            if (parsed.dateAxis) return dateLabel(p.t as number, grain, multiYear, locale, secs, frac);
            const raw = p.axisRaw;
            if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return this.t("Blank_Category");
            if (typeof raw === "number") return formatModelNumber(raw, axisCol.source.format, locale);
            if (raw instanceof Date) return dateLabel(raw.getTime(), "day", false, locale);
            return String(raw);
        };
        const fmtAxisLong = (p: Point): string => parsed.dateAxis ? dateLabelLong(p.t as number, grain, locale, secs, frac) : fmtAxis(p);
        const fmtValue = (v: number) => formatModelNumber(v, valueCol.source.format, locale);
        const valueText = (p: Point): string => {
            const r = p.reading;
            if (r.state === "ok") return fmtValue(r.value as number);
            if (r.state === "text") return this.t("Tip_NotNumber", String(r.raw));
            if (r.state === "nonfinite") return this.t("Tip_NotFinite");
            return this.t("Tip_NoValue");
        };
        const lastIndex = pts.length - 1;
        const lastInProgress = this.lastInProgress(pts, times, grain, parsed.dateAxis) && pts[lastIndex].reading.state === "ok";
        const legend = lastInProgress ? this.t("Legend_InProgress", fmtAxis(pts[lastIndex]), fmtValue(pts[lastIndex].reading.value as number)) : null;
        this.tipFor = (p: Point) => {
            const items: VisualTooltipDataItem[] = [
                { displayName: axisCol.source.displayName, value: fmtAxisLong(p) },
                { displayName: valueCol.source.displayName, value: valueText(p) },
            ];
            if (lastInProgress && p === pts[lastIndex]) items.push({ displayName: this.t("Tip_Status"), value: this.t("Tip_InProgress") });
            if (noteCol && p.note) items.push({ displayName: noteCol.source.displayName, value: p.note });
            if (typeCol && p.type) items.push({ displayName: typeCol.source.displayName, value: p.type });
            if (prioCol && p.priority && p.priority.state !== "blank") {
                items.push({ displayName: prioCol.source.displayName, value: p.priority.state === "ok" ? formatModelNumber(p.priority.value as number, prioCol.source.format, locale) : this.t("Tip_NotNumber", String(p.priority.raw)) });
            }
            for (const tc of tipCols) {
                const raw = tc.values[p.row];
                let v: string;
                if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) v = this.t("Tip_NoValue");
                else if (typeof raw === "number") v = Number.isFinite(raw) ? formatModelNumber(raw, tc.source.format, locale) : this.t("Tip_NotFinite");
                else if (raw instanceof Date) v = dateLabelLong(raw.getTime(), "day", locale);
                else v = String(raw);
                items.push({ displayName: tc.source.displayName, value: v });
            }
            return items;
        };

        this.renderChart(c, pts, parsed.dateAxis, fmtAxis, fmtAxisLong, fmtValue, notices, vw, vh, valueCol.source.displayName, axisCol.source.displayName, breaks, lastInProgress, legend, valueCol.source.format);
    }

    private renderSetup(c: Colours, message: string, vw: number, vh: number, short?: string): void {
        const pad = this.padding(vw, vh);
        const wrap = document.createElement("div");
        wrap.className = "at-setup";
        wrap.style.padding = `${pad.t}px ${pad.r}px ${pad.b}px ${pad.l}px`;
        // Fix round 6 (owner: never a scrollbar): the title and the message share one frame the size
        // of the root; the message takes what the title leaves and clips there, so the root never
        // scrolls (at 120x80 the message did: 105x108 in 105x80 with real scrollbars).
        const frame = document.createElement("div");
        frame.className = "at-setup-frame";
        const title = this.renderTitleDom(c);
        if (title) frame.appendChild(title);
        const h = document.createElement("div");
        h.className = "at-setup-title";
        h.textContent = this.t("Setup_Title");
        h.style.color = c.text;
        const p = document.createElement("div");
        p.className = "at-setup-body";
        p.textContent = message;
        p.style.color = c.muted;
        wrap.appendChild(h);
        wrap.appendChild(p);
        frame.appendChild(wrap);
        this.root.appendChild(frame);
        this.root.style.overflow = "hidden";
        // Fix round 7 (M6): the full directions are the frame's accessible name; what is drawn fits
        // whole. Shed in order: the short instruction replaces the long one, then the "Annotated
        // Trend" heading goes, then the report title, then the instruction itself. Nothing is
        // left half drawn past the frame's edge.
        frame.setAttribute("role", "note");
        frame.setAttribute("aria-label", `${this.t("Setup_Title")}. ${message}`);
        const fits = (): boolean => {
            const fr = this.root.getBoundingClientRect();
            const edge = { r: fr.right + 0.5, b: fr.bottom + 0.5 };
            const inner = wrap.getBoundingClientRect();
            const lim = { r: Math.min(edge.r, inner.right - pad.r + 0.5), b: Math.min(edge.b, inner.bottom - pad.b + 0.5) };
            for (const el of [title, h, p]) {
                if (!el || !el.parentNode) continue;
                const r = el.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(el);
                const t = range.getBoundingClientRect();
                const bottom = Math.max(r.height ? r.bottom : -Infinity, t.height ? t.bottom : -Infinity);
                const right = t.width ? t.right : r.right;
                const isTitle = el === title;
                if (bottom > (isTitle ? edge.b : lim.b) || (!isTitle && right > lim.r)) return false;
            }
            return true;
        };
        if (fits()) return;
        if (short) p.textContent = short;
        if (fits()) return;
        if (h.parentNode) h.parentNode.removeChild(h);
        if (fits()) return;
        if (title && title.parentNode) title.parentNode.removeChild(title);
        if (fits()) return;
        if (p.parentNode) p.parentNode.removeChild(p);
    }

    private renderTitleDom(c: Colours): HTMLDivElement | null {
        const ts = this.settings.titleSettings;
        if (!ts.showTitle.value || !ts.titleText.value) return null;
        const pad = this.padding(this.lastOptions?.viewport.width ?? 300, this.lastOptions?.viewport.height ?? 200);
        const el = document.createElement("div");
        el.className = "at-title-dom";
        el.textContent = ts.titleText.value;
        el.style.padding = `${pad.t}px ${pad.r}px 0 ${pad.l}px`;
        el.style.fontFamily = ts.titleFontFamily.value || "Segoe UI, sans-serif";
        el.style.fontSize = `${ts.titleFontSize.value || 14}px`;
        el.style.fontWeight = ts.titleBold.value ? "700" : "400";
        el.style.fontStyle = ts.titleItalic.value ? "italic" : "normal";
        el.style.textDecoration = ts.titleUnderline.value ? "underline" : "none";
        el.style.textAlign = String(ts.titleAlign.value || "left");
        el.style.color = this.titleColour(c);
        return el;
    }

    private titleColour(c: Colours): string {
        if (c.hc) return c.hcFg;
        const def = "#1a1a2e";
        const u = (this.settings.titleSettings.titleColor.value?.value || def).toLowerCase();
        // Fix round 8 (M9): an explicit title colour is kept in Automatic; only the default follows the theme.
        // Owner rule 2026-11-23 (desk10a): under a forced mode it is kept while it reads on the surface (4.5:1)
        // and flips to the mode's text ink when it would be dark on dark or light on light.
        if (u === def && !this.explicit("titleSettings", "titleColor")) return c.text;
        return Visual.plainTextInk(u, c.text, c.forcedCodex, c.surface);
    }

    /** desk15: the ONE place a plain TEXT ink (title, notes, axis labels) is decided under a forced mode. Owner rule
     *  2026-11-23: kept while it reads (>= 4.5:1 on `surface`), else the mode's text ink (the shared forcedInk). A CSS
     *  colour name (an fx rule result) is data and returned as set; `forcedCodex` null (Automatic, high contrast, Show
     *  Background off) returns the ink as set. Pending owner question (whether a hued plain ink keeps its hue as a
     *  mark-and-text colour does): a switch to hue-keeping is a change to this function only. */
    private static plainTextInk(ink: string, modeInk: string, forcedCodex: ResolvedCodexTheme | null, surface: string): string {
        return forcedCodex && HEX6.test(ink) ? forcedInk(ink, modeInk, forcedCodex, false, surface) : ink;
    }

    private renderChart(
        c: Colours, pts: Point[], dateAxis: boolean,
        fmtAxis: (p: Point) => string, fmtAxisLong: (p: Point) => string, fmtValue: (v: number) => string,
        notices: string[], vw: number, vh: number, valueName: string, axisName: string, breaks: boolean[],
        lastInProgress: boolean, legend: string | null, valueFormat?: string,
        /** Fix round 10 (R9): 0 the usual layout (checked for an in-progress mark once drawn); 1 the
         *  legend's row given up and the "(so far)" date kept whatever it costs; 2 the usual layout,
         *  drawn as is (1 showed no mark either). */
        soFarPass: 0 | 1 | 2 = 0,
    ): void {
        const s = this.settings;
        const style = s.noteStyle();
        const W = Math.max(vw, MIN_DRAW.w), H = Math.max(vh, MIN_DRAW.h);
        // Fix round 6 (owner: the visual never shows a scrollbar; Desktop draws real ones): below the
        // minimum drawing size the drawing is laid out at 160x100 and scaled down to fit the viewport
        // (after drawChart), so the root never scrolls.
        this.root.style.overflow = "hidden";
        const pad = this.padding(W, H);
        const box: Rect = { x: pad.l, y: pad.t, w: W - pad.l - pad.r, h: H - pad.t - pad.b };

        const noteFamily = s.annotations.noteFontFamily.value || "Segoe UI, sans-serif";
        const noteSize = Math.max(8, Math.min(24, Number(s.annotations.noteFontSize.value) || DEFAULTS.noteFontSize));
        const capWeight = s.annotations.noteBold.value ? 700 : 500;
        const italic = s.annotations.noteItalic.value ? "italic " : "";
        const axisSize = Math.max(8, Math.min(20, Number(s.axes.axisFontSize.value) || DEFAULTS.axisFontSize));
        const dateFont = `${italic}700 ${noteSize}px ${noteFamily}`;
        const capFont = `${italic}${capWeight} ${noteSize}px ${noteFamily}`;
        const axisFont = `500 ${axisSize}px Segoe UI, sans-serif`;
        const mDate = this.measurer(dateFont), mCap = this.measurer(capFont), mAxis = this.measurer(axisFont);
        const titleFontFamily = s.titleSettings.titleFontFamily.value || "Segoe UI, sans-serif";
        const titleSize = Number(s.titleSettings.titleFontSize.value) || 14;
        const titleFont = `${s.titleSettings.titleItalic.value ? "italic " : ""}${s.titleSettings.titleBold.value ? 700 : 400} ${titleSize}px ${titleFontFamily}`;
        let showTitle = !!s.titleSettings.showTitle.value && !!s.titleSettings.titleText.value;
        let titleH = showTitle ? Math.ceil(titleSize * 1.3) + 6 : 0;
        let showX = !!s.axes.showX.value;
        const showY = !!s.axes.showY.value;
        let xAxisH = showX ? Math.ceil(axisSize + 9) : 0;
        const footRowH = Math.ceil(axisSize + 6);
        const showDate = !!s.annotations.showDate.value;
        const sep = " · ";

        // y domain from plotted (ok) values only: blanks, text and NaN never enter it (1180.2.4).
        let vmin = Infinity, vmax = -Infinity;
        for (const p of pts) if (p.reading.state === "ok") { const v = p.reading.value as number; if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
        // F7: Start at zero (Auto = on for area and columns, off for a bare line). No plotted value: 0..1.
        const mark = s.mark(style);
        const zero = s.startAtZero(mark) || !Number.isFinite(vmin);
        const nice = niceScale(vmin, vmax, 4, zero);
        const dLo = showY ? nice.lo : (zero ? Math.min(0, vmin) : vmin), dHiRaw = showY ? nice.hi : (zero ? Math.max(0, vmax) : vmax);
        const dHi = dHiRaw === dLo ? dLo + 1 : dHiRaw;
        // M3: decimals from the tick step, in the measure's own format (%, currency; compact from 10,000).
        const yLabel = axisLabeller(nice.ticks, nice.step, valueFormat, this.host.locale || "en-US");
        const yLabelW = showY ? Math.max(...nice.ticks.map(v => mAxis(yLabel(v)))) + 6 : 0;
        const plotLeft = box.x + yLabelW + 4, plotRight = box.x + box.w - 4;
        const columns = mark === "columns";
        const xl = xPositions(pts.map(p => p.t), dateAxis, plotLeft, plotRight, columns);

        // Event candidates (maxNotes caps the candidates; the rest overflow).
        // Fix round 10 (R7): one fixed, spread order (`spreadOrder`): the latest note (Keep and the
        // priority column decide the first), then notes spread as evenly as possible across the
        // period. It depends on the data and settings only, never on the card size, so a larger card
        // places a longer prefix of the same order: it adds notes and never swaps one out. The
        // candidates (maxNotes, at most NOTE_CANDIDATES drawn as markers) are its first ranks; round
        // 9's bins one note wide (M1) are gone: the spread order already spreads them across x.
        const events = pts.map((p, i) => ({ p, i })).filter(e => !!e.p.note);
        const keep = String(s.annotations.keep.value?.value ?? "latest") as Keep;
        const maxNotes = Math.max(0, Math.min(50, Math.floor(Number(s.annotations.maxNotes.value) || 0)));
        const want = Math.min(NOTE_CANDIDATES, maxNotes > 0 ? maxNotes : Infinity);
        let order = spreadOrder(events.map(e => ({
            id: e.i, order: dateAxis ? e.p.t as number : e.i, row: e.p.row,
            value: e.p.reading.state === "ok" ? e.p.reading.value : null,
            priority: e.p.priority && e.p.priority.state === "ok" ? e.p.priority.value : null,
        })), keep, want);
        const capped: number[] = order.slice(want);
        order = order.slice(0, want);
        // Round 4 item 1: Label density. Only the first `attempts` candidates are TRIED (a prefix of
        // the order above, so a higher density tries a superset); the rest stay drawn as candidates
        // (hollow marker, keyboard, tooltip, accessible name) and join the "+N more notes" count.
        const density = clampDensity(s.annotations.labelDensity.value, DEFAULTS.labelDensity);
        const tried = order.slice(0, labelDensityAttempts(order.length, density));
        const triedSet = new Set(tried);
        const skipped = order.filter(i => !triedSet.has(i));
        // Item 3: when the in-progress legend yields its place, the last period's own date carries
        // "(so far)" instead (Label_SoFar), in the note text, the key, the x labels and the names.
        let soFarMode = false;
        const lastPt = pts[pts.length - 1];
        const axisOf = (i: number): string => soFarMode && lastInProgress && pts[i] === lastPt ? this.t("Label_SoFar", fmtAxis(pts[i])) : fmtAxis(pts[i]);
        const dateText = (i: number) => showDate ? axisOf(i) + sep : "";
        let headroom = false;
        let footShed = false;

        // Fix round 7 (M4): the placed leaders whose line (label row down to 4 px above the point,
        // or above the column top) passes within a marker's radius plus half the leader's width of
        // another candidate's marker. Ids, in the order given.
        // Fix round 8 (M10): on a line or area the leader is tested where it is DRAWN: it ends where
        // its ink clears the line's (leaderDropEnd, as drawChart ends it), not 4 px above its point.
        // On a dense series the drawn leader stops at the ink's top edge, so markers inside the ink
        // below it are not crossed (12 labels kept where 15 fitted clear of every marker).
        const lwX = Math.max(0.5, Math.min(6, Number(s.series.lineWidth.value) || DEFAULTS.lineWidth));
        // Fix round 9 (R3): a crossing test depends only on (top, yTop, plotBottom) within one
        // update, and the layout passes rebuild the same ones: each is built once per renderChart.
        const crossTests = new Map<string, ReturnType<typeof crossTestOf>>();
        const crossTest = (top: number, yTop: number, plotBottom: number): ReturnType<typeof crossTestOf> => {
            const key = `${top}|${yTop}|${plotBottom}`;
            let t = crossTests.get(key);
            if (!t) { t = crossTestOf(top, yTop, plotBottom); crossTests.set(key, t); }
            return t;
        };
        function crossTestOf(top: number, yTop: number, plotBottom: number) {
            const yy = linear(dLo, dHi, plotBottom, Math.min(yTop, plotBottom));
            const zeroIn = dLo <= 0 && dHi >= 0;
            const zy = zeroIn ? yy(0) : yy(dLo > 0 ? dLo : dHi);
            const yOf = (i: number): number => pts[i].reading.state === "ok" ? yy(pts[i].reading.value as number) : zy;
            const reach = LEADER_MARKER_R + 0.6;
            let ysAll: (number | null)[] | null = null;
            const drops = new Map<number, (y1: number) => number>();
            const seg = (id: number, row: number): [number, number, number] => {
                const x = xl.xs[id];
                const y1 = top + row * Math.ceil(noteSize * 1.75) + noteSize - noteSize * 0.85;
                const py = yOf(id);
                let y2 = (mark === "columns" ? Math.min(py, zy) : py) - 4;
                if (mark !== "columns" && pts[id].reading.state === "ok") {   // a blank/text reading's leader runs to the zero line, as drawn
                    if (!ysAll) ysAll = pts.map(p => p.reading.state === "ok" ? yy(p.reading.value as number) : null);
                    // Fix round 9 (R3): one shared drop-end scan per note across its label rows.
                    let drop = drops.get(id);
                    if (!drop) { drop = leaderDropEndFor({ xs: xl.xs, ys: ysAll }, breaks, x, y2, (lwX + 1.2) / 2 + 0.5); drops.set(id, drop); }
                    y2 = drop(y1);
                }
                return [x, y1, y2];
            };
            return Object.assign((id: number, row: number): boolean => {
                const [x, y1, y2] = seg(id, row);
                for (const j of order) {
                    if (j === id) continue;
                    const dx = Math.abs(xl.xs[j] - x);
                    if (dx >= reach) continue;
                    const yj = yOf(j);
                    const dy = yj < y1 ? y1 - yj : yj > y2 ? yj - y2 : 0;
                    if (Math.hypot(dx, dy) < reach) return true;
                }
                return false;
            }, { seg });
        }
        // ...and (fix round 8, M10) two placed leaders whose drawn lines share an x (within both
        // strokes and half a pixel) and overlap in height: the later one in placement order is
        // returned. (A leader that ran down to its point always met the other note's marker first.)
        // Fix round 10 (R7): the later one in the spread ORDER (not the left-to-right placement order),
        // so a coinciding pair always gives up the note a smaller card would not have placed.
        const rank = new Map(order.map((id, k) => [id, k]));
        const leadersOverMarkers = (placed: LeaderPlaced[], top: number, plotTop: number, yTop: number, plotBottom: number): number[] => {
            const crosses = crossTest(top, yTop, plotBottom);
            const out = new Set(placed.filter(L => crosses(L.id, L.row)).map(L => L.id));
            const kept: [number, number, number][] = [];
            for (const L of placed.slice().sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))) {
                if (out.has(L.id)) continue;
                const [x, y1, y2] = crosses.seg(L.id, L.row);
                if (kept.some(([kx, k1, k2]) => Math.abs(kx - x) < 1.7 && Math.min(k2, y2) > Math.max(k1, y1))) out.add(L.id);
                else kept.push([x, y1, y2]);
            }
            return placed.filter(L => out.has(L.id)).map(L => L.id);
        };

        // Fix round 11 (A2): a place the note cards keep clear of (the in-plot legend's), as markers.
        let legendAvoid: Rect | null = null;
        const layout = (footerRows: number, st: NoteStyle = style, keyRowsMax = Infinity, noteCap = Infinity): Geometry => {
            const top = box.y + titleH;
            const footerTop = box.y + box.h - (footShed ? 0 : footerRows) * footRowH;
            // Bottom-up: footer rows, (C: the key), the x-axis label row, then the plot.
            let xAxisY = footerTop - xAxisH;
            let plotTop = top + 4, plotBottom = xAxisY;
            let leaders: LeaderPlaced[] = [], callouts: CalloutPlaced[] = [], pins: PinPlaced[] = [], notCandidates: number[] = [], capacity = 0;
            let leaderStop: { id: number; at: number; minRow: number; rows: number; alone: boolean } | undefined;
            let calloutIn: Geometry["calloutIn"];
            let overflow: number[] = [];
            const rowH = Math.ceil(noteSize * 1.75);
            // Fix round 7 (Low): a key row is at least a pin disc tall, so its disc is never clipped.
            const keyRowH = Math.max(Math.ceil(noteSize * 1.85), 2 * PINS.r);
            let keyTop = 0, keyCols = 1, keyColW = box.w, keyCap = 0;
            let yTop = plotTop;
            if (st === "leader") {
                const avail = xAxisY - top;
                // The label band takes at most BAND_SHARE of the height above the axis, and never the plot's MIN_PLOT.
                let rows = Math.max(0, Math.min(MAX_LEADER_ROWS, Math.floor(Math.min(avail * BAND_SHARE, avail - MIN_PLOT - 6) / rowH)));
                // Fix round 10 (R7, R3): the capacity from room alone: the band's rows times the labels
                // one row can hold at the narrowest label any tried note can take (its full text, or
                // its date and the shortest caption a label may be cut to), `pad` apart. Neither the
                // value nor the time scale enters it, and it cannot fall as the card grows.
                const band0 = rows;
                const narrowest = tried.reduce((m, i) => {
                    const dw = showDate ? mDate(dateText(i)) : 0, cw = mCap(pts[i].note as string);
                    return Math.min(m, dw + Math.min(cw, LEADER.minCaption));
                }, Infinity);
                const perRow = Math.max(1, Math.floor((box.w + LEADER.pad) / (Math.max(1, narrowest) + LEADER.pad)));
                const use = tried.slice(0, Math.min(noteCap, band0 * perRow));
                capacity = Math.min(noteCap, band0 * perRow);
                // Fix round 7 (M4): a leader runs straight down from its label to its own point, so
                // it may not pass over another note's marker (a candidate's marker is always drawn)
                // nor coincide with another leader. Every candidate's marker is drawn, so a crossing
                // depends only on the label row: each note tries only rows from its first clean one
                // (measured on the full band's plot).
                const crosses0 = crossTest(top, top + band0 * rowH + (band0 ? 8 : 4) + 4, plotBottom);
                const minRow = new Map<number, number>();
                for (const i of use) { let r = 0; while (r < band0 && crosses0(i, r)) r++; minRow.set(i, r); }
                const rowsOf = (ls: LeaderPlaced[]) => ls.reduce((m, l) => Math.max(m, l.row + 1), 0);
                // Fix round 10 (R7): the longest prefix of the spread order that lays out with no
                // leader over a marker or another leader. The plot regrows with fewer rows, so a
                // placed leader can still cross once placed: the prefix then ends before the first
                // note (in the order) that crosses, and the shorter prefix is placed again. Round 8's
                // "keep the placement with the most labels" (N816) is gone with the search it served.
                let n = use.length;
                for (;;) {
                    const notes = use.slice(0, n).map(i => ({ id: i, x: xl.xs[i], date: dateText(i), caption: pts[i].note as string, minRow: minRow.get(i) }));
                    const res = placeLeaders(notes, { left: box.x, right: box.x + box.w, rows: band0 }, mDate, mCap, undefined, undefined, undefined, true);
                    leaders = res.placed;
                    rows = rowsOf(leaders);
                    plotTop = top + rows * rowH + (rows ? 8 : 4);
                    yTop = plotTop + 4;
                    const crossing = leaders.length ? leadersOverMarkers(leaders, top, plotTop, yTop, plotBottom) : [];
                    if (crossing.length === 0) break;
                    n = Math.min(...crossing.map(id => use.indexOf(id)));
                }
                const kept = new Set(leaders.map(l => l.id));
                overflow = tried.filter(i => !kept.has(i));
                // R7a evidence: the note that ended the prefix, its first clean row, and whether it
                // lays out even on its own.
                const j = use.findIndex(i => !kept.has(i));
                if (j >= 0) {
                    const i = use[j];
                    const one = [{ id: i, x: xl.xs[i], date: dateText(i), caption: pts[i].note as string, minRow: minRow.get(i) }];
                    leaderStop = { id: i, at: j, minRow: minRow.get(i) ?? 0, rows: band0, alone: (minRow.get(i) ?? 0) < band0 && !!arrangeLeaders(one, { left: box.x, right: box.x + box.w, rows: band0 }, mDate, mCap) };
                }
            } else if (st === "pins") {
                keyCols = Math.max(1, Math.floor(box.w / 260));
                keyColW = box.w / keyCols;
                const avail = xAxisY - top;
                const maxRows = Math.max(0, Math.floor(Math.min(avail * BAND_SHARE, avail - MIN_PLOT - C_HEADROOM - 8 - xAxisH) / keyRowH));
                // Fix round 10 (R7): the key rows follow the notes the settings allow (Maximum notes), not how
                // many Label density tries, so a higher density never shrinks the plot (R77: pins 1, 3, 2).
                const rows = Math.min(maxRows, Math.ceil(order.length / keyCols), keyRowsMax);
                const keyH = rows > 0 ? rows * keyRowH + 4 : 0;
                keyTop = footerTop - keyH;
                xAxisY = keyTop - xAxisH;
                plotBottom = xAxisY;
                yTop = plotTop + C_HEADROOM;
                // Pins need y (placed after the scale below); capacity = key slots.
                keyCap = rows * keyCols;
            } else {
                // Callout cards over columns: columns are solid, so a card needs room ABOVE the
                // tallest ones. Reserve one two-line card of headroom, at most 35% of the plot.
                // Round 5 item 1: a line or area chart gets the same headroom when a note would
                // otherwise have no clean place (a peak at the plot top is reached only across its
                // own flank, which no connector may cross); see `headroom` below.
                yTop = plotTop + (mark === "columns" || headroom ? Math.min(calloutHeight(2, noteSize) + 8, Math.max(6, (plotBottom - plotTop) * 0.35)) : 6);
            }
            const plot: Rect = { x: plotLeft, y: plotTop, w: plotRight - plotLeft, h: Math.max(0, plotBottom - plotTop) };
            const y = linear(dLo, dHi, plotBottom, Math.min(yTop, plotBottom));
            const ys = pts.map(p => p.reading.state === "ok" ? y(p.reading.value as number) : null);
            // The baseline (area, columns, hollow markers) is y(0) when 0 is in the domain, else the
            // domain edge nearest to it; the zero line is drawn only when 0 is inside (F7).
            const zeroIn = dLo <= 0 && dHi >= 0;
            const zeroY = zeroIn ? y(0) : y(dLo > 0 ? dLo : dHi);
            if (st === "callout") {
                const series: Series = { xs: xl.xs, ys };
                // Only candidates are drawn, so only their markers can block a card.
                const markers = order.map(i => ({ x: xl.xs[i], y: ys[i] ?? zeroY }));
                // Fix round 11 (A2): points every 4 px over the legend's place (grown by legendClear's
                // 3 px) keep every card off it.
                if (legendAvoid) {
                    const a = legendAvoid;
                    for (let ax = a.x - 3; ax <= a.x + a.w + 3; ax += 4) for (let ay = a.y - 3; ay <= a.y + a.h + 3; ay += 4) markers.push({ x: ax, y: ay });
                }
                // Look B: the value carries its measure name. A single capitalised word reads as a
                // noun after the value ("Dec 2025: 216 releases"); another single word follows it
                // verbatim ("216 ARR"); a multi-word name leads, verbatim ("Net revenue $6,000", L1).
                const name = valueName.trim();
                const unit = /^[A-Z][a-z]+$/.test(name) ? name.toLowerCase() : name;
                const leads = /\s/.test(name);
                const titleOf = (i: number) => {
                    const r = pts[i].reading;
                    const fv = r.state === "ok" ? fmtValue(r.value as number) : "";
                    const v = !fv ? "" : !unit ? fv : leads ? `${unit} ${fv}` : `${fv} ${unit}`;
                    return showDate ? (v ? `${axisOf(i)}: ${v}` : axisOf(i)) : (v || axisOf(i));
                };
                const notes = tried.slice(0, noteCap).map(i => ({ id: i, px: xl.xs[i], py: ys[i] ?? zeroY, title: titleOf(i), caption: pts[i].note as string }));
                // Item 5 (fix round 3): with the value axis on, its gutter holds the value labels,
                // so a card starts at the plot; with it off a card may use the whole width.
                const cardX = showY ? plotLeft : box.x;
                const cardArea: Rect = { x: cardX, y: plotTop, w: box.x + box.w - cardX, h: plot.h };
                // Columns are solid ink: a card may not cover one (a line only needs `lineClear`).
                const cols = mark === "columns" ? { xs: xl.xs, tops: ys.map(v => v === null ? null : Math.min(v, zeroY)), bottoms: ys.map(v => v === null ? null : Math.max(v, zeroY)), band: xl.band } : undefined;
                const titleFont = `${italic}700 ${noteSize + 1}px ${noteFamily}`;
                // Desktop fix round 1 (R7): high contrast draws no area fill, but its cards keep off the
                // area as the other modes' do, so every mode places the same notes at one size (HC
                // placed Nov 2026 where Light and Dark placed Mar 2025, owner case callouts 240x160).
                const fill = mark === "area" ? { zeroY } : undefined;
                // Round 6 item 6: connectors keep half the line plus half their own 1.2 px plus 0.5 px off the line.
                const inkHalf = (Math.max(0.5, Math.min(6, Number(s.series.lineWidth.value) || DEFAULTS.lineWidth)) + 1.2) / 2 + 0.5;
                // Fix round 10 (R7, R3): the capacity from room alone: the cards of the smallest size a
                // card can take (no text, one title line) that tile the card area `gap` apart.
                const cardCap = Math.floor((cardArea.w + CALLOUT.gap) / (2 * CALLOUT.padX + CALLOUT.gap)) * Math.floor((cardArea.h + CALLOUT.gap) / (calloutHeight(0, noteSize) + CALLOUT.gap));
                const res = placeCallouts(notes, cardArea, cols ? { xs: [], ys: [] } : series, markers,
                    this.measurer(titleFont), mCap, { ...CALLOUT, inkHalf, noteSize }, cols,
                    // H2: where the area fill is drawn, a card mostly over it is a last resort.
                    // Fix round 10 (R7): the longest prefix of the spread order that places.
                    fill, order.length <= CALLOUT.arrangeMax, undefined, true, true, Math.max(0, cardCap));
                callouts = res.placed; notCandidates = res.skipped ?? []; capacity = Math.max(0, cardCap); overflow = res.overflow.concat(tried.slice(notes.length));
                calloutIn = { notes, area: cardArea, markers, columns: !!cols, zeroY: fill ? fill.zeroY : null, titleFont, bodyFont: capFont, arrange: order.length <= CALLOUT.arrangeMax, ink: inkHalf, noteSize };
            } else if (st === "pins") {
                const tops = pts.map((p, i) => ys[i] === null ? null : Math.min(ys[i] as number, zeroY));
                const notes = tried.map(i => ({ id: i, x: xl.xs[i], top: ys[i] === null ? zeroY : Math.min(ys[i] as number, zeroY) }));
                const res = placePins(notes, plot, { xs: xl.xs, tops, band: xl.band }, keyCap, undefined, { left: 0, right: W }, true);
                pins = res.placed; overflow = res.overflow; capacity = keyCap;
            }
            // Round 4 item 6: value labels thin out so no two touch (a line box plus 2 px apart).
            const allTicks = showY ? nice.ticks.map(v => ({ v, y: y(v) })) : [];
            const yTicks = thinTicks(allTicks.map(q => q.y), Math.ceil(axisSize * 1.3) + 2, Math.max(0, nice.ticks.indexOf(0))).map(i => allTicks[i]);
            return {
                style: st, mark, zeroIn, box, plot, xs: xl.xs, ys, breaks, zeroY, band: xl.band, yTicks, leaders, callouts, pins, calloutIn,
                overflow: overflow.concat(skipped, capped), candidates: order.slice().sort((a, b) => a - b), rowH, bandTop: top, keyTop, keyRowH, keyCols, keyColW, footerTop, xAxisY,
                footShed, yTop: Math.min(yTop, plotBottom), tried, notCandidates, capacity, leaderStop,
            };
        };
        // Footer rows: the in-progress legend, the notices, then (if any) the overflow count.
        const fixedRows = notices.length + (legend ? 1 : 0);
        // Fix round 7 (H2): the plot keeps MIN_SPAN px before the title, the footer and the x labels
        // (shed in that order; a shed footer's lines join the chart's accessible name).
        const span = (q: Geometry): number => q.plot.h > 0 ? q.plot.y + q.plot.h - (q.yTop ?? q.plot.y) : 0;
        let g = layout(fixedRows);
        if (g.overflow.length > 0) g = layout(fixedRows + 1);
        for (let shed = 0; shed < 3 && span(g) < MIN_SPAN; shed++) {
            if (shed === 0) { if (!showTitle) continue; showTitle = false; titleH = 0; }
            else if (shed === 1) { if (footShed) continue; footShed = true; }
            else { if (!showX) continue; showX = false; xAxisH = 0; }
            g = layout(fixedRows);
            if (g.overflow.length > 0) g = layout(fixedRows + 1);
        }
        // Round 5 item 1: no connector crosses the line, so a note on a peak at the plot top has no
        // clean card until the line and area charts leave the card headroom the columns mark
        // always has (or with last-resort cards only: a long stem up the inside of the peak).
        // Laid out again with it; kept if it places more cards with no more last-resort cards
        // (R54: never a card over the fill bought by the headroom), or as many with fewer. Small
        // charts only (at most CALLOUT.arrangeMax candidates): at the row limit a second full
        // placement doubled the update (R57: 1917 vs 4661 ms measured under load).
        const lastResort = (q: Geometry) => q.callouts.filter(p => (p.tier ?? 0) > 0).length;
        // M2: the key was reserved for every candidate; when far fewer pins fit (notes crowded
        // into a few columns), lay out once more with the key sized to the pins placed, so the
        // plot takes the band back. Kept only if it places at least as many pins.
        const fitKey = (q: Geometry, rowsBase: number): Geometry => {
            if (q.style !== "pins" || q.pins.length === 0) return q;
            const need = Math.ceil(q.pins.length / q.keyCols);
            const had = Math.round((q.footerTop - q.keyTop - 4) / q.keyRowH);
            if (need >= had) return q;
            const k = layout(q.overflow.length > 0 ? rowsBase + 1 : rowsBase, "pins", need);
            return k.pins.length >= q.pins.length ? k : q;
        };
        // Fix round 9 (R1): every step that can add a note (the headroom, the fitted key, the pins
        // fallback) runs for each footer variant, so the layout without the legend's row is the
        // same layout the visual draws with no legend at all. At eab8ff4 the variant without the
        // legend skipped the headroom and placed 0 cards where the chart without a legend placed 1.
        const settle = (rowsBase: number, q0?: Geometry): Geometry => {
            headroom = false;
            let q = q0;
            if (!q) { q = layout(rowsBase); if (q.overflow.length > 0) q = layout(rowsBase + 1); }
            if (q.style === "callout" && mark !== "columns" && order.length <= CALLOUT.arrangeMax && (q.callouts.length < tried.length || lastResort(q) > 0)) {
                headroom = true;
                let gh = layout(rowsBase);
                if (gh.overflow.length > 0) gh = layout(rowsBase + 1);
                // Fix round 10 (R7): the cards are a prefix of the spread order, so the plain layout
                // can stop at a note the headroom places, before later notes were ever tried. The
                // headroom layout is cut to its longest prefix with no more last-resort cards than
                // the plain layout (R84, Y2: the headroom never buys a last-resort card) and placed
                // again at that length.
                if (gh.callouts.length > q.callouts.length && lastResort(gh) > lastResort(q)) {
                    const at = new Map(gh.callouts.map(p => [p.id, (p.tier ?? 0) > 0]));
                    // R7a: a note that is not a candidate in the headroom layout is passed over.
                    const nc = new Set(gh.notCandidates ?? []);
                    let k = 0, pos = 0, worse = 0;
                    for (const id of tried) {
                        if (!at.has(id)) { if (nc.has(id)) { pos++; continue; } break; }
                        if (at.get(id)) worse++;
                        if (worse > lastResort(q)) break;
                        k++; pos++;
                    }
                    if (k > q.callouts.length) {
                        let gk = layout(rowsBase, style, Infinity, pos);
                        if (gk.overflow.length > 0) gk = layout(rowsBase + 1, style, Infinity, pos);
                        if (gk.callouts.length === k) gh = gk;
                    }
                }
                if ((gh.callouts.length > q.callouts.length && lastResort(gh) <= lastResort(q))
                    || (gh.callouts.length === q.callouts.length && lastResort(gh) < lastResort(q))) {
                    // Round 6 item 4 (Y2): recorded so a case can prove the headroom never added a last-resort card.
                    gh.headroomFrom = { cards: q.callouts.length, lastResort: lastResort(q) };
                    q = gh;
                } else headroom = false;
            }
            q = fitKey(q, rowsBase);
            // Numbered pins with no room for a single pin or key row (a small card): fall back to
            // leader labels rather than draw no note at all (the first-priority note keeps its place).
            // Round 4 item 4: the fallback places the first-priority note ONLY. Unlimited, it showed
            // 2 or 3 labels at 200x150 and 260x180 where the next size up drew 1 or 2 pins, so a
            // larger visual showed fewer notes.
            if (q.style === "pins" && order.length > 0 && q.pins.length === 0) {
                let lg = layout(rowsBase, "leader", Infinity, 1);
                if (lg.overflow.length > 0) lg = layout(rowsBase + 1, "leader", Infinity, 1);
                if (lg.leaders.length > 0) q = lg;
            }
            return q;
        };
        g = settle(fixedRows, g);
        // L2: the in-progress legend goes in the plot's top-left when that area is clear of every
        // drawn mark, without its footer row; it is kept only if no placed note is lost by it.
        if (legend && soFarPass === 1) {
            soFarMode = true;
            g = settle(fixedRows - 1);
            g.legendOff = true;
        } else if (legend) {
            const gFoot = g, headFoot = headroom;
            const gp = settle(fixedRows - 1);
            const headP = headroom;
            const placedOf = (q: Geometry) => q.leaders.length + q.callouts.length + q.pins.length;
            // Fix round 10 (R10): the legend is admitted by room alone, in either place: it is drawn
            // only where the layout that holds it has capacity for every note the settings try (else
            // the last x label says "(so far)", R9). Capacity is an upper bound, so the round 9 rule
            // still applies on top: the legend never costs a placed note (R59: 9 renders lost a
            // card to the footer row under room alone). Round 9 compared the
            // notes placed with and without the row, so the legend blinked off at each height where
            // one more note arrived (rv8 pins, legend on, 300 x 60..400: 7 on-to-off transitions).
            const roomForAll = (q: Geometry) => (q.capacity ?? 0) >= (q.tried ?? []).length;
            const rect: Rect = { x: gp.plot.x + 4, y: gp.plot.y + 2, w: 22 + mAxis(legend), h: axisSize + 4 };
            if (roomForAll(gp) && placedOf(gp) >= placedOf(g) && rect.x + rect.w <= gp.plot.x + gp.plot.w && rect.y + rect.h <= gp.plot.y + gp.plot.h
                && legendClear(gp, rect)) {
                gp.legendIn = rect;
                g = gp;
            } else if ((!roomForAll(gFoot) || placedOf(gp) > placedOf(g)) && (() => {
                // Fix round 11 (A2, notes win over the legend; the legend leaves only for a note): before
                // the legend leaves, the cards are laid out again around its top-left place. Where that
                // places as many notes as the layout without it, the legend stays in the plot. At
                // 45399de a card that a larger size moved into that corner sent the legend away with no
                // note arriving (dup 300 x 188 -> 196, rv8 386 -> 394 x 200, m24 218 -> 226 x 200).
                if (style !== "callout" || !(rect.x + rect.w <= gp.plot.x + gp.plot.w && rect.y + rect.h <= gp.plot.y + gp.plot.h)) return true;
                legendAvoid = rect;
                const gpL = settle(fixedRows - 1);
                const headL = headroom;
                legendAvoid = null;
                if (placedOf(gpL) >= placedOf(gp) && roomForAll(gpL) && legendClear(gpL, rect)) {
                    gpL.legendIn = rect;
                    g = gpL;
                    headroom = headL;
                    return false;
                }
                headroom = headP;
                return true;
            })()) {
                // Neither place is free: the legend yields (the dashed last segment still shows the
                // point is in progress) rather than cost a note. Item 3: the last period's date then
                // reads "<period> (so far)"; laid out again with that text.
                // Fix round 9 (R1, the legend yields to a note): the longer "(so far)" date is kept
                // only where it places every note the layout without the legend places; otherwise
                // the legend is still not drawn and its sentence stays in the chart's accessible
                // name and the last point's tooltip (Status: In progress). At eab8ff4 a "(so far)"
                // card too wide to place sent the legend back to the footer: monthly 300x200, 1 -> 0.
                soFarMode = true;
                const gs = settle(fixedRows - 1);
                if (placedOf(gs) >= placedOf(gp)) {
                    g = gs;
                } else {
                    soFarMode = false;
                    g = gp;
                    g.soFarCost = true;
                    headroom = headP;
                }
                g.legendOff = true;
            } else if (!g.legendIn) {
                g = gFoot;
                headroom = headFoot;
            }
        }
        // Fix round 10 (R7): round 4's size guard (each smaller size's placement seeded at this size,
        // over a 9x9 ladder of sizes and round 8's near sizes) and round 8's near-size scale-up are
        // gone: under the spread order a card places the longest prefix that lays out, so there is no
        // "most labels" placement to search for.
        if (soFarPass === 2) g.soFarMust = true;
        this.geom = g;
        const soFar = (f: (p: Point) => string, always = false) => (p: Point): string => (soFarMode || (always && g.legendOff)) && lastInProgress && p === lastPt ? this.t("Label_SoFar", f(p)) : f(p);
        // Fix round 9 (R1): where the "(so far)" card text cost a note, the long (accessible) date still
        // says the period is partial: it costs no room.
        this.drawChart(c, pts, g, soFar(fmtAxis), soFar(fmtAxisLong, true), notices, footRowH, {
            dateFont, capFont, axisFont, titleFont, noteSize, axisSize, titleH, showTitle, showX, mAxis, mCap, mDate, W, H, sep, showDate,
            valueName, axisName, dateAxis, yLabel, lastInProgress, legend,
        });
        if ((W > vw || H > vh) && this.svg) {
            this.svg.setAttribute("width", String(vw));
            this.svg.setAttribute("height", String(vh));
            this.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
            this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        }
        // Fix round 10 (R9): the reader must see that the last period is unfinished, through the "In
        // progress" legend, the "(so far)" note date or the last x label saying so. Round 9 gave the
        // "(so far)" date up where it cost a note; where that leaves none of the three drawn, the
        // chart is laid out again with the "(so far)" date kept even at the cost of a note (a part
        // period read as a fall is a wrong reading, which outranks one note). Where even that draws
        // no mark (the last point has no placed note), the usual layout is drawn with the last point's
        // own x label kept, saying "(so far)" (pass 2: `soFarMust`).
        if (legend && soFarPass === 0 && !this.inProgressShown()) {
            const again = (pass: 1 | 2) => {
                this.clear();
                this.renderChart(c, pts, dateAxis, fmtAxis, fmtAxisLong, fmtValue, notices, vw, vh, valueName, axisName, breaks, lastInProgress, legend, valueFormat, pass);
            };
            again(1);
            if (!this.inProgressShown()) again(2);
        }
    }

    /** Fix round 10 (R9): an in-progress mark is drawn (the legend, or a "(so far)" text). */
    private inProgressShown(): boolean {
        if (!this.svg) return false;
        if (this.svg.querySelector("text.at-legend")) return true;
        const mark = this.t("Label_SoFar", "").trim();
        return Array.from(this.svg.querySelectorAll("text")).some(t => (t.textContent || "").includes(mark));
    }

    // ─── Drawing ────────────────────────────────────────────────────────────────────────────

    private drawChart(
        c: Colours, pts: Point[], g: Geometry, fmtAxis: (p: Point) => string, fmtAxisLong: (p: Point) => string,
        notices: string[], footRowH: number,
        o: {
            dateFont: string; capFont: string; axisFont: string; titleFont: string; noteSize: number; axisSize: number; titleH: number;
            showTitle: boolean; showX: boolean; mAxis: (s: string) => number; mCap: (s: string) => number; mDate: (s: string) => number;
            W: number; H: number; sep: string; showDate: boolean; valueName: string; axisName: string; dateAxis: boolean;
            yLabel: (v: number) => string; lastInProgress: boolean; legend: string | null;
        },
    ): void {
        const s = this.settings;
        const svg = svgEl("svg", this.root, { width: o.W, height: o.H, class: "at-svg", role: "listbox", "aria-multiselectable": "true" });
        // Item 3: the in-progress sentence is part of the chart's name, whether or not the legend is drawn.
        svg.setAttribute("aria-label", this.t("Aria_Chart", o.valueName, o.axisName) + (o.lastInProgress && o.legend ? `. ${o.legend}` : ""));
        svg.setAttribute("data-note-candidates", String(g.candidates.length));
        this.svg = svg;
        const box = g.box, plot = g.plot;

        // Title (inside the iframe, Policy 1180.2.5).
        if (o.showTitle) {
            const ts = s.titleSettings;
            const align = String(ts.titleAlign.value || "left");
            const mt = this.measurer(o.titleFont);
            const text = truncateToWidth(ts.titleText.value, box.w, mt).text;
            const x = align === "center" ? box.x + box.w / 2 : align === "right" ? box.x + box.w : box.x;
            const te = svgEl("text", svg, {
                class: "at-title", x: f2(x), y: f2(box.y + (Number(ts.titleFontSize.value) || 14)),
                "text-anchor": align === "center" ? "middle" : align === "right" ? "end" : "start",
                fill: this.titleColour(c), "font-family": ts.titleFontFamily.value || "Segoe UI, sans-serif",
                "font-size": Number(ts.titleFontSize.value) || 14, "font-weight": ts.titleBold.value ? 700 : 400,
                "font-style": ts.titleItalic.value ? "italic" : "normal", "text-decoration": ts.titleUnderline.value ? "underline" : "none",
            });
            te.textContent = text;
        }

        // Value axis (optional) and zero line.
        const grid = svgEl("g", svg, { class: "at-grid", "pointer-events": "none" });
        for (const t of g.yTicks) {
            if (t.v !== 0) svgEl("line", grid, { x1: f2(plot.x), x2: f2(plot.x + plot.w), y1: f2(t.y), y2: f2(t.y), stroke: c.track, "stroke-width": 1, "stroke-dasharray": c.hc ? "2 3" : "" });
            const lt = svgEl("text", grid, { class: "at-ylabel", x: f2(plot.x - 6), y: f2(t.y + o.axisSize * 0.35), "text-anchor": "end", fill: c.axis, "font-size": o.axisSize });
            lt.textContent = o.yLabel(t.v);
        }
        const hasNeg = pts.some(p => p.reading.state === "ok" && (p.reading.value as number) < 0);
        if (g.zeroIn) svgEl("line", grid, {
            class: "at-zero", x1: f2(plot.x), x2: f2(plot.x + plot.w), y1: f2(g.zeroY), y2: f2(g.zeroY),
            stroke: hasNeg ? c.axis : c.track, "stroke-width": hasNeg ? 1.2 : 1,
        });

        // Hover overlay sits under the marks; events above it take their own pointer events.
        // Fix round 7 (M2): it is also the plot's one tab stop; the arrow keys walk every point.
        const overlay = svgEl("rect", svg, { class: "at-overlay", x: f2(plot.x - 4), y: f2(plot.y), width: f2(Math.max(0, plot.w + 8)), height: f2(Math.max(0, g.zeroY - plot.y + Math.max(0, plot.y + plot.h - g.zeroY))), fill: "transparent",
            tabindex: 0, role: "option", "aria-selected": "false", "aria-label": this.t("Aria_Plot", o.valueName, pts.length) });

        // Series.
        // Marks never take the pointer: the overlay under them owns hover, click and the point menu.
        const series = svgEl("g", svg, { class: "at-series", "pointer-events": "none" });
        if (c.lineFilter !== "none") series.style.filter = c.lineFilter;
        const lw = Math.max(0.5, Math.min(6, Number(s.series.lineWidth.value) || DEFAULTS.lineWidth));
        const last = pts.length - 1;
        const inProgress = o.lastInProgress && pts[last].reading.state === "ok";
        const evColour = (p: Point): string => this.eventColour(c, p);
        // Event columns are drawn solid only for drawn events (note candidates); a note beyond the cap
        // is a plain column, counted in the overflow (F2: one node per drawn event, not per note).
        const drawnEv = new Set(g.candidates);
        if (g.mark === "columns") {
            const bw = columnWidth(g.band);
            let d = "";
            pts.forEach((p, i) => {
                const y = g.ys[i];
                if (y === null || drawnEv.has(i) || (inProgress && i === last)) return;
                const y0 = Math.min(y, g.zeroY), h = Math.abs(g.zeroY - y);
                d += `M${f2(g.xs[i] - bw / 2)} ${f2(y0)}h${f2(bw)}v${f2(Math.max(0.5, h))}h${f2(-bw)}Z`;
            });
            svgEl("path", series, { class: "at-columns", d, fill: c.columns, "fill-opacity": c.hc ? 1 : 0.6 });
            pts.forEach((p, i) => {
                const y = g.ys[i];
                if (y === null || !(drawnEv.has(i) || (inProgress && i === last))) return;
                const y0 = Math.min(y, g.zeroY), h = Math.max(0.5, Math.abs(g.zeroY - y));
                const isLast = inProgress && i === last && !drawnEv.has(i);
                // Item 3: an in-progress column that carries a note keeps the in-progress look in its
                // event colour (reduced fill, dashed outline in the full colour), never a complete month's.
                const partialEvent = inProgress && i === last && drawnEv.has(i);
                const ink = isLast ? c.line : evColour(p);
                svgEl("rect", series, {
                    class: isLast ? "at-column-progress" : partialEvent ? "at-column-event at-column-partial" : "at-column-event", "data-row": p.row,
                    x: f2(g.xs[i] - bw / 2), y: f2(y0), width: f2(bw), height: f2(h),
                    fill: ink, "fill-opacity": isLast || partialEvent ? 0.3 : 1,
                    stroke: isLast || partialEvent ? ink : "none", "stroke-width": partialEvent ? 1.5 : 1, "stroke-dasharray": isLast || partialEvent ? "3 2" : "",
                });
            });
        } else {
            const runs: number[][] = [];
            let cur: number[] = [];
            // A blank reading ends a run; so does a date-axis gap (F4): dates with no row are never bridged.
            pts.forEach((p, i) => {
                if (g.ys[i] === null) { if (cur.length) runs.push(cur); cur = []; return; }
                if (cur.length && g.breaks[i]) { runs.push(cur); cur = []; }
                cur.push(i);
            });
            if (cur.length) runs.push(cur);
            let line = "", area = "", dashed = "";
            for (const run of runs) {
                let r = run;
                if (inProgress && run[run.length - 1] === last && run.length > 1) {
                    const a = run[run.length - 2];
                    dashed = `M${f2(g.xs[a])} ${f2(g.ys[a] as number)}L${f2(g.xs[last])} ${f2(g.ys[last] as number)}`;
                    r = run.slice(0, -1);
                }
                if (r.length === 1) {
                    svgEl("circle", series, { class: "at-isolated", cx: f2(g.xs[r[0]]), cy: f2(g.ys[r[0]] as number), r: f2(lw + 1), fill: c.line });
                } else if (r.length > 1) {
                    line += r.map((i, k) => `${k ? "L" : "M"}${f2(g.xs[i])} ${f2(g.ys[i] as number)}`).join("");
                }
                if (run.length > 1) {
                    area += `M${f2(g.xs[run[0]])} ${f2(g.zeroY)}` + run.map(i => `L${f2(g.xs[i])} ${f2(g.ys[i] as number)}`).join("") + `L${f2(g.xs[run[run.length - 1]])} ${f2(g.zeroY)}Z`;
                }
            }
            if (g.mark === "area" && !c.hc && area) svgEl("path", series, { class: "at-area", d: area, fill: c.line, "fill-opacity": c.theme === "dark" ? 0.16 : 0.12, stroke: "none" });
            if (line) svgEl("path", series, { class: "at-line", d: line, fill: "none", stroke: c.line, "stroke-width": f2(lw), "stroke-linejoin": "round", "stroke-linecap": "round" });
            if (dashed) svgEl("path", series, { class: "at-line-progress", d: dashed, fill: "none", stroke: c.line, "stroke-width": f2(lw), "stroke-dasharray": "4 3" });
            if (inProgress) svgEl("circle", series, { class: "at-progress-point", cx: f2(g.xs[last]), cy: f2(g.ys[last] as number), r: 3.5, fill: c.surface, stroke: c.line, "stroke-width": 1.6 });
        }

        // Selection rings (non-event points) and hover guide.
        this.selectionLayer = svgEl("g", svg, { class: "at-selection", "pointer-events": "none" });
        this.hoverLayer = svgEl("g", svg, { class: "at-hover", "pointer-events": "none" });

        // Events.
        const evLayer = svgEl("g", svg, { class: "at-events" });
        const placedLeader = new Map(g.leaders.map(l => [l.id, l]));
        const placedCallout = new Map(g.callouts.map(l => [l.id, l]));
        const placedPin = new Map(g.pins.map(l => [l.id, l]));
        const pinNumber = new Map<number, number>();
        g.pins.slice().sort((a, b) => a.id - b.id).forEach((p, k) => pinNumber.set(p.id, k + 1));
        const halo = { "paint-order": "stroke", stroke: c.surface, "stroke-width": 4, "stroke-linejoin": "round" };
        const eventIdx = g.candidates;
        this.eventNodes = [];
        for (const i of eventIdx) {
            const p = pts[i];
            const x = g.xs[i];
            const py = g.ys[i] ?? g.zeroY;
            const colour = evColour(p);
            const ge = svgEl("g", evLayer, { class: "at-event", "data-row": p.row, tabindex: 0, role: "option", "aria-selected": "false" });
            const valuePart = this.tipFor(p)[1].value;
            // F8: date, measure name and value, event type (when bound), note.
            ge.setAttribute("aria-label", p.type
                ? this.t("Aria_Event", fmtAxisLong(p), o.valueName, valuePart, p.type, p.note as string)
                : this.t("Aria_Event_NoType", fmtAxisLong(p), o.valueName, valuePart, p.note as string));
            const markG = svgEl("g", ge, { class: "at-mark" });
            if (c.eventFilter(colour) !== "none") markG.style.filter = c.eventFilter(colour);
            const hollow = g.ys[i] === null;
            const L = placedLeader.get(i), B = placedCallout.get(i), P = placedPin.get(i);
            if (L) {
                const rowBase = g.bandTop + L.row * g.rowH + o.noteSize;
                // Round 6 item 7: on columns the leader ends above its own column's top (a negative
                // column's value end is its bottom: the leader never runs down through it). Item 6:
                // on a line or area it ends where its ink clears the line's (a dip's flanks).
                const ly1 = rowBase - o.noteSize * 0.85;
                const ly2 = g.mark === "columns" ? Math.min(py, g.zeroY) - 4
                    : hollow ? py - 4 : leaderDropEnd({ xs: g.xs, ys: g.ys }, g.breaks, x, ly1, py - 4, (lw + 1.2) / 2 + 0.5);
                if (ly2 > ly1) svgEl("line", markG, { class: "at-leader", x1: f2(x), x2: f2(x), y1: f2(ly1), y2: f2(ly2), stroke: colour, "stroke-width": 1.2, "stroke-dasharray": hollow ? "3 2" : "" });
                const te = svgEl("text", ge, Object.assign({
                    class: "at-label", x: f2(L.anchor === "end" ? L.right : L.left), y: f2(rowBase),
                    "text-anchor": L.anchor === "end" ? "end" : "start", "font-size": o.noteSize,
                    "font-family": s.annotations.noteFontFamily.value || "Segoe UI, sans-serif",
                    "font-style": s.annotations.noteItalic.value ? "italic" : "normal",
                }, halo));
                if (L.date) { const d = svgEl("tspan", te, { class: "at-label-date", "font-weight": 700, fill: c.text }); d.textContent = L.date; }
                const cp = svgEl("tspan", te, { class: "at-label-caption", "font-weight": s.annotations.noteBold.value ? 700 : 500, fill: c.muted });
                cp.textContent = L.caption;
            }
            if (B) {
                const lp = B.leader.map(([a, b], k) => `${k ? "L" : "M"}${f2(a)} ${f2(b)}`).join("");
                svgEl("path", markG, { class: "at-leader", d: lp, fill: "none", stroke: colour, "stroke-width": 1.2 });
                svgEl("rect", ge, { class: "at-card", x: f2(B.rect.x), y: f2(B.rect.y), width: f2(B.rect.w), height: f2(B.rect.h), rx: 5, fill: c.surface, stroke: colour, "stroke-width": c.hc ? 2 : 1.2 });
                const cm = cardMetrics(o.noteSize);
                const tt = svgEl("text", ge, { class: "at-card-title", x: f2(B.rect.x + 9), y: f2(B.rect.y + cm.title), "font-size": o.noteSize + 1, "font-weight": 700, fill: c.text, "font-family": s.annotations.noteFontFamily.value || "Segoe UI, sans-serif" });
                tt.textContent = B.title;
                B.lines.forEach((ln, k) => {
                    const lt = svgEl("text", ge, { class: "at-card-line", x: f2(B.rect.x + 9), y: f2(B.rect.y + cm.first + k * cm.step), "font-size": o.noteSize, "font-weight": s.annotations.noteBold.value ? 700 : 500, fill: c.muted, "font-family": s.annotations.noteFontFamily.value || "Segoe UI, sans-serif", "font-style": s.annotations.noteItalic.value ? "italic" : "normal" });
                    lt.textContent = ln;
                });
            }
            if (P) {
                const n = pinNumber.get(i) as number;
                // Round 6 item 1: a pin held inside the drawing edge sits beside its point; the stem stays
                // on the point and starts where it meets the circle.
                const sdx = Math.min(PINS.r, Math.abs(x - P.cx));
                svgEl("line", markG, { class: "at-stem", x1: f2(x), x2: f2(x), y1: f2(P.cy + Math.sqrt(PINS.r * PINS.r - sdx * sdx)), y2: f2(P.top - 1), stroke: colour, "stroke-width": 1.2 });
                svgEl("circle", markG, { class: "at-pin", cx: f2(P.cx), cy: f2(P.cy), r: PINS.r, fill: colour });
                const nt = svgEl("text", ge, { class: "at-pin-number", x: f2(P.cx), y: f2(P.cy + 3.8), "text-anchor": "middle", "font-size": 10.5, "font-weight": 700, fill: c.hc ? (this.hcBackground()) : discInk(colour) });
                nt.textContent = String(n);
            } else if (L || B) {
                if (hollow) svgEl("circle", markG, { class: "at-marker", cx: f2(x), cy: f2(py), r: 3.5, fill: c.surface, stroke: colour, "stroke-width": 1.5 });
                else svgEl("circle", markG, { class: "at-marker", cx: f2(x), cy: f2(py), r: 3.5, fill: colour });
            } else {
                // Note without room: the marker stays (hollow), the text is in the tooltip and aria-label.
                svgEl("circle", markG, { class: "at-marker at-marker-overflow", cx: f2(x), cy: f2(py), r: 3, fill: c.surface, stroke: colour, "stroke-width": 1.5 });
            }
            this.bindEvent(ge, i, p);
            this.eventNodes.push(ge);
        }

        // C key (chronological, numbered like the pins).
        if (g.style === "pins" && g.pins.length) {
            const keyG = svgEl("g", svg, { class: "at-key" });
            const sorted = g.pins.slice().sort((a, b) => a.id - b.id);
            const rows = Math.ceil(sorted.length / g.keyCols);
            sorted.forEach((pin, k) => {
                const col = Math.floor(k / rows), row = k % rows;
                const x0 = box.x + col * g.keyColW, y0 = g.keyTop + row * g.keyRowH + g.keyRowH / 2 + 4;
                const p = pts[pin.id];
                const colour = evColour(p);
                const node = this.eventNodes[eventIdx.indexOf(pin.id)];
                const rg = svgEl("g", node ?? keyG, { class: "at-key-row" });
                svgEl("circle", rg, { class: "at-key-pin", cx: f2(x0 + PINS.r), cy: f2(y0), r: PINS.r, fill: colour });
                const nt = svgEl("text", rg, { class: "at-key-number", x: f2(x0 + PINS.r), y: f2(y0 + 3.8), "text-anchor": "middle", "font-size": 10.5, "font-weight": 700, fill: c.hc ? this.hcBackground() : discInk(colour) });
                nt.textContent = String(k + 1);
                const dx = x0 + 2 * PINS.r + 8;
                const date = o.showDate ? fmtAxis(p) : "";
                const dw = date ? o.mDate(date) + 10 : 0;
                if (date) { const dt = svgEl("text", rg, { class: "at-key-date", x: f2(dx), y: f2(y0 + o.noteSize * 0.36), "font-size": o.noteSize, "font-weight": 700, fill: c.text }); dt.textContent = date; }
                const room = g.keyColW - (dx - x0) - dw - 12;
                const cap = truncateToWidth(p.note as string, Math.max(0, room), o.mCap);
                const ct = svgEl("text", rg, { class: "at-key-caption", x: f2(dx + dw), y: f2(y0 + o.noteSize * 0.36), "font-size": o.noteSize, "font-weight": s.annotations.noteBold.value ? 700 : 500, fill: c.muted, "font-style": s.annotations.noteItalic.value ? "italic" : "normal" });
                ct.textContent = cap.text;
            });
        }

        // x axis labels.
        // Fix round 10 (R9): the last x label says "(so far)" wherever the legend is not drawn (round 9:
        // only where it yielded to a note; a shed footer drew neither).
        const legendDrawn = !!o.legend && !g.legendOff && (!g.footShed || !!g.legendIn);
        if (o.showX) this.drawXAxis(svg, c, pts, g, o.dateAxis, fmtAxis, o.mAxis, o.axisSize, o.lastInProgress && !legendDrawn ? (g.soFarMust ? "must" : true) : false);

        // Footer: notices, then the overflow count (focusable; its tooltip lists the notes without room).
        const foot = svgEl("g", svg, { class: "at-footer" });
        // Legend for the in-progress last point: a dashed swatch in the series colour and its text.
        let footStart = g.footerTop;
        if (o.legend && !g.legendOff && (!g.footShed || g.legendIn)) {
            const li = g.legendIn;
            const lx = li ? li.x : box.x;
            const y = li ? li.y + o.axisSize : footStart + o.axisSize + 2;
            svgEl("line", foot, { class: "at-legend-swatch", x1: f2(lx), x2: f2(lx + 16), y1: f2(y - o.axisSize * 0.35), y2: f2(y - o.axisSize * 0.35), stroke: c.line, "stroke-width": f2(lw), "stroke-dasharray": "4 3" });
            const le = svgEl("text", foot, { class: "at-legend", x: f2(lx + 22), y: f2(y), "font-size": o.axisSize, fill: c.muted });
            le.textContent = truncateToWidth(o.legend, Math.max(0, (li ? li.w : box.w) - 22), o.mAxis).text;
            if (!li) footStart += footRowH;
        }
        const lines = notices.slice();
        const overflowCount = g.overflow.length;
        if (overflowCount > 0) lines.push(overflowCount === 1 ? this.t("Overflow_One") : this.t("Overflow_Many", overflowCount));
        // Fix round 8 (Low): a shed footer on a pins chart that placed no pin leaves the pin band
        // above the marks empty; the hidden-note count goes there, whole, when it fits clear of
        // every mark (the plot's top edge down to the highest point's band), instead of being shed.
        let inBand: { x: number; y: number } | null = null;
        if (g.footShed && overflowCount > 0 && g.style === "pins" && g.pins.length === 0 && !g.legendIn) {
            const ln = lines[lines.length - 1];
            const w = o.mAxis(ln), x = g.plot.x + 2, base = g.plot.y + o.axisSize;
            if (x + w <= g.plot.x + g.plot.w - 2 && base + Math.ceil(o.axisSize * 0.3) + 2 <= (g.yTop ?? g.plot.y)) inBand = { x, y: base };
        }
        // The chart's accessible name keeps every shed line, the count too (it is also the drawn button's name).
        if (g.footShed && lines.length) svg.setAttribute("aria-label", `${svg.getAttribute("aria-label")}. ${lines.join(". ")}`);
        const drawn = g.footShed ? (inBand ? [lines[lines.length - 1]] : []) : lines;
        drawn.forEach((ln, k) => {
            const isOverflow = overflowCount > 0 && (inBand !== null || k === lines.length - 1);
            const y = inBand ? inBand.y : footStart + k * footRowH + o.axisSize + 2;
            const tr = truncateToWidth(ln, box.w, o.mAxis);
            const te = svgEl("text", foot, { class: isOverflow ? "at-overflow" : "at-notice", x: f2(inBand ? inBand.x : box.x), y: f2(y), "font-size": o.axisSize, fill: isOverflow ? c.text : c.muted, "font-weight": isOverflow ? 600 : 400 });
            te.textContent = tr.text;
            if (isOverflow) {
                te.setAttribute("tabindex", "0");
                te.setAttribute("role", "button");
                te.setAttribute("aria-label", this.t("Aria_Overflow", ln));
                const items = (): VisualTooltipDataItem[] => {
                    const hidden = g.overflow.slice().sort((a, b) => a - b);
                    const out: VisualTooltipDataItem[] = [{ displayName: this.t("Overflow_TipTitle"), value: String(hidden.length) }];
                    hidden.slice(0, 12).forEach(i => out.push({ displayName: fmtAxisLong(pts[i]), value: pts[i].note as string }));
                    if (hidden.length > 12) out.push({ displayName: "", value: this.t("Overflow_TipMore", hidden.length - 12) });
                    return out;
                };
                te.addEventListener("mousemove", (e: MouseEvent) => this.tooltipService.show({ coordinates: [e.clientX, e.clientY], isTouchEvent: false, dataItems: items(), identities: [] }));
                te.addEventListener("mouseleave", () => this.tooltipService.hide({ isTouchEvent: false, immediately: false }));
                te.addEventListener("focus", () => { const r = te.getBoundingClientRect(); this.tooltipService.show({ coordinates: [r.left, r.top], isTouchEvent: false, dataItems: items(), identities: [] }); });
                te.addEventListener("blur", () => this.tooltipService.hide({ isTouchEvent: false, immediately: true }));
            } else if (tr.truncated) {
                te.addEventListener("mousemove", (e: MouseEvent) => this.tooltipService.show({ coordinates: [e.clientX, e.clientY], isTouchEvent: false, dataItems: [{ displayName: "", value: ln }], identities: [] }));
                te.addEventListener("mouseleave", () => this.tooltipService.hide({ isTouchEvent: false, immediately: false }));
            }
        });

        // Hover over the plot: nearest point, guide line, tooltip with identity; click selects it.
        // Fix round 7 (H1): the nearest DRAWN MARK, vertical distance breaking a tie on one date;
        // hover, click and the context menu (data-row, read by the one contextmenu listener) all
        // resolve through pick(), so they name the same row.
        // Fix round 8 (H1): marks within one CSS pixel of the nearest x compete on their drawn
        // position (the band is in drawing units, so it widens where the drawing is scaled down).
        const pick = (e: MouseEvent): number => {
            const r = svg.getBoundingClientRect();
            const m = svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width && svg.getScreenCTM ? svg.getScreenCTM() : null;
            const band = 1 / ((m && m.a) || 1);
            return nearestPoint(g.xs, g.ys, svgX(svg, e.clientX, r), svgY(svg, e.clientY, r), g.zeroY, band);
        };
        overlay.addEventListener("mousemove", (e: MouseEvent) => {
            const i = pick(e);
            if (i < 0) return;
            this.drawHover(c, g, i);
            overlay.setAttribute("data-row", String(pts[i].row));
            this.tooltipService.show({ coordinates: [e.clientX, e.clientY], isTouchEvent: false, dataItems: this.tipFor(pts[i]), identities: [this.idOf(pts[i].row)] });
        });
        // Fix round 8 (H2): a menu asked for from the keyboard (Shift+F10, the Menu key) opens on the
        // row the keys left active, anchored at its drawn point; only a pointer menu picks by
        // coordinates (the keyboard one arrives at the element's centre, another row).
        // Fix round 11 (A7): with columns, a point under the pointer is a drawn column (at least 4
        // CSS px wide and tall to hit); anywhere else in the plot is empty space.
        // Desktop fix round 1 (owner report 2026-11-22, ruling "selection as Power BI's own visuals"):
        // on a line or area a click selects a point only on its drawn mark: within POINT_HIT CSS px
        // of the point, or within LINE_HIT CSS px of a line segment that meets it. Anywhere else in
        // the plot is empty space: the click clears and the menu is the empty-space menu (the line
        // chart's click took the nearest point from anywhere in the plot).
        const hit = (e: MouseEvent): number => {
            const i = pick(e);
            if (i < 0) return i;
            const r = svg.getBoundingClientRect();
            const m = svg.getScreenCTM ? svg.getScreenCTM() : null;
            const unit = 1 / ((m && m.a) || 1);
            const x = svgX(svg, e.clientX, r), y = svgY(svg, e.clientY, r);
            if (g.mark !== "columns") {
                const yi = g.ys[i];
                if (yi === null || yi === undefined) return -1;
                if (Math.hypot(x - g.xs[i], y - yi) <= POINT_HIT * unit) return i;
                const near = (k: number): boolean => {
                    const yk = g.ys[k];
                    if (k < 0 || k >= g.xs.length || yk === null || yk === undefined || g.breaks[Math.max(i, k)]) return false;
                    return segmentDistance(x, y, g.xs[i], yi, g.xs[k], yk) <= LINE_HIT * unit;
                };
                return near(i - 1) || near(i + 1) ? i : -1;
            }
            const half = Math.max(columnWidth(g.band), 4 * unit) / 2;
            const top = g.ys[i] ?? g.zeroY;
            const y0 = Math.min(top, g.zeroY) - 2 * unit, y1 = Math.max(top, g.zeroY) + 2 * unit;
            return Math.abs(x - g.xs[i]) <= half && y >= y0 && y <= y1 ? i : -1;
        };
        overlay.addEventListener("contextmenu", (e: MouseEvent) => {
            if (isKeyboardMenu(e)) {
                const k = kIdx < 0 ? 0 : kIdx;
                overlay.setAttribute("data-row", String(pts[k].row));
                this.menuAnchor = pointOnScreen(k);
                return;
            }
            const i = hit(e);
            if (i >= 0) overlay.setAttribute("data-row", String(pts[i].row));
            else overlay.removeAttribute("data-row");
        });
        // Fix round 7 (M2): keyboard over every point (not only the notes): focus starts at the
        // first point (or where the keys left it), arrows and Home / End move, Enter or Space
        // selects (Ctrl / Cmd adds), Escape clears (the root's handler). The tooltip and identity
        // are the mouse path's (tipFor, idOf); the accessible name carries the same text.
        let kIdx = -1;
        const pointOnScreen = (i: number): { x: number; y: number } => {
            const m = svg.getScreenCTM ? svg.getScreenCTM() : null;
            const px = g.xs[i], py = g.ys[i] ?? g.zeroY;
            const r = svg.getBoundingClientRect();
            return { x: m ? m.a * px + m.e : r.left + px, y: m ? m.d * py + m.f : r.top + py };
        };
        const kShow = (i: number) => {
            kIdx = Math.max(0, Math.min(pts.length - 1, i));
            const p = pts[kIdx];
            this.drawHover(c, g, kIdx);
            overlay.setAttribute("data-row", String(p.row));
            // Fix round 8 (M4): the option's selected state follows the reading it now names.
            this.markOverlaySelected();
            const items = this.tipFor(p);
            overlay.setAttribute("aria-label", this.t("Aria_Point", kIdx + 1, pts.length, items.map(it => it.displayName ? `${it.displayName}: ${it.value}` : it.value).join(". ")));
            const at = pointOnScreen(kIdx);
            this.tooltipService.show({ coordinates: [at.x, at.y], isTouchEvent: false, dataItems: items, identities: [this.idOf(p.row)] });
        };
        // Desktop fix round 1: a pointer click focuses the overlay too; only a keyboard focus walks to
        // the keyboard's point (it showed January 2025's tooltip under a click on May 2026).
        overlay.addEventListener("focus", () => { if (keyboardFocus(overlay)) kShow(kIdx < 0 ? 0 : kIdx); });
        overlay.addEventListener("blur", () => {
            while (this.hoverLayer && this.hoverLayer.firstChild) this.hoverLayer.removeChild(this.hoverLayer.firstChild);
            this.tooltipService.hide({ isTouchEvent: false, immediately: true });
        });
        overlay.addEventListener("keydown", (e: KeyboardEvent) => {
            const k = kIdx < 0 ? 0 : kIdx;
            if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); kShow(k + 1); }
            else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); kShow(k - 1); }
            else if (e.key === "Home") { e.preventDefault(); kShow(0); }
            else if (e.key === "End") { e.preventDefault(); kShow(pts.length - 1); }
            else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault(); e.stopPropagation();
                if (this.host.allowInteractions === false) return;
                this.selectionManager.select(this.idOf(pts[k].row), multiKey(e)).then(() => this.applySelection());
            }
        });
        overlay.addEventListener("mouseleave", () => {
            while (this.hoverLayer && this.hoverLayer.firstChild) this.hoverLayer.removeChild(this.hoverLayer.firstChild);
            this.tooltipService.hide({ isTouchEvent: false, immediately: false });
        });
        overlay.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            if (this.host.allowInteractions === false) return;
            const i = hit(e);
            // The tooltip names the point under the pointer after any click, as the hover does.
            const hover = pick(e);
            if (hover >= 0) {
                this.drawHover(c, g, hover);
                overlay.setAttribute("data-row", String(pts[hover].row));
                this.tooltipService.show({ coordinates: [e.clientX, e.clientY], isTouchEvent: false, dataItems: this.tipFor(pts[hover]), identities: [this.idOf(pts[hover].row)] });
            }
            if (i < 0) { this.selectionManager.clear().then(() => this.applySelection()); return; }
            this.selectionManager.select(this.idOf(pts[i].row), multiKey(e)).then(() => this.applySelection());
        });
        this.applySelection();
    }

    private hcBackground(): string {
        const palette = this.host.colorPalette as powerbi.extensibility.ISandboxExtendedColorPalette;
        return palette.background?.value || "#000000";
    }

    /** Per-event colour: a fx rule result (per row, in categories[0].objects) is data and is painted
     *  verbatim in every Codex mode; high contrast always uses the host palette. */
    private eventColour(c: Colours, p: Point): string {
        if (c.hc) return c.hcLink;
        const objs = this.axisCol?.objects?.[p.row] as { annotations?: { eventColor?: { solid?: { color?: string } } } } | undefined;
        const rule = objs?.annotations?.eventColor?.solid?.color;
        return rule || c.eventDefault;
    }

    private drawXAxis(svg: SVGSVGElement, c: Colours, pts: Point[], g: Geometry, dateAxis: boolean, fmtAxis: (p: Point) => string, m: (s: string) => number, size: number, soFar: boolean | "must" = false): void {
        const ax = svgEl("g", svg, { class: "at-xaxis" });
        const y = g.xAxisY + size + 3;
        const box = g.box;
        const candidates: { x: number; text: string }[][] = [];
        if (dateAxis && pts.length > 1) {
            const t0 = pts[0].t as number, t1 = pts[pts.length - 1].t as number;
            const span = t1 - t0;
            const x = linear(t0, t1, g.xs[0], g.xs[g.xs.length - 1]);
            const multi = new Date(t0).getFullYear() !== new Date(t1).getFullYear();
            const locale = this.host.locale || "en-US";
            const maxTicks = Math.max(2, Math.floor(box.w / 18));
            const days = [1, 2, 7, 14], months = [1, 3, 6], years = [1, 2, 5, 10, 25, 50];
            const dayMs = 864e5;
            for (const step of days) {
                if (span / (step * dayMs) > maxTicks) continue;
                const out: { x: number; text: string }[] = [];
                const d = new Date(t0); d.setHours(0, 0, 0, 0); if (d.getTime() < t0) d.setDate(d.getDate() + 1);
                for (let k = 0; d.getTime() <= t1 && k < 2000; k++, d.setDate(d.getDate() + step)) out.push({ x: x(d.getTime()), text: dateLabel(d.getTime(), "day", multi, locale) });
                candidates.push(out);
            }
            for (const step of months) {
                if (span / (step * 28 * dayMs) > maxTicks * 1.2) continue;
                const out: { x: number; text: string }[] = [];
                const d = new Date(t0); d.setHours(0, 0, 0, 0); d.setDate(1); if (d.getTime() < t0) d.setMonth(d.getMonth() + 1);
                while (d.getMonth() % step !== 0) d.setMonth(d.getMonth() + 1);
                for (let k = 0; d.getTime() <= t1 && k < 2000; k++, d.setMonth(d.getMonth() + step)) {
                    let text: string;
                    try { text = new Intl.DateTimeFormat(dateLocale(locale), multi ? { month: "short", year: "numeric" } : { month: "short" }).format(d); } catch { text = d.toISOString().slice(0, 7); }
                    out.push({ x: x(d.getTime()), text });
                }
                candidates.push(out);
            }
            for (const step of years) {
                const out: { x: number; text: string }[] = [];
                const d = new Date(new Date(t0).getFullYear(), 0, 1); if (d.getTime() < t0) d.setFullYear(d.getFullYear() + 1);
                while (d.getFullYear() % step !== 0) d.setFullYear(d.getFullYear() + 1);
                for (let k = 0; d.getTime() <= t1 && k < 2000; k++, d.setFullYear(d.getFullYear() + step)) out.push({ x: x(d.getTime()), text: String(d.getFullYear()) });
                candidates.push(out);
            }
            // A span shorter than one tick unit still gets its two end labels.
            candidates.push([{ x: g.xs[0], text: fmtAxis(pts[0]) }, { x: g.xs[g.xs.length - 1], text: fmtAxis(pts[pts.length - 1]) }]);
        } else {
            for (const step of [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
                if (pts.length / step > Math.max(2, box.w / 12)) continue;
                const out: { x: number; text: string }[] = [];
                for (let i = 0; i < pts.length; i += step) out.push({ x: g.xs[i], text: fmtAxis(pts[i]) });
                candidates.push(out);
            }
            candidates.push([{ x: g.xs[0], text: fmtAxis(pts[0]) }]);
        }
        // Item 3: with the legend dropped, the LAST POINT's own label reads "<period> (so far)".
        // Round 5 item 3: only that label. A tick set whose last tick is an earlier period (a
        // 3-month step ending in Jul with Nov in progress) carries no mark: thinning dropped the
        // in-progress label, and no other label may take it.
        // Fix round 10 (R9): "must" (no other in-progress mark is drawn): only tick sets that end on the
        // last point qualify, and the last point's label alone is the last resort.
        if (soFar === "must") {
            const lastX = g.xs[g.xs.length - 1];
            for (let k = candidates.length - 1; k >= 0; k--) {
                const set = candidates[k], lastT = set[set.length - 1];
                if (!lastT || Math.abs(lastT.x - lastX) > 0.5) candidates.splice(k, 1);
            }
            candidates.push([{ x: lastX, text: fmtAxis(pts[pts.length - 1]) }]);
        }
        if (soFar) {
            const lastX = g.xs[g.xs.length - 1];
            for (const set of candidates) {
                const lastT = set[set.length - 1];
                if (!lastT || Math.abs(lastT.x - lastX) > 0.5) continue;
                if (lastT.text.endsWith(this.t("Label_SoFar", ""))) continue;
                set[set.length - 1] = { x: lastT.x, text: this.t("Label_SoFar", lastT.text) };
            }
        }
        // The finest tick set whose labels fit without touching (8 px gap), clamped inside the box.
        // Item 5 (fix round 3): with the value axis on, its gutter left of the plot is reserved for
        // the value labels: a date label starts no further left than the plot, so the bottom value
        // label ("0") and the first date label never meet in the corner.
        const lo = g.yTicks.length ? Math.max(box.x, g.plot.x) : box.x;
        // Fix round 7 (M5): a label wider than the whole axis span is shortened by the measured
        // truncation (ellipsis); its full text is its tooltip, and the plot's keyboard name.
        const spanW = Math.max(0, box.x + box.w - lo);
        const lay = (set: { x: number; text: string }[]) => {
            const out: { x: number; w: number; text: string; full?: string }[] = [];
            for (const t of set) {
                let text = t.text, w = m(text), full: string | undefined;
                if (w > spanW) { const tr = truncateToWidth(t.text, spanW, m); full = t.text; text = tr.text; w = m(text); }
                const left = Math.max(lo, Math.min(box.x + box.w - w, t.x - w / 2));
                if (out.length && left < out[out.length - 1].x + out[out.length - 1].w + 8) return null;
                out.push(full === undefined ? { x: left, w, text } : { x: left, w, text, full });
            }
            return out;
        };
        let chosen: { x: number; w: number; text: string; full?: string }[] | null = null;
        for (const set of candidates) { if (set.length === 0) continue; const l = lay(set); if (l && l.length >= 2) { chosen = l; break; } if (l && !chosen) chosen = l; }
        if (!chosen) {
            const full = fmtAxis(pts[0]);
            const first = truncateToWidth(full, spanW, m);
            chosen = [first.truncated ? { x: lo, w: m(first.text), text: first.text, full } : { x: lo, w: m(first.text), text: first.text }];
        }
        for (const t of chosen) {
            const te = svgEl("text", ax, { class: "at-xlabel", x: f2(t.x), y: f2(y), "font-size": size, fill: c.axis });
            te.textContent = t.text;
            if (t.full !== undefined && t.full !== t.text) {
                const full = t.full;
                te.setAttribute("data-full", full);
                te.addEventListener("mousemove", (e: MouseEvent) => this.tooltipService.show({ coordinates: [e.clientX, e.clientY], isTouchEvent: false, dataItems: [{ displayName: "", value: full }], identities: [] }));
                te.addEventListener("mouseleave", () => this.tooltipService.hide({ isTouchEvent: false, immediately: false }));
            }
        }
    }

    private drawHover(c: Colours, g: Geometry, i: number): void {
        const h = this.hoverLayer;
        if (!h) return;
        while (h.firstChild) h.removeChild(h.firstChild);
        svgEl("line", h, { class: "at-guide", x1: f2(g.xs[i]), x2: f2(g.xs[i]), y1: f2(g.plot.y), y2: f2(g.plot.y + g.plot.h), stroke: c.axis, "stroke-width": 1, "stroke-dasharray": "2 3", opacity: 0.7 });
        const y = g.ys[i];
        if (y !== null) svgEl("circle", h, { class: "at-guide-dot", cx: f2(g.xs[i]), cy: f2(y), r: 3.5, fill: c.surface, stroke: c.line, "stroke-width": 1.6 });
    }

    // ─── Interaction ────────────────────────────────────────────────────────────────────────

    private idOf(row: number): ISelectionId {
        let id = this.ids.get(row);
        if (!id && this.axisCol) {
            id = this.host.createSelectionIdBuilder().withCategory(this.axisCol, row).createSelectionId();
            this.ids.set(row, id);
        }
        return id;
    }

    private idFromEvent(e: Event): ISelectionId | null {
        const t = e.target as Element | null;
        const el = t && (t as Element).closest ? (t as Element).closest("[data-row]") : null;
        if (!el || !this.axisCol) return null;
        const row = Number(el.getAttribute("data-row"));
        return Number.isInteger(row) ? this.idOf(row) : null;
    }

    private bindEvent(ge: SVGGElement, i: number, p: Point): void {
        const show = (x: number, y: number) => this.tooltipService.show({ coordinates: [x, y], isTouchEvent: false, dataItems: this.tipFor(p), identities: [this.idOf(p.row)] });
        ge.addEventListener("mousemove", (e: MouseEvent) => { e.stopPropagation(); show(e.clientX, e.clientY); });
        ge.addEventListener("mouseleave", () => this.tooltipService.hide({ isTouchEvent: false, immediately: false }));
        ge.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            if (this.host.allowInteractions === false) return;
            this.selectionManager.select(this.idOf(p.row), multiKey(e)).then(() => this.applySelection());
        });
        ge.addEventListener("focus", () => {
            const mk = ge.querySelector(".at-marker, .at-pin") as Element | null;
            const r = (mk ?? ge).getBoundingClientRect();
            show(r.left + r.width / 2, r.top + r.height / 2);
        });
        ge.addEventListener("blur", () => this.tooltipService.hide({ isTouchEvent: false, immediately: true }));
        ge.addEventListener("keydown", (e: KeyboardEvent) => {
            const k = this.eventNodes.indexOf(ge);
            if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); this.eventNodes[Math.min(this.eventNodes.length - 1, k + 1)]?.focus(); }
            else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); this.eventNodes[Math.max(0, k - 1)]?.focus(); }
            else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault(); e.stopPropagation();
                if (this.host.allowInteractions === false) return;
                this.selectionManager.select(this.idOf(p.row), multiKey(e)).then(() => this.applySelection());
            }
        });
    }

    /** The selected ids: the ones the host just handed over (a bookmark restore), else the selection manager's. */
    private selectedIds(restored?: ISelectionId[]): ISelectionId[] {
        return ((restored ?? this.selectionManager.getSelectionIds()) || []) as ISelectionId[];
    }

    /** Whether a row's reading is selected: one selected id EQUALS its id. Desktop report 2026-11-23 (certified bug):
     *  a bookmark restore hands back ids rebuilt from the saved selectors, equal to the points' own ids but with a
     *  different getKey() text, so matching by key dimmed every note and drew no ring. */
    private rowHeld(sel: ISelectionId[], row: number): boolean {
        const id = this.idOf(row);
        return !!id && sel.some(s => !!s && id.equals(s));
    }

    /** The plot option's aria-selected: true only when the reading it names (data-row) is selected. */
    private markOverlaySelected(sel: ISelectionId[] = this.selectedIds()): void {
        const ov = this.svg ? this.svg.querySelector(".at-overlay") : null;
        if (!ov) return;
        const ovRow = ov.getAttribute("data-row");
        ov.setAttribute("aria-selected", sel.length > 0 && ovRow !== null && this.rowHeld(sel, Number(ovRow)) ? "true" : "false");
    }

    private applySelection(restored?: ISelectionId[]): void {
        if (!this.svg || !this.geom || !this.parsed) return;
        const sel = this.selectedIds(restored);
        const held = (row: number) => this.rowHeld(sel, row);
        const any = sel.length > 0;
        for (const ge of this.eventNodes) {
            const row = Number(ge.getAttribute("data-row"));
            const on = any && held(row);
            ge.setAttribute("aria-selected", on ? "true" : "false");
            ge.classList.toggle("at-dim", any && !on);
        }
        this.svg.classList.toggle("at-has-selection", any);
        // Fix round 11 (A7): columns dim with the notes while a selection exists (Power BI's column
        // chart); the selected ones are redrawn at full strength in the selection layer below.
        this.svg.querySelectorAll(".at-columns").forEach(el => el.classList.toggle("at-dim", any));
        this.svg.querySelectorAll(".at-column-event[data-row], .at-column-progress[data-row]").forEach(el => {
            el.classList.toggle("at-dim", any && !held(Number(el.getAttribute("data-row"))));
        });
        // Fix round 7 (M2): the plot's keyboard option reports whether its current point is selected.
        this.markOverlaySelected(sel);
        const layer = this.selectionLayer;
        if (!layer) return;
        while (layer.firstChild) layer.removeChild(layer.firstChild);
        if (!any) return;
        const g = this.geom;
        const { c } = this.resolveColours();
        this.parsed.points.forEach((p, i) => {
            if (!held(p.row)) return;
            const y = g.ys[i] ?? g.zeroY;
            const plain = g.mark === "columns" && g.ys[i] !== null && !this.svg?.querySelector(`.at-column-event[data-row="${p.row}"], .at-column-progress[data-row="${p.row}"]`);
            if (plain) {
                const bw = columnWidth(g.band), top = g.ys[i] as number;
                svgEl("rect", layer, { class: "at-selected-column", "data-row": p.row, x: f2(g.xs[i] - bw / 2), y: f2(Math.min(top, g.zeroY)),
                    width: f2(bw), height: f2(Math.max(0.5, Math.abs(g.zeroY - top))), fill: c.columns, "fill-opacity": c.hc ? 1 : 0.6 });
            }
            svgEl("circle", layer, { class: "at-selected-ring", "data-row": p.row, cx: f2(g.xs[i]), cy: f2(y), r: 6, fill: "none", stroke: c.hc ? c.hcFg : c.text, "stroke-width": c.hc ? 2 : 1.5 });
        });
    }
}

export type { El };
