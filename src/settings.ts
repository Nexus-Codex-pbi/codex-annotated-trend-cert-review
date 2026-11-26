"use strict";

import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import { dataViewWildcard } from "powerbi-visuals-utils-dataviewutils";

import { TitleSettings } from "./shared/titleSettings";
import { BackgroundSettings } from "./shared/backgroundSettings";
import { CodexThemeSettings } from "./shared/codexThemeSettings";
import { LicenceSettings } from "./shared/licenceSettings";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

export type NoteStyle = "leader" | "callout" | "pins";
export type Mark = "line" | "area" | "columns";

// Pane colour defaults. A slice still holding its default takes the theme token at render time
// (light/dark/forced Codex modes); an author's explicit colour is kept (see visual.ts colours()).
export const DEFAULTS = {
    eventColor: "#a85f00",   // the light warning token: notes are neutral attention (card #1144 page)
    noteColor: "#5b5b74",    // the light muted token
    lineColor: "#0384a3",    // the light accent token
    axisColor: "#5b5b74",
    noteFontSize: 11,
    axisFontSize: 10.5,
    lineWidth: 1.5,
    labelDensity: 100,
};

export const STYLE_ITEMS = [
    { value: "leader", displayName: "Leader-line labels", key: "Style_Leader" },
    { value: "callout", displayName: "Callout cards", key: "Style_Callout" },
    { value: "pins", displayName: "Numbered pins", key: "Style_Pins" },
];
export const KEEP_ITEMS = [
    { value: "latest", displayName: "Latest first", key: "Keep_Latest" },
    { value: "earliest", displayName: "Earliest first", key: "Keep_Earliest" },
    { value: "largest", displayName: "Largest value first", key: "Keep_Largest" },
];
export const MARK_ITEMS = [
    { value: "auto", displayName: "Auto (area with labels and cards, columns with pins)", key: "Mark_Auto" },
    { value: "line", displayName: "Line", key: "Mark_Line" },
    { value: "area", displayName: "Line and area", key: "Mark_Area" },
    { value: "columns", displayName: "Columns", key: "Mark_Columns" },
];
export const ZERO_ITEMS = [
    { value: "auto", displayName: "Auto (on for area and columns, off for a line)", key: "Zero_Auto" },
    { value: "on", displayName: "On", key: "Zero_On" },
    { value: "off", displayName: "Off", key: "Zero_Off" },
];
export const PROGRESS_ITEMS = [
    { value: "auto", displayName: "Auto (when the last period contains today)", key: "Progress_Auto" },
    { value: "on", displayName: "On", key: "Progress_On" },
    { value: "off", displayName: "Off", key: "Progress_Off" },
];
const items = (list: { value: string; displayName: string }[]) => list.map(i => ({ value: i.value, displayName: i.displayName }));

const ConstantOrRule = powerbi.VisualEnumerationInstanceKinds.ConstantOrRule;
const num = (min: number, max: number): { minValue: { type: powerbi.visuals.ValidatorType.Min; value: number }; maxValue: { type: powerbi.visuals.ValidatorType.Max; value: number } } => ({
    minValue: { type: powerbi.visuals.ValidatorType.Min, value: min },
    maxValue: { type: powerbi.visuals.ValidatorType.Max, value: max },
});

export class AnnotationSettings extends FormattingSettingsCard {
    name = "annotations"; displayName = "Event notes"; displayNameKey = "Annotations_Card";

    style = new formattingSettings.ItemDropdown({
        name: "style", displayName: "Note style", displayNameKey: "Annotations_Style",
        items: items(STYLE_ITEMS), value: items(STYLE_ITEMS)[0],
    });
    // Per-event colour: a fx rule (e.g. on an Event type measure) resolves per axis row and lands in
    // categories[0].objects[row]; the constant persists card-level (formatting-model.md §2, per datapoint).
    eventColor = new formattingSettings.ColorPicker({
        name: "eventColor", displayName: "Marker colour", displayNameKey: "Annotations_EventColor",
        value: { value: DEFAULTS.eventColor }, instanceKind: ConstantOrRule,
        selector: dataViewWildcard.createDataViewWildcardSelector(dataViewWildcard.DataViewWildcardMatchingOption.InstancesAndTotals),
        altConstantSelector: undefined,
    });
    noteFontFamily = new formattingSettings.FontPicker({ name: "noteFontFamily", displayName: "Font family", displayNameKey: "Annotations_FontFamily", value: "Segoe UI, sans-serif" });
    noteFontSize = new formattingSettings.NumUpDown({ name: "noteFontSize", displayName: "Font size", displayNameKey: "Annotations_FontSize", value: DEFAULTS.noteFontSize, options: num(8, 24) });
    noteBold = new formattingSettings.ToggleSwitch({ name: "noteBold", displayName: "Bold", displayNameKey: "Annotations_Bold", value: false });
    noteItalic = new formattingSettings.ToggleSwitch({ name: "noteItalic", displayName: "Italic", displayNameKey: "Annotations_Italic", value: false });
    noteFont = new formattingSettings.FontControl({
        name: "noteFont", displayName: "Note font", displayNameKey: "Annotations_Font",
        fontFamily: this.noteFontFamily, fontSize: this.noteFontSize, bold: this.noteBold, italic: this.noteItalic,
    });
    noteColor = new formattingSettings.ColorPicker({
        name: "noteColor", displayName: "Note text colour", displayNameKey: "Annotations_NoteColor",
        value: { value: DEFAULTS.noteColor }, instanceKind: ConstantOrRule,
    });
    showDate = new formattingSettings.ToggleSwitch({ name: "showDate", displayName: "Show date in note", displayNameKey: "Annotations_ShowDate", value: true });
    keep = new formattingSettings.ItemDropdown({
        name: "keep", displayName: "When notes don't fit, keep", displayNameKey: "Annotations_Keep",
        items: items(KEEP_ITEMS), value: items(KEEP_ITEMS)[0],
    });
    maxNotes = new formattingSettings.NumUpDown({
        name: "maxNotes", displayName: "Maximum notes (0 = as many as fit)", displayNameKey: "Annotations_MaxNotes",
        value: 0, options: num(0, 50),
    });
    // Round 4 item 1: the native line / column chart "Label density" pattern. The visual places as
    // many of the notes it tries as fit without overlapping or crossing anything; this percentage
    // sets how many it tries (labelDensityAttempts in layout.ts). Default 100: every note is tried,
    // which is what every earlier build did, so a chart looks as it did before the setting existed.
    labelDensity = new formattingSettings.Slider({
        name: "labelDensity", displayName: "Label density", displayNameKey: "Annotations_LabelDensity",
        description: "How many notes to try to place, as a percentage. 100 places every note that fits without overlapping anything; 0 places only the most important note. Notes left out are counted in \"+N more notes\".",
        descriptionKey: "Annotations_LabelDensity_Description",
        value: DEFAULTS.labelDensity, options: { ...num(0, 100), unitSymbol: "%" },
    });

    slices: FormattingSettingsSlice[] = [this.style, this.eventColor, this.noteFont, this.noteColor, this.showDate, this.keep, this.maxNotes, this.labelDensity];
}

export class SeriesSettings extends FormattingSettingsCard {
    name = "series"; displayName = "Series"; displayNameKey = "Series_Card";
    // Whole-visual colour: NO selector (formatting-model.md §2, card-level).
    lineColor = new formattingSettings.ColorPicker({
        name: "lineColor", displayName: "Series colour", displayNameKey: "Series_LineColor",
        value: { value: DEFAULTS.lineColor }, instanceKind: ConstantOrRule,
    });
    lineWidth = new formattingSettings.NumUpDown({ name: "lineWidth", displayName: "Line width", displayNameKey: "Series_LineWidth", value: DEFAULTS.lineWidth, options: num(0.5, 6) });
    mark = new formattingSettings.ItemDropdown({
        name: "mark", displayName: "Mark", displayNameKey: "Series_Mark",
        items: items(MARK_ITEMS), value: items(MARK_ITEMS)[0],
    });
    lastInProgress = new formattingSettings.ItemDropdown({
        name: "lastInProgress", displayName: "Last point is in progress", displayNameKey: "Series_LastInProgress",
        items: items(PROGRESS_ITEMS), value: items(PROGRESS_ITEMS)[0],
    });
    startAtZero = new formattingSettings.ItemDropdown({
        name: "startAtZero", displayName: "Start at zero", displayNameKey: "Series_StartAtZero",
        items: items(ZERO_ITEMS), value: items(ZERO_ITEMS)[0],
    });
    slices: FormattingSettingsSlice[] = [this.mark, this.startAtZero, this.lineColor, this.lineWidth, this.lastInProgress];
}

export class AxesSettings extends FormattingSettingsCard {
    // Desktop fix round 1 (owner report 2026-11-22; coordinator ruling, owner veto open): the value
    // axis is on by default, so a new chart has a scale. A saved "off" is read as saved and stays off.
    name = "axes"; displayName = "Axes"; displayNameKey = "Axes_Card";
    showX = new formattingSettings.ToggleSwitch({ name: "showX", displayName: "Date labels", displayNameKey: "Axes_ShowX", value: true });
    showY = new formattingSettings.ToggleSwitch({ name: "showY", displayName: "Value axis", displayNameKey: "Axes_ShowY", value: true });
    axisFontSize = new formattingSettings.NumUpDown({ name: "axisFontSize", displayName: "Font size", displayNameKey: "Axes_FontSize", value: DEFAULTS.axisFontSize, options: num(8, 20) });
    axisColor = new formattingSettings.ColorPicker({
        name: "axisColor", displayName: "Label colour", displayNameKey: "Axes_Color",
        value: { value: DEFAULTS.axisColor }, instanceKind: ConstantOrRule,
    });
    slices: FormattingSettingsSlice[] = [this.showX, this.showY, this.axisFontSize, this.axisColor];
}

export const PADDING_DEFAULTS = { top: 12, right: 14, bottom: 10, left: 14 };
export const PADDING_MAX = 64;

export class ContentPaddingSettings extends FormattingSettingsCard {
    name = "contentPadding"; displayName = "Content padding"; displayNameKey = "ContentPadding_Card";
    top = new formattingSettings.NumUpDown({ name: "top", displayName: "Top", displayNameKey: "ContentPadding_Top", value: PADDING_DEFAULTS.top, options: num(0, PADDING_MAX) });
    right = new formattingSettings.NumUpDown({ name: "right", displayName: "Right", displayNameKey: "ContentPadding_Right", value: PADDING_DEFAULTS.right, options: num(0, PADDING_MAX) });
    bottom = new formattingSettings.NumUpDown({ name: "bottom", displayName: "Bottom", displayNameKey: "ContentPadding_Bottom", value: PADDING_DEFAULTS.bottom, options: num(0, PADDING_MAX) });
    left = new formattingSettings.NumUpDown({ name: "left", displayName: "Left", displayNameKey: "ContentPadding_Left", value: PADDING_DEFAULTS.left, options: num(0, PADDING_MAX) });
    slices: FormattingSettingsSlice[] = [this.top, this.right, this.bottom, this.left];
}

/** Shared Background card plus a top-level Show toggle (the KPI Sparkline pattern, extended here
 *  so src/shared stays untouched). Off: no fill, whatever Colour/Transparency say. */
export class TrendBackgroundSettings extends BackgroundSettings {
    show = new formattingSettings.ToggleSwitch({ name: "show", displayName: "Show background", displayNameKey: "Background_Show", value: true });
    topLevelSlice = this.show;
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    annotations = new AnnotationSettings();
    series = new SeriesSettings();
    axes = new AxesSettings();
    // Fix round 11 (A6, owner 2026-11-21): the certified Codex Theme card as shipped (mode,
    // surfaceTransparency, neon, neonColor, neonScope, glowStrength); Keep report colours is gone.
    codexTheme = new CodexThemeSettings();
    background = new TrendBackgroundSettings();
    titleSettings = new TitleSettings();
    contentPadding = new ContentPaddingSettings();
    licence = new LicenceSettings();

    cards = [this.annotations, this.series, this.axes, this.codexTheme, this.background, this.titleSettings, this.contentPadding, this.licence];

    /** A saved enum value outside today's items resolves to undefined in populate: fall back to the
     *  default instead of crashing every later `.value.value` read (building.md §6). */
    resetUnknownEnums(): void {
        if (!this.annotations.style.value) this.annotations.style.value = this.annotations.style.items[0];
        if (!this.annotations.keep.value) this.annotations.keep.value = this.annotations.keep.items[0];
        if (!this.series.mark.value) this.series.mark.value = this.series.mark.items[0];
        if (!this.series.startAtZero.value) this.series.startAtZero.value = this.series.startAtZero.items[0];
        if (!this.series.lastInProgress.value) this.series.lastInProgress.value = this.series.lastInProgress.items[0];
        if (!this.codexTheme.mode.value) this.codexTheme.mode.value = this.codexTheme.mode.items[0];
        if (!this.codexTheme.neonScope.value) this.codexTheme.neonScope.value = this.codexTheme.neonScope.items[0];
    }

    /** Mark as drawn: Auto is area for leader labels and callout cards, columns for numbered pins. */
    mark(style: NoteStyle): Mark {
        const v = String(this.series.mark.value?.value ?? "auto");
        if (v === "line" || v === "area" || v === "columns") return v;
        return style === "pins" ? "columns" : "area";
    }

    /** F7: the value axis includes zero. Auto: on for area and columns (their fill is read against
     *  zero), off for a bare line (its shape is the point). */
    startAtZero(mark: Mark): boolean {
        const v = String(this.series.startAtZero.value?.value ?? "auto");
        if (v === "on") return true;
        if (v === "off") return false;
        return mark !== "line";
    }

    noteStyle(): NoteStyle {
        const v = String(this.annotations.style.value?.value ?? "leader");
        return (v === "callout" || v === "pins") ? v : "leader";
    }
}
