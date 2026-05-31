import {
  BACKGROUND_LYRIC_CLASS,
  EXPLICIT_WORD_CLASS,
  LOG_PREFIX,
  LYRICS_CLASS,
  LYRICS_FOUND_LOG,
  LYRICS_TAB_NOT_DISABLED_LOG,
  LYRICS_WRAPPER_ID,
  NO_LYRICS_FOUND_LOG,
  NO_LYRICS_TEXT_SELECTOR,
  ROMANIZATION_LANGUAGES,
  ROMANIZED_LYRICS_CLASS,
  RTL_CLASS,
  SYNC_DISABLED_LOG,
  TAB_HEADER_CLASS,
  TRANSLATED_LYRICS_CLASS,
  TRANSLATION_ENABLED_LOG,
  WORD_CLASS,
  ZERO_DURATION_ANIMATION_CLASS,
} from "@constants";
import { AppState } from "@core/appState";
import { t } from "@core/i18n";
import { createInstrumentalElement } from "@modules/lyrics/createInstrumentalElement";
import { containsNonLatin, detectNonLatinLanguage, testRtl } from "@modules/lyrics/lyricParseUtils";
import { applySegmentMapToLyrics, type LyricSourceResultWithMeta } from "@modules/lyrics/lyrics";
import type { Lyric, LyricPart } from "@modules/lyrics/providers/shared";
import type { UnisonData } from "@modules/lyrics/providers/unison";
import {
  getRomanizationFromCache,
  getTranslationFromCache,
  romanizeBatch,
  translateBatch,
} from "@modules/lyrics/translation";
import { registerThemeSetting } from "@modules/settings/themeOptions";
import { animEngineState, lyricsElementAdded } from "@modules/ui/animationEngine";
import { resizeCanvas } from "@modules/ui/animationEngineDebug";
import {
  addFooter,
  addNoLyricsButton,
  cleanup,
  createLyricsWrapper,
  flushLoader,
  renderLoader,
  setExtraHeight,
} from "@modules/ui/dom";
import { getRelativeBounds, languageMatchesAny, log } from "@utils";

let disableRichsync = registerThemeSetting("blyrics-disable-richsync", false, true);
let lineSyncedAnimationDelay = registerThemeSetting("blyrics-line-synced-animation-delay", 50, true);
let longWordThreshold = registerThemeSetting("blyrics-long-word-threshold", 1500, true);
let longWordWrapThreshold = registerThemeSetting("blyrics-long-word-wrap-threshold", 10, true);

const LINE_MAIN_CLASS = "blyrics-line-main";
const BACKGROUND_LINE_CLASS = "blyrics-background-line";
const LINE_SYNCED_WORD_CLASS = "blyrics-line-synced-word";
const WORD_HIGHLIGHT_CLASS = "blyrics-word-highlight";
const WORD_GROUP_CLASS = "blyrics-word-group";
const LONG_WORD_GROUP_CLASS = "blyrics-word-group-long";
const CONTENT_LINE_CLASS = "blyrics-content-line";
const RTL_SCRIPT_REGEX = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u;
const LTR_SCRIPT_REGEX =
  /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const SPACE_REGEX = /^\s+$/u;

function isRomanizationDisabledForLang(lang: string): boolean {
  return languageMatchesAny(lang, AppState.romanizationDisabledLanguages);
}

function isTranslationDisabledForLang(lang: string): boolean {
  return languageMatchesAny(lang, AppState.translationDisabledLanguages);
}

function findNearestAgent(lyrics: Lyric[], fromIndex: number): string | undefined {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (!lyrics[i].isInstrumental && lyrics[i].agent) {
      return lyrics[i].agent;
    }
  }
  for (let i = fromIndex + 1; i < lyrics.length; i++) {
    if (!lyrics[i].isInstrumental && lyrics[i].agent) {
      return lyrics[i].agent;
    }
  }
  return undefined;
}

function isNearestLyricRtl(lyrics: Lyric[], fromIndex: number): boolean {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (!lyrics[i].isInstrumental && lyrics[i].words?.trim()) {
      return testRtl(lyrics[i].words);
    }
  }
  for (let i = fromIndex + 1; i < lyrics.length; i++) {
    if (!lyrics[i].isInstrumental && lyrics[i].words?.trim()) {
      return testRtl(lyrics[i].words);
    }
  }
  return false;
}

let resizeObserver: ResizeObserver | null = null;

function getResizeObserver(): ResizeObserver {
  if (!resizeObserver) {
    resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target.id === LYRICS_WRAPPER_ID) {
          if (
            AppState.lyricData &&
            (entry.target.clientWidth !== AppState.lyricData.lyricWidth ||
              entry.target.clientHeight !== AppState.lyricData.lyricHeight)
          ) {
            animEngineState.doneFirstInstantScroll = false;
            animEngineState.nextScrollAllowedTime = 0;
            calculateLyricPositions();
          }
        }
      }
    });
  }
  return resizeObserver;
}

export function disconnectResizeObserver(): void {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
}

export interface PartData {
  /**
   * Time of this part in seconds
   */
  time: number;

  /**
   * Duration of this part in seconds
   */
  duration: number;
  lyricElement: HTMLElement;
  animationStartTimeMs: number;
  animations: Animation[];
}

export type LineData = {
  parts: PartData[];
  isScrolled: boolean;
  isAnimationPlayStatePlaying: boolean;
  accumulatedOffsetMs: number;
  isAnimating: boolean;
  lastAnimSetupAt: number;
  isSelected: boolean;
  height: number;
  position: number;
} & PartData;

export type SyncType = "richsync" | "synced" | "none";

export interface LyricsData {
  lines: LineData[];
  syncType: SyncType;
  lyricWidth: number;
  lyricHeight: number;
  isMusicVideoSynced: boolean;
  tabSelector: HTMLElement;
  lyricsContainer: HTMLElement;
}

interface RenderToken {
  kind: "space" | "part";
  text: string;
  part?: LyricPart;
}

interface WordGroup {
  text: string;
  isBackground: boolean;
  tokens: RenderToken[];
}

/**
 * Processes lyrics data and prepares it for rendering.
 * Sets language settings, validates data, and initiates DOM injection.
 *
 * @param data - Processed lyrics data
 * @param keepLoaderVisible
 * @param signal - AbortSignal to cancel async operations
 * @param data.language - Language code for the lyrics
 * @param data.lyrics - Array of lyric lines
 */
export function processLyrics(data: LyricSourceResultWithMeta, keepLoaderVisible = false, signal?: AbortSignal): void {
  const lyrics = data.lyrics;
  if (!lyrics || lyrics.length === 0) {
    throw new Error(NO_LYRICS_FOUND_LOG);
  }

  log(LYRICS_FOUND_LOG);

  const ytMusicLyrics = document.querySelector(NO_LYRICS_TEXT_SELECTOR)?.parentElement;
  if (ytMusicLyrics) {
    ytMusicLyrics.classList.add("blyrics-hidden");
  }

  try {
    const lyricsElement = document.getElementsByClassName(LYRICS_CLASS)[0] as HTMLElement;
    lyricsElement.replaceChildren();
  } catch (_err) {
    log(LYRICS_TAB_NOT_DISABLED_LOG);
  }

  injectLyrics(data, keepLoaderVisible, signal);
}

function newPartData(part: LyricPart, span: HTMLElement): PartData {
  return {
    time: part.startTimeMs / 1000,
    duration: part.durationMs / 1000,
    lyricElement: span,
    animationStartTimeMs: Infinity,
    animations: [],
  };
}

function newLineData(lyricElement: HTMLElement, startTimeMs: number, durationMs: number): LineData {
  return {
    lyricElement,
    time: startTimeMs / 1000,
    duration: durationMs / 1000,
    parts: [],
    isScrolled: false,
    animationStartTimeMs: Infinity,
    isAnimationPlayStatePlaying: false,
    accumulatedOffsetMs: 0,
    isAnimating: false,
    lastAnimSetupAt: 0,
    isSelected: false,
    height: -1,
    position: -1,
    animations: [],
  };
}

function detectDirection(text: string): "rtl" | "ltr" | "auto" {
  for (const char of text) {
    if (RTL_SCRIPT_REGEX.test(char)) return "rtl";
    if (LTR_SCRIPT_REGEX.test(char)) return "ltr";
  }
  return "auto";
}

function applyDirection(element: HTMLElement, text: string): void {
  const direction = detectDirection(text);
  element.dir = "auto";
  if (direction === "rtl") {
    element.classList.add(RTL_CLASS);
    element.dataset.direction = "rtl";
  } else if (direction === "ltr") {
    element.dataset.direction = "ltr";
  }
}

function splitPartIntoTokens(part: LyricPart): RenderToken[] {
  const tokens: RenderToken[] = [];
  const chunks = part.words.match(/\s+|\S+/gu) ?? [];

  if (chunks.length === 0) return tokens;

  let cursor = 0;
  for (const chunk of chunks) {
    if (SPACE_REGEX.test(chunk)) {
      tokens.push({ kind: "space", text: chunk });
      cursor += chunk.length;
      continue;
    }

    const startTimeMs = part.startTimeMs + Math.round((part.durationMs * cursor) / part.words.length);
    const endTimeMs = part.startTimeMs + Math.round((part.durationMs * (cursor + chunk.length)) / part.words.length);
    tokens.push({
      kind: "part",
      text: chunk,
      part: {
        startTimeMs,
        durationMs: endTimeMs - startTimeMs,
        words: chunk,
        isBackground: part.isBackground,
        explicit: part.explicit,
      },
    });
    cursor += chunk.length;
  }

  return tokens;
}

function normalizeParts(parts: LyricPart[]): RenderToken[] {
  return parts.flatMap(splitPartIntoTokens);
}

function groupTokensByWord(tokens: RenderToken[]): (WordGroup | RenderToken)[] {
  const groups: (WordGroup | RenderToken)[] = [];
  let current: WordGroup | null = null;

  const flush = () => {
    if (current && current.tokens.length > 0) {
      groups.push(current);
    }
    current = null;
  };

  for (const token of tokens) {
    if (token.kind === "space") {
      flush();
      groups.push(token);
      continue;
    }

    const isBackground = token.part?.isBackground === true;
    if (!current || current.isBackground !== isBackground) {
      flush();
      current = { text: "", isBackground, tokens: [] };
    }

    current.text += token.text;
    current.tokens.push(token);
  }

  flush();
  return groups;
}

function appendLongWordBreaks(span: HTMLElement, text: string, threshold: number): boolean {
  if (text.length <= threshold) {
    span.textContent = text;
    return false;
  }

  for (let i = 0; i < text.length; i += threshold) {
    span.appendChild(document.createTextNode(text.slice(i, i + threshold)));
    if (i + threshold < text.length) {
      span.appendChild(document.createElement("wbr"));
    }
  }
  return true;
}

function cloneTextWithBreaks(source: HTMLElement): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const node of source.childNodes) {
    fragment.appendChild(node.cloneNode(true));
  }
  return fragment;
}

function createTimedWordSpan(part: LyricPart, wrapThreshold: number): HTMLSpanElement {
  const span = document.createElement("span");
  span.classList.add(WORD_CLASS);
  span.dir = "auto";

  if (part.durationMs === 0) {
    span.classList.add(ZERO_DURATION_ANIMATION_CLASS);
    span.classList.add(LINE_SYNCED_WORD_CLASS);
  }
  if (testRtl(part.words)) {
    span.classList.add(RTL_CLASS);
  }
  if (part.durationMs > longWordThreshold.getNumberValue()) {
    span.dataset.longWord = "true";
  }
  if (part.isBackground) {
    span.classList.add(BACKGROUND_LYRIC_CLASS);
  }
  if (part.explicit) {
    span.classList.add(EXPLICIT_WORD_CLASS);
  }

  const hasBreaks = appendLongWordBreaks(span, part.words, wrapThreshold);
  if (hasBreaks) {
    const highlight = document.createElement("span");
    highlight.classList.add(WORD_HIGHLIGHT_CLASS);
    highlight.setAttribute("aria-hidden", "true");
    highlight.appendChild(cloneTextWithBreaks(span));
    span.appendChild(highlight);
  }
  span.dataset.time = String(part.startTimeMs / 1000);
  span.dataset.duration = String(part.durationMs / 1000);
  span.dataset.content = part.words;
  span.style.setProperty("--blyrics-duration", part.durationMs + "ms");
  return span;
}

function createWordGroup(group: WordGroup, lineData: LineData): HTMLElement {
  const wrapThreshold = Math.max(1, longWordWrapThreshold.getNumberValue());
  const groupElement = document.createElement("span");
  groupElement.classList.add(WORD_GROUP_CLASS);
  groupElement.dir = "auto";
  groupElement.dataset.content = group.text;

  if (group.text.length > wrapThreshold * 2) {
    groupElement.classList.add(LONG_WORD_GROUP_CLASS);
  }

  if (group.isBackground) {
    groupElement.classList.add(BACKGROUND_LYRIC_CLASS);
  }

  for (const token of group.tokens) {
    if (!token.part) continue;

    const span = createTimedWordSpan(token.part, wrapThreshold);
    lineData.parts.push(newPartData(token.part, span));
    groupElement.appendChild(span);
  }

  return groupElement;
}

function createLineMain(text: string): HTMLDivElement {
  const main = document.createElement("div");
  main.classList.add(LINE_MAIN_CLASS);
  main.dir = "auto";
  applyDirection(main, text);
  return main;
}

function createLyricsLine(
  parts: LyricPart[],
  line: LineData,
  lyricElement: HTMLElement,
  options: { splitBackgroundLine: boolean } = { splitBackgroundLine: true }
): HTMLElement {
  const main = createLineMain(parts.map(part => part.words).join(""));
  const groupedTokens = groupTokensByWord(normalizeParts(parts));
  const backgroundLine = document.createElement("div");
  backgroundLine.classList.add(BACKGROUND_LINE_CLASS);
  backgroundLine.dir = "auto";
  let hasBackground = false;
  let pendingForegroundSpace = "";
  let pendingBackgroundSpace = "";

  for (const item of groupedTokens) {
    if ("kind" in item) {
      pendingForegroundSpace += item.text;
      pendingBackgroundSpace += item.text;
    } else {
      const shouldUseBackgroundLine = options.splitBackgroundLine && item.isBackground;
      const target = shouldUseBackgroundLine ? backgroundLine : main;
      const pendingSpace = shouldUseBackgroundLine ? pendingBackgroundSpace : pendingForegroundSpace;
      if (target.childNodes.length > 0 && pendingSpace.length > 0) {
        target.appendChild(document.createTextNode(pendingSpace));
      }
      target.appendChild(createWordGroup(item, line));
      if (shouldUseBackgroundLine) {
        hasBackground = true;
        pendingBackgroundSpace = "";
      } else {
        pendingForegroundSpace = "";
      }
    }
  }

  lyricElement.appendChild(main);
  if (hasBackground) {
    lyricElement.appendChild(backgroundLine);
  }
  return main;
}

function buildLineSyncedParts(item: Lyric): LyricPart[] {
  const parts: LyricPart[] = [];
  const tokens = item.words.match(/\s+|\S+/gu) ?? [];
  let wordIndex = 0;

  for (const token of tokens) {
    const isSpace = SPACE_REGEX.test(token);
    const startTimeMs = item.startTimeMs + wordIndex * lineSyncedAnimationDelay.getNumberValue();
    parts.push({
      startTimeMs,
      words: token,
      durationMs: 0,
    });

    if (!isSpace) {
      wordIndex += 1;
    }
  }

  return parts;
}

function getSeekTimeFromClick(event: MouseEvent, lyricElement: HTMLElement): number | null {
  const target = event.target as HTMLElement;
  const container = lyricElement.closest(`.${LYRICS_CLASS}`) as HTMLElement | null;
  const isRichsync = container?.dataset.sync === "richsync";

  if (!isRichsync || !event.altKey) {
    return parseFloat(lyricElement.dataset.time || "0");
  }

  let wordElement = target.closest(`.${WORD_CLASS}`) as HTMLElement | null;

  if (!wordElement) {
    const words = lyricElement.querySelectorAll(`.${WORD_CLASS}`);
    let closestDist = Infinity;
    words.forEach(word => {
      const rect = word.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dist = Math.hypot(event.clientX - centerX, event.clientY - centerY);
      if (dist < closestDist) {
        closestDist = dist;
        wordElement = word as HTMLElement;
      }
    });
  }

  if (!wordElement) return null;
  return parseFloat(wordElement.dataset.time || "0");
}

function addSeekHandler(lyricElement: HTMLElement, allZero: boolean): void {
  if (allZero) {
    lyricElement.style.cursor = "unset";
    return;
  }

  lyricElement.addEventListener("click", event => {
    const seekTime = getSeekTimeFromClick(event, lyricElement);
    if (seekTime === null) return;

    log(LOG_PREFIX, `Seeking to ${seekTime.toFixed(2)}s`);
    document.dispatchEvent(new CustomEvent("blyrics-seek-to", { detail: seekTime }));
    animEngineState.scrollResumeTime = 0;
  });
}

/**
 * Injects lyrics into the DOM with timing, click handlers, and animations.
 * Creates the complete lyrics interface including synchronization support.
 *
 * @param data - Complete lyrics data object
 * @param keepLoaderVisible
 * @param signal - AbortSignal to cancel async operations
 * @param data.lyrics - Array of lyric lines with timing
 * @param [data.source] - Source attribution for lyrics
 * @param [data.sourceHref] - URL for source link
 */
function injectLyrics(data: LyricSourceResultWithMeta, keepLoaderVisible = false, signal?: AbortSignal): void {
  const injectionId = AppState.currentInjectionId;
  const isStale = () => AppState.currentInjectionId !== injectionId;

  const lyrics = data.lyrics!;
  cleanup();

  let lyricsWrapper = createLyricsWrapper();

  lyricsWrapper.replaceChildren();
  const lyricsContainer = document.createElement("div");
  lyricsContainer.className = LYRICS_CLASS;
  lyricsWrapper.appendChild(lyricsContainer);

  lyricsWrapper.removeAttribute("is-empty");

  if (AppState.isTranslateEnabled) {
    log(TRANSLATION_ENABLED_LOG, AppState.translationLanguage);
  }

  const allZero = lyrics.every(item => item.startTimeMs === 0);

  if (keepLoaderVisible) {
    renderLoader(true);
  } else {
    flushLoader(allZero && lyrics[0].words !== t("lyrics_notFound"));
  }

  let lines: LineData[] = [];
  let syncType: SyncType = allZero ? "none" : "synced";

  for (const [lineIndex, lyricItem] of lyrics.entries()) {
    if (lyricItem.isInstrumental) {
      const instrumentalElement = createInstrumentalElement(lyricItem.durationMs, lineIndex);
      instrumentalElement.classList.add("blyrics--line");
      instrumentalElement.dataset.time = String(lyricItem.startTimeMs / 1000);
      instrumentalElement.dataset.duration = String(lyricItem.durationMs / 1000);
      instrumentalElement.dataset.lineNumber = String(lineIndex);
      instrumentalElement.dataset.instrumental = "true";
      instrumentalElement.dir = "auto";

      const agent = findNearestAgent(lyrics, lineIndex);
      if (agent) {
        instrumentalElement.dataset.agent = agent;
      }

      if (isNearestLyricRtl(lyrics, lineIndex)) {
        instrumentalElement.classList.add(RTL_CLASS);
        instrumentalElement.dataset.direction = "rtl";
      }

      addSeekHandler(instrumentalElement, allZero);

      lines.push(newLineData(instrumentalElement, lyricItem.startTimeMs, lyricItem.durationMs));
      lyricsContainer.appendChild(instrumentalElement);
      continue;
    }

    const item = lyricItem as Required<Pick<Lyric, "parts">> & Lyric;
    if (!item.parts || item.parts.length === 0 || disableRichsync.getBooleanValue()) {
      item.parts = buildLineSyncedParts(item);
    }

    if (!item.parts.every(part => part.durationMs === 0)) {
      syncType = "richsync";
    }

    let lyricElement = document.createElement("div");
    lyricElement.classList.add("blyrics--line");
    lyricElement.dir = "auto";
    applyDirection(lyricElement, item.words);

    const line = newLineData(lyricElement, item.startTimeMs, item.durationMs);
    createLyricsLine(item.parts, line, lyricElement);

    lyricElement.dataset.time = String(line.time);
    lyricElement.dataset.duration = String(line.duration);
    lyricElement.dataset.lineNumber = String(lineIndex);
    lyricElement.style.setProperty("--blyrics-duration", item.durationMs + "ms");
    if (item.agent) {
      lyricElement.dataset.agent = item.agent;
    }

    addSeekHandler(lyricElement, allZero);

    lines.push(line);
    lyricsContainer.appendChild(lyricElement);
  }

  animEngineState.skipScrolls = 2;
  animEngineState.skipScrollsDecayTimes = [];
  for (let i = 0; i < animEngineState.skipScrolls; i++) {
    animEngineState.skipScrollsDecayTimes.push(Date.now() + 2000);
  }
  animEngineState.scrollResumeTime = 0;

  if (lyrics[0].words !== t("lyrics_notFound")) {
    const unisonData =
      data.source === "Unison" && "unisonData" in data ? (data as { unisonData: UnisonData }).unisonData : undefined;
    addFooter(
      data.source,
      data.sourceHref,
      data.song,
      data.artist,
      data.album,
      data.duration,
      data.providerKey,
      data.videoId,
      unisonData,
      syncType === "none"
    );
  } else {
    addNoLyricsButton(data.song, data.artist, data.album, data.duration, data.videoId);
  }

  lyricsContainer.dataset.sync = syncType;
  lyricsContainer.dataset.loaderVisible = String(keepLoaderVisible);
  if (lyrics[0].words === t("lyrics_notFound")) {
    lyricsContainer.dataset.noLyrics = "true";
  }

  const tabSelector = document.getElementsByClassName(TAB_HEADER_CLASS)[1] as HTMLElement;

  let lyricsData = {
    lines: lines,
    syncType: syncType,
    lyricWidth: lyricsContainer.clientWidth,
    lyricHeight: lyricsContainer.clientHeight,
    isMusicVideoSynced: data.musicVideoSynced === true,
    tabSelector,
    lyricsContainer,
  };

  if (data.segmentMap) {
    applySegmentMapToLyrics(lyricsData, data.segmentMap);
  }

  AppState.lyricData = lyricsData;
  AppState.areLyricsTicking = true;
  calculateLyricPositions();
  getResizeObserver().observe(lyricsWrapper);
  if (allZero) {
    log(SYNC_DISABLED_LOG);
  }

  AppState.areLyricsLoaded = true;

  queueMicrotask(() => {
    if (!isStale()) {
      void processBatchTranslationsAndRomanizations(data, lines, isStale, signal);
    }
  });
}

/**
 * Handles batch translation and romanization processing.
 */
async function processBatchTranslationsAndRomanizations(
  data: LyricSourceResultWithMeta,
  linesData: LineData[],
  isStale: () => boolean,
  signal?: AbortSignal
): Promise<void> {
  const lyrics = data.lyrics!;
  const targetTranslationLang = AppState.translationLanguage;
  const isRomanizationEnabled = AppState.isRomanizationEnabled;
  const isTranslateEnabled = AppState.isTranslateEnabled;

  const romanizationBatch: { index: number; text: string }[] = [];
  const translationBatch: { index: number; text: string }[] = [];

  let sourceLanguage = data.language;
  let didInjectCachedContent = false;

  // 1. Identify what needs to be translated/romanized
  lyrics.forEach((item, index) => {
    if (item.isInstrumental) return;

    const lineData = linesData[index];
    const lyricElement = lineData.lyricElement;

    // --- Romanization ---
    const isLanguageDisabledForRomanization = sourceLanguage && isRomanizationDisabledForLang(sourceLanguage);
    if (isRomanizationEnabled && !isLanguageDisabledForRomanization) {
      let romanizedResult: string | null = null;
      let timedRomanization: LyricPart[] | null = null;

      if (item.romanization) {
        romanizedResult = item.romanization;
        timedRomanization = item.timedRomanization || null;
      } else {
        romanizedResult = getRomanizationFromCache(item.words);
      }

      if (romanizedResult && !isSameText(romanizedResult, item.words)) {
        injectRomanization(lyricElement, lineData, romanizedResult, timedRomanization);
        didInjectCachedContent = true;
      } else {
        const shouldRomanize =
          (sourceLanguage && languageMatchesAny(sourceLanguage, ROMANIZATION_LANGUAGES)) ||
          containsNonLatin(item.words);
        if (shouldRomanize || !sourceLanguage) {
          const detectedLang = detectNonLatinLanguage(item.words);
          if (!detectedLang || !isRomanizationDisabledForLang(detectedLang)) {
            romanizationBatch.push({ index, text: item.words });
          }
        }
      }
    }

    // --- Translation ---
    const isSourceLangDisabled = !!sourceLanguage && isTranslationDisabledForLang(sourceLanguage);

    if (isTranslateEnabled && !isSourceLangDisabled) {
      let translationResult: string | null = null;

      const matchedLang =
        item.translations && Object.keys(item.translations).find(lang => langCodesMatch(targetTranslationLang, lang));
      if (item.translations && matchedLang) {
        translationResult = item.translations[matchedLang];
      } else if (item.translation && langCodesMatch(targetTranslationLang, item.translation.lang)) {
        translationResult = item.translation.text;
      } else {
        const cached = getTranslationFromCache(item.words, targetTranslationLang);
        translationResult = cached?.translatedText || null;
      }

      if (translationResult && !isSameText(translationResult, item.words)) {
        injectTranslation(lyricElement, translationResult);
        didInjectCachedContent = true;
      } else if (sourceLanguage !== targetTranslationLang || containsNonLatin(item.words) || !sourceLanguage) {
        translationBatch.push({ index, text: item.words });
      }
    }
  });

  if (didInjectCachedContent) {
    lyricsElementAdded();
  }

  if (isStale()) return;

  // 2. Perform Batch Requests
  const promises: Promise<void>[] = [];

  if (romanizationBatch.length > 0) {
    promises.push(
      (async () => {
        const response = await romanizeBatch({
          lines: romanizationBatch.map(b => b.text),
          sourceLanguage: sourceLanguage || "auto",
          signal,
        });
        if (isStale()) return;

        if (!sourceLanguage && response.detectedLanguage) {
          sourceLanguage = response.detectedLanguage;
          log(LOG_PREFIX, "Determined language via romanization batch: " + sourceLanguage);
        }

        if (isRomanizationDisabledForLang(sourceLanguage || "")) return;

        response.results.forEach((result, i) => {
          if (result) {
            const originalIndex = romanizationBatch[i].index;
            injectRomanization(linesData[originalIndex].lyricElement, linesData[originalIndex], result);
          }
        });
        lyricsElementAdded();
      })()
    );
  }

  if (translationBatch.length > 0) {
    promises.push(
      (async () => {
        const response = await translateBatch({
          lines: translationBatch.map(b => b.text),
          targetLanguage: targetTranslationLang,
          signal,
        });
        if (isStale()) return;

        if (!sourceLanguage && response.detectedLanguage) {
          sourceLanguage = response.detectedLanguage;
          log(LOG_PREFIX, "Determined language via translation batch: " + sourceLanguage);
        }

        if (isTranslationDisabledForLang(sourceLanguage || "")) return;

        response.results.forEach((result, i) => {
          if (result) {
            const originalIndex = translationBatch[i].index;
            injectTranslation(linesData[originalIndex].lyricElement, result.translatedText);
          }
        });
        lyricsElementAdded();
      })()
    );
  }

  await Promise.all(promises);
}

function injectRomanization(
  lyricElement: HTMLElement,
  lineData: LineData,
  text: string,
  timedRomanization: LyricPart[] | null = null
) {
  if (lyricElement.querySelector(`.${ROMANIZED_LYRICS_CLASS}`)) return;

  const romanizedLine = document.createElement("div");
  romanizedLine.classList.add(ROMANIZED_LYRICS_CLASS, CONTENT_LINE_CLASS);
  romanizedLine.dir = "auto";
  applyDirection(romanizedLine, text);

  if (timedRomanization && timedRomanization.length > 0 && !disableRichsync.getBooleanValue()) {
    createLyricsLine(timedRomanization, lineData, romanizedLine, { splitBackgroundLine: false });
  } else {
    romanizedLine.textContent = text;
  }
  lyricElement.appendChild(romanizedLine);
}

function injectTranslation(lyricElement: HTMLElement, text: string) {
  if (lyricElement.querySelector(`.${TRANSLATED_LYRICS_CLASS}`)) return;

  const translatedLine = document.createElement("div");
  translatedLine.classList.add(TRANSLATED_LYRICS_CLASS, CONTENT_LINE_CLASS);
  translatedLine.dir = "auto";
  applyDirection(translatedLine, text);
  translatedLine.textContent = text;
  lyricElement.appendChild(translatedLine);
}

export function calculateLyricPositions() {
  setExtraHeight();
  if (AppState.lyricData && AppState.areLyricsTicking) {
    const lyricsElement = document.getElementsByClassName(LYRICS_CLASS)[0] as HTMLElement;

    const data = AppState.lyricData;
    data.lyricWidth = lyricsElement.clientWidth;

    data.lines.forEach(line => {
      let bounds = getRelativeBounds(lyricsElement, line.lyricElement);
      line.position = bounds.y;
      line.height = bounds.height;
    });
    animEngineState.wasUserScrolling = true; // trigger rescrolls
    resizeCanvas();
  }
}

/**
 * Compares strings without care for punctuation or capitalization
 * @param str1
 * @param str2
 */
function isSameText(str1: string, str2: string): boolean {
  str1 = str1
    .toLowerCase()
    .replaceAll(/(\p{P})/gu, "")
    .trim();
  str2 = str2
    .toLowerCase()
    .replaceAll(/(\p{P})/gu, "")
    .trim();

  return str1 === str2;
}

/**
 * Compare base language codes, e.g. "en" matches "en-US"
 */
function langCodesMatch(lang1: string, lang2: string): boolean {
  if (!lang1 || !lang2) return false;
  const base1 = lang1.split("-")[0];
  const base2 = lang2.split("-")[0];
  return base1 === base2;
}
