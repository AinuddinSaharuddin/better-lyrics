import {
  CURRENT_LYRICS_CLASS,
  LYRICS_CHECK_INTERVAL_ERROR,
  LYRICS_CLASS,
  NO_LYRICS_ELEMENT_LOG,
  TAB_HEADER_CLASS,
  TAB_RENDERER_SELECTOR,
  USER_SCROLLING_CLASS,
} from "@constants";
import { AppState } from "@core/appState";
import { t } from "@core/i18n";
import { calculateLyricPositions, type LineData, type PartData } from "@modules/lyrics/injectLyrics";
import { registerThemeSetting } from "@modules/settings/themeOptions";
import { hideAdOverlay, isAdPlaying, isLoaderActive, showAdOverlay } from "@modules/ui/dom";
import { log } from "@utils";
import { ctx, resetDebugRender } from "./animationEngineDebug";

const LYRIC_ENDING_THRESHOLD_S = registerThemeSetting("blyrics-lyric-ending-threshold-s", 0.5);
const EARLY_SCROLL_CONSIDER = registerThemeSetting("blyrics-early-scroll-consider-s", 0.62);
const QUEUE_SCROLL_THRESHOLD = registerThemeSetting("blyrics-queue-scroll-ms", 150);
const TIME_JUMP_THRESHOLD = 0.5;
const SWIPE_LEAD_RATIO = registerThemeSetting("blyrics-swipe-lead-ratio", 0.1);
const SWIPE_DURATION_RATIO = registerThemeSetting("blyrics-swipe-duration-ratio", 1.6);

const ENABLE_DEBUG_RENDER = registerThemeSetting("blyrics-debug-renderer", false);

let cachedTabRendererHeight: number | null = null;
let tabRendererResizeObserver: ResizeObserver | null = null;
let observedTabRenderer: HTMLElement | null = null;
let scrollAnimation: Animation | null = null;

// 0.5 means the selected lyric will be in the middle of the screen, 0 means top, 1 means bottom
export const SCROLL_POS_OFFSET_RATIO = registerThemeSetting("blyrics-target-scroll-pos-ratio", 0.37);

const PASSIVE_SCROLL_ENABLED = registerThemeSetting("blyrics-passive-scroll-enabled", true);
const PASSIVE_SECONDS_PER_LINE = registerThemeSetting("blyrics-passive-scroll-seconds-per-line", 3.5);
const PASSIVE_BOTTOM_PAUSE_S = registerThemeSetting("blyrics-passive-scroll-bottom-pause-s", 1.5);
const PASSIVE_RESET_DURATION_S = registerThemeSetting("blyrics-passive-scroll-reset-duration-s", 0.6);
const PASSIVE_TOP_PAUSE_S = registerThemeSetting("blyrics-passive-scroll-top-pause-s", 0.8);

interface AnimEngineState {
  skipScrolls: number;
  skipScrollsDecayTimes: number[];
  scrollResumeTime: number;
  scrollPos: number;
  selectedElementIndex: number;
  nextScrollAllowedTime: number;
  wasUserScrolling: boolean;
  lastTime: number;
  lastPlayState: boolean;
  /**
   * Take "-1" to mean that we have no sensible last event
   */
  lastEventCreationTime: number;
  lastActiveElements: LineData[];
  queuedScroll: boolean;
  /**
   * Track if this is the first new tick to avoid rescrolls when opening the lyrics
   */
  doneFirstInstantScroll: boolean;
  lastScrollDebugContext: {
    activeElms: LineData[];
    centers: number[];
    lyricScrollTime: number;
  };
  passiveScrollAccumulatedTime: number;
  passiveLastWallTime: number;
}

export let animEngineState: AnimEngineState = {
  skipScrolls: 0,
  skipScrollsDecayTimes: [],
  scrollResumeTime: 0,
  scrollPos: 0,
  selectedElementIndex: 0,
  nextScrollAllowedTime: 0,
  wasUserScrolling: false,
  lastTime: 0,
  lastPlayState: false,
  lastEventCreationTime: -1,
  doneFirstInstantScroll: true,
  lastActiveElements: [],
  queuedScroll: false,
  lastScrollDebugContext: {
    activeElms: [],
    centers: [],
    lyricScrollTime: 0,
  },
  passiveScrollAccumulatedTime: 0,
  passiveLastWallTime: 0,
};

export function resetActiveAnimations(): void {
  if (!AppState.lyricData || !animEngineState.lastPlayState) return;
  for (const line of AppState.lyricData.lines) {
    if (line.isSelected) {
      resetLineAnimations(line);
      line.isAnimating = false;
    }
  }
}

/**
 * Resets anim engine states
 * Called when song is switched or cleaned up
 */
export function resetAnimEngineState(): void {
  scrollAnimation?.cancel();
  scrollAnimation = null;
  if (AppState.lyricData) {
    for (const line of AppState.lyricData.lines) {
      resetLineAnimations(line);
      line.isAnimating = false;
      line.isSelected = false;
    }
  }
  animEngineState.skipScrollsDecayTimes = [];
  animEngineState.lastActiveElements = [];
  animEngineState.lastScrollDebugContext.activeElms = [];
  animEngineState.lastScrollDebugContext.centers = [];
  animEngineState.doneFirstInstantScroll = false;
  animEngineState.queuedScroll = false;
  animEngineState.passiveScrollAccumulatedTime = 0;
  animEngineState.passiveLastWallTime = 0;
  stopPassiveScrollLoop();
  clearAnimationStyleCache();
}

function resetPartAnimations(part: PartData): void {
  for (const animation of part.animations) {
    animation.cancel();
  }
  part.animations = [];
  part.animationStartTimeMs = Infinity;
}

function resetLineAnimations(lineData: LineData): void {
  const children = [lineData, ...lineData.parts];
  children.forEach(resetPartAnimations);
}

function setAnimationsPlayState(lineData: LineData, isPlaying: boolean): void {
  const children = [lineData, ...lineData.parts];
  for (const part of children) {
    for (const animation of part.animations) {
      if (isPlaying) {
        animation.play();
      } else {
        animation.pause();
      }
    }
  }
}

function animationCurrentTime(animation: Animation, currentTimeMs: number): void {
  try {
    animation.currentTime = Math.max(0, currentTimeMs);
  } catch {
    // Some browsers reject currentTime before the animation is ready. In that case
    // the next tick will recreate the animation from the current playback time.
  }
}

const LINE_SYNCED_WORD_CLASS = "blyrics-line-synced-word";
const WORD_HIGHLIGHT_SELECTOR = ".blyrics-word-highlight";
const INSTRUMENTAL_FILL_SELECTOR = ".blyrics--instrumental-fill";
const INSTRUMENTAL_WAVE_CLIP_SELECTOR = ".blyrics--wave-clip";
const INSTRUMENTAL_WAVE_PATH_SELECTOR = ".blyrics--wave-path";

interface AnimationConfig {
  enabled: {
    lineScale: boolean;
    wordWobble: boolean;
    highlightSwipe: boolean;
    highlightGlow: boolean;
    highlightFade: boolean;
    scroll: boolean;
    instrumental: boolean;
  };
  line: {
    durationMs: number;
    enterEasing: string;
    exitEasing: string;
    enterFrom: string;
    enterTo: string;
    exitFrom: string;
    exitTo: string;
  };
  highlight: {
    fadeInDurationMs: number;
    fadeOutDurationMs: number;
    fadeInEasing: string;
    fadeOutEasing: string;
    swipeEasing: string;
    swipeStartFrom: string;
    swipeEndFrom: string;
    swipeStartTo: string;
    swipeEndTo: string;
    glowFrom: string;
    glowTo: string;
    glowDurationRatio: number;
    glowMinDurationMs: number;
    glowEasing: string;
  };
  word: {
    wobbleDurationMs: number;
    wobbleEasing: string;
    wobblePeakEasing: string;
    wobbleEndEasing: string;
    wobbleFrom: string;
    wobblePeak: string;
    wobbleSettle: string;
    wobbleTo: string;
    wobblePeakOffset: number;
    wobbleSettleOffset: number;
  };
  instrumental: {
    fillFadeDurationMs: number;
    fillFadeEasing: string;
    fillFrom: string;
    fillTo: string;
    fillEasing: string;
    waveFrom: string;
    waveTo: string;
    waveEasing: string;
  };
  scroll: {
    durationMs: number;
    easing: string;
  };
}

interface HighlightAnimations {
  animations: Animation[];
  swipe?: Animation;
  fade?: Animation;
  glow?: Animation;
}

function activeTextGradientKeyframes(config: AnimationConfig): Keyframe[] {
  return [
    {
      "--lyric-transition-amount-start": config.highlight.swipeStartFrom,
      "--lyric-transition-amount-end": config.highlight.swipeEndFrom,
    },
    {
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
  ] as Keyframe[];
}

function activeTextGlowKeyframes(config: AnimationConfig): Keyframe[] {
  return [{ filter: config.highlight.glowFrom }, { filter: config.highlight.glowTo }];
}

function activeTextOpacityKeyframes(): Keyframe[] {
  return [{ opacity: 0 }, { opacity: 1 }];
}

function highlightTarget(part: PartData): { element: Element; options: KeyframeAnimationOptions } {
  const highlight = part.lyricElement.querySelector(WORD_HIGHLIGHT_SELECTOR);
  if (highlight) {
    return { element: highlight, options: {} };
  }
  return { element: part.lyricElement, options: { pseudoElement: "::after" } as KeyframeAnimationOptions };
}

function lineSyncedTextKeyframes(config: AnimationConfig): Keyframe[] {
  return [
    {
      opacity: 0,
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
    {
      opacity: 1,
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
  ] as Keyframe[];
}

function fadeOutTextKeyframes(config: AnimationConfig): Keyframe[] {
  return [
    {
      opacity: 1,
      filter: config.highlight.glowTo,
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
    {
      opacity: 0,
      filter: config.highlight.glowTo,
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
  ] as Keyframe[];
}

function startRichSyncedHighlightAnimations(
  part: PartData,
  config: AnimationConfig,
  swipeDelayMs: number,
  wordDelayMs: number,
  swipeDurationMs: number,
  glowDurationMs: number
): HighlightAnimations {
  const animations: Animation[] = [];
  const fadeInDuration = config.enabled.highlightFade ? config.highlight.fadeInDurationMs : 1;
  const target = highlightTarget(part);

  try {
    let swipeAnimation: Animation | undefined;
    if (config.enabled.highlightSwipe) {
      swipeAnimation = target.element.animate(activeTextGradientKeyframes(config), {
        delay: swipeDelayMs,
        duration: swipeDurationMs,
        easing: config.highlight.swipeEasing,
        fill: "forwards",
        ...target.options,
      });
      animations.push(swipeAnimation);
    }

    const opacityAnimation = target.element.animate(
      config.enabled.highlightSwipe ? activeTextOpacityKeyframes() : lineSyncedTextKeyframes(config),
      {
        delay: wordDelayMs,
        duration: fadeInDuration,
        easing: config.enabled.highlightFade ? config.highlight.fadeInEasing : "linear",
        fill: "forwards",
        ...target.options,
      }
    );
    animations.push(opacityAnimation);

    let glowAnimation: Animation | undefined;
    if (config.enabled.highlightGlow) {
      glowAnimation = target.element.animate(activeTextGlowKeyframes(config), {
        delay: wordDelayMs,
        duration: glowDurationMs,
        easing: config.highlight.glowEasing,
        fill: "forwards",
        ...target.options,
      });
      animations.push(glowAnimation);
    }

    return { animations, swipe: swipeAnimation, fade: opacityAnimation, glow: glowAnimation };
  } catch {
    const fallbackAnimation = part.lyricElement.animate(
      [
        { color: "var(--blyrics-lyric-inactive-color)" },
        { color: "var(--blyrics-lyric-active-color)" },
        { color: "var(--blyrics-lyric-active-color)" },
      ],
      {
        delay: wordDelayMs,
        duration: fadeInDuration,
        easing: "linear",
        fill: "forwards",
      }
    );
    return { animations: [fallbackAnimation], fade: fallbackAnimation };
  }
}

function startLineSyncedHighlightAnimations(
  part: PartData,
  config: AnimationConfig,
  wordDelayMs: number,
  glowDurationMs: number
): HighlightAnimations {
  const animations: Animation[] = [];
  const fadeInDuration = config.enabled.highlightFade ? config.highlight.fadeInDurationMs : 1;
  const target = highlightTarget(part);

  try {
    const opacityAnimation = target.element.animate(lineSyncedTextKeyframes(config), {
      delay: wordDelayMs,
      duration: fadeInDuration,
      easing: config.enabled.highlightFade ? config.highlight.fadeInEasing : "linear",
      fill: "forwards",
      ...target.options,
    });
    animations.push(opacityAnimation);

    let glowAnimation: Animation | undefined;
    if (config.enabled.highlightGlow) {
      glowAnimation = target.element.animate(activeTextGlowKeyframes(config), {
        delay: wordDelayMs,
        duration: glowDurationMs,
        easing: config.highlight.glowEasing,
        fill: "forwards",
        ...target.options,
      });
      animations.push(glowAnimation);
    }

    return { animations, fade: opacityAnimation, glow: glowAnimation };
  } catch {
    const fallbackAnimation = part.lyricElement.animate(
      [{ color: "var(--blyrics-lyric-inactive-color)" }, { color: "var(--blyrics-lyric-active-color)" }],
      {
        delay: wordDelayMs,
        duration: fadeInDuration,
        easing: config.enabled.highlightFade ? config.highlight.fadeInEasing : "linear",
        fill: "forwards",
      }
    );
    return { animations: [fallbackAnimation], fade: fallbackAnimation };
  }
}

function startLineAnimation(lineData: LineData, config: AnimationConfig, currentTime: number, now: number): void {
  resetPartAnimations(lineData);

  const rawElapsedMs = (currentTime - lineData.time) * 1000;
  const elapsedMs = Math.max(0, rawElapsedMs);
  const delayMs = Math.max(0, -rawElapsedMs);

  if (!config.enabled.lineScale) {
    lineData.animations = [];
    lineData.animationStartTimeMs = now + delayMs;
    return;
  }

  const animation = lineData.lyricElement.animate(
    [{ transform: config.line.enterFrom }, { transform: config.line.enterTo }],
    {
      delay: delayMs,
      duration: config.line.durationMs,
      easing: config.line.enterEasing,
      fill: "forwards",
    }
  );

  if (rawElapsedMs >= 0) {
    animationCurrentTime(animation, Math.min(elapsedMs, config.line.durationMs));
  }
  lineData.animations = [animation];
  lineData.animationStartTimeMs = now + delayMs;
}

function startLineExitAnimation(lineData: LineData, config: AnimationConfig): void {
  resetPartAnimations(lineData);

  if (!config.enabled.lineScale) {
    return;
  }

  const animation = lineData.lyricElement.animate(
    [{ transform: config.line.exitFrom }, { transform: config.line.exitTo }],
    {
      duration: config.line.durationMs,
      easing: config.line.exitEasing,
      fill: "none",
    }
  );

  lineData.animations = [animation];
  animation.addEventListener(
    "finish",
    () => {
      resetPartAnimations(lineData);
    },
    { once: true }
  );
}

function startWordAnimations(part: PartData, config: AnimationConfig, currentTime: number, now: number): void {
  resetPartAnimations(part);

  const rawElapsedMs = (currentTime - part.time) * 1000;
  const timedDurationMs = part.duration * 1000;
  const isLineSyncedWord = part.duration <= 0 || part.lyricElement.classList.contains(LINE_SYNCED_WORD_CLASS);
  const swipeLeadMs = timedDurationMs * SWIPE_LEAD_RATIO.getNumberValue();
  const swipeElapsedMs = rawElapsedMs + swipeLeadMs;
  const swipeDelayMs = Math.max(0, -swipeElapsedMs);
  const wordDelayMs = Math.max(0, -rawElapsedMs);
  const elapsedMs = Math.max(0, rawElapsedMs);
  const swipeDurationMs = timedDurationMs * SWIPE_DURATION_RATIO.getNumberValue();
  const glowDurationMs = Math.max(
    timedDurationMs * config.highlight.glowDurationRatio,
    config.highlight.glowMinDurationMs
  );
  const fadeInDurationMs = config.enabled.highlightFade ? config.highlight.fadeInDurationMs : 1;

  const highlightAnimations = isLineSyncedWord
    ? startLineSyncedHighlightAnimations(part, config, wordDelayMs, config.highlight.glowMinDurationMs)
    : startRichSyncedHighlightAnimations(part, config, swipeDelayMs, wordDelayMs, swipeDurationMs, glowDurationMs);

  const wobbleAnimation = config.enabled.wordWobble
    ? part.lyricElement.animate(
        [
          { transform: config.word.wobbleFrom },
          {
            transform: config.word.wobblePeak,
            offset: config.word.wobblePeakOffset,
            easing: config.word.wobblePeakEasing,
          },
          { transform: config.word.wobbleSettle, offset: config.word.wobbleSettleOffset },
          { transform: config.word.wobbleTo, easing: config.word.wobbleEndEasing },
        ],
        {
          delay: wordDelayMs,
          duration: config.word.wobbleDurationMs,
          easing: config.word.wobbleEasing,
          fill: "forwards",
        }
      )
    : null;

  if (isLineSyncedWord) {
    if (rawElapsedMs >= 0) {
      if (highlightAnimations.fade) {
        animationCurrentTime(highlightAnimations.fade, Math.min(elapsedMs, fadeInDurationMs));
      }
      if (highlightAnimations.glow) {
        animationCurrentTime(highlightAnimations.glow, Math.min(elapsedMs, config.highlight.glowMinDurationMs));
      }
    }
  } else {
    if (swipeElapsedMs >= 0 && highlightAnimations.swipe) {
      animationCurrentTime(highlightAnimations.swipe, Math.min(swipeElapsedMs, swipeDurationMs));
    }
    if (rawElapsedMs >= 0 && highlightAnimations.fade) {
      animationCurrentTime(highlightAnimations.fade, Math.min(elapsedMs, fadeInDurationMs));
    }
    if (rawElapsedMs >= 0 && highlightAnimations.glow) {
      animationCurrentTime(highlightAnimations.glow, Math.min(elapsedMs, glowDurationMs));
    }
  }
  if (rawElapsedMs >= 0 && wobbleAnimation) {
    animationCurrentTime(wobbleAnimation, Math.min(elapsedMs, config.word.wobbleDurationMs));
  }
  part.animations = wobbleAnimation
    ? [...highlightAnimations.animations, wobbleAnimation]
    : highlightAnimations.animations;
  part.animationStartTimeMs =
    now + (isLineSyncedWord || !highlightAnimations.swipe ? wordDelayMs : Math.min(swipeDelayMs, wordDelayMs));
}

function startLineAnimations(lineData: LineData, config: AnimationConfig, currentTime: number, now: number): void {
  startLineAnimation(lineData, config, currentTime, now);
  if (lineData.lyricElement.dataset.instrumental === "true") {
    startInstrumentalAnimations(lineData, config, currentTime, now);
    return;
  }

  for (const part of lineData.parts) {
    startWordAnimations(part, config, currentTime, now);
  }
}

function startWordExitAnimation(part: PartData, config: AnimationConfig): void {
  resetPartAnimations(part);

  const fadeDuration = config.enabled.highlightFade ? config.highlight.fadeOutDurationMs : 1;
  const target = highlightTarget(part);
  const animation = target.element.animate(fadeOutTextKeyframes(config), {
    duration: fadeDuration,
    easing: config.enabled.highlightFade ? config.highlight.fadeOutEasing : "linear",
    fill: "none",
    ...target.options,
  });

  part.animations = [animation];
  animation.addEventListener(
    "finish",
    () => {
      resetPartAnimations(part);
    },
    { once: true }
  );
}

function startLineExitAnimations(lineData: LineData, config: AnimationConfig, currentTime: number): void {
  startLineExitAnimation(lineData, config);

  if (lineData.lyricElement.dataset.instrumental === "true") {
    startInstrumentalExitAnimations(lineData, config, currentTime);
    return;
  }

  for (const part of lineData.parts) {
    if (currentTime >= part.time) {
      startWordExitAnimation(part, config);
    } else {
      resetPartAnimations(part);
    }
  }
}

function animateInstrumentalChild(
  lineData: LineData,
  selector: string,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions
): Animation | null {
  const element = lineData.lyricElement.querySelector(selector) as Element | null;
  if (!element) return null;

  const animation = element.animate(keyframes, options);
  lineData.animations.push(animation);
  return animation;
}

function startInstrumentalAnimations(
  lineData: LineData,
  config: AnimationConfig,
  currentTime: number,
  now: number
): void {
  const rawElapsedMs = (currentTime - lineData.time) * 1000;
  const elapsedMs = Math.max(0, rawElapsedMs);
  const delayMs = Math.max(0, -rawElapsedMs);
  const durationMs = Math.max(lineData.duration * 1000, 1);
  const fillFadeDuration = config.enabled.instrumental ? config.instrumental.fillFadeDurationMs : 1;

  const fillAnimation = animateInstrumentalChild(
    lineData,
    INSTRUMENTAL_FILL_SELECTOR,
    [{ opacity: 0 }, { opacity: 1 }],
    {
      delay: delayMs,
      duration: fillFadeDuration,
      easing: config.enabled.instrumental ? config.instrumental.fillFadeEasing : "linear",
      fill: "forwards",
    }
  );

  let fillTravelAnimation: Animation | null = null;
  let waveAnimation: Animation | null = null;
  if (config.enabled.instrumental) {
    fillTravelAnimation = animateInstrumentalChild(
      lineData,
      INSTRUMENTAL_WAVE_CLIP_SELECTOR,
      [{ transform: config.instrumental.fillFrom }, { transform: config.instrumental.fillTo }],
      {
        delay: delayMs,
        duration: durationMs,
        easing: config.instrumental.fillEasing,
        fill: "both",
      }
    );

    waveAnimation = animateInstrumentalChild(
      lineData,
      INSTRUMENTAL_WAVE_PATH_SELECTOR,
      [{ transform: config.instrumental.waveFrom }, { transform: config.instrumental.waveTo }],
      {
        delay: delayMs,
        duration: durationMs,
        easing: config.instrumental.waveEasing,
        fill: "both",
      }
    );
  }

  if (rawElapsedMs >= 0) {
    if (fillAnimation) {
      animationCurrentTime(fillAnimation, Math.min(elapsedMs, fillFadeDuration));
    }
    for (const animation of [fillTravelAnimation, waveAnimation]) {
      if (animation) {
        animationCurrentTime(animation, Math.min(elapsedMs, durationMs));
      }
    }
  }

  lineData.animationStartTimeMs = now + delayMs;
}

function startInstrumentalExitAnimations(lineData: LineData, config: AnimationConfig, currentTime: number): void {
  if (currentTime < lineData.time) return;

  const fadeDuration =
    config.enabled.instrumental && config.enabled.highlightFade ? config.highlight.fadeOutDurationMs : 1;
  animateInstrumentalChild(lineData, INSTRUMENTAL_FILL_SELECTOR, [{ opacity: 1 }, { opacity: 0 }], {
    duration: fadeDuration,
    easing: config.enabled.instrumental ? config.highlight.fadeOutEasing : "linear",
    fill: "none",
  });
}

let cachedDurations: Map<string, number> = new Map();
const cachedCSSValues: Map<string, string> = new Map();

export function clearAnimationStyleCache(): void {
  cachedDurations.clear();
  cachedCSSValues.clear();
}

if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", clearAnimationStyleCache);
}

function getCSSValue(lyricsElement: HTMLElement, property: string, fallback: string): string {
  let value = cachedCSSValues.get(property);
  if (value === undefined) {
    value = window.getComputedStyle(lyricsElement).getPropertyValue(property).trim() || fallback;
    cachedCSSValues.set(property, value);
  }
  return value;
}

/**
 * Gets and caches a css duration.
 * Note this function does not key its cache on the element provided --
 * it assumes that it isn't relevant to the calling code
 *
 * @param lyricsElement - the element to look up against
 * @param property - the css property to look up
 * @return - in ms
 */
function getCSSDurationInMs(lyricsElement: HTMLElement, property: string): number {
  let duration = cachedDurations.get(property);
  if (duration === undefined) {
    duration = toMs(getCSSValue(lyricsElement, property, "0ms"));
    cachedDurations.set(property, duration);
  }

  return duration;
}

function getCSSDurationWithFallback(lyricsElement: HTMLElement, property: string, fallback: string): number {
  return Math.max(toMs(getCSSValue(lyricsElement, property, fallback)), 1);
}

function getCSSNumber(lyricsElement: HTMLElement, property: string, fallback: number): number {
  const value = Number.parseFloat(getCSSValue(lyricsElement, property, `${fallback}`));
  return Number.isFinite(value) ? value : fallback;
}

function getCSSBoolean(lyricsElement: HTMLElement, property: string, fallback: boolean): boolean {
  const value = getCSSValue(lyricsElement, property, fallback ? "1" : "0").toLowerCase();
  if (value === "false" || value === "off" || value === "none") return false;
  const numericValue = Number.parseFloat(value);
  if (Number.isFinite(numericValue)) return numericValue > 0;
  return fallback;
}

function getCSSOffset(lyricsElement: HTMLElement, property: string, fallback: number): number {
  return Math.max(0, Math.min(1, getCSSNumber(lyricsElement, property, fallback)));
}

function readAnimationConfig(lyricsElement: HTMLElement): AnimationConfig {
  return {
    enabled: {
      lineScale: getCSSBoolean(lyricsElement, "--blyrics-animate-line-scale", true),
      wordWobble: getCSSBoolean(lyricsElement, "--blyrics-animate-word-wobble", true),
      highlightSwipe: getCSSBoolean(lyricsElement, "--blyrics-animate-highlight-swipe", true),
      highlightGlow: getCSSBoolean(lyricsElement, "--blyrics-animate-highlight-glow", true),
      highlightFade: getCSSBoolean(lyricsElement, "--blyrics-animate-highlight-fade", true),
      scroll: getCSSBoolean(lyricsElement, "--blyrics-animate-scroll", true),
      instrumental: getCSSBoolean(lyricsElement, "--blyrics-animate-instrumental", true),
    },
    line: {
      durationMs: getCSSDurationWithFallback(lyricsElement, "--blyrics-scale-transition-duration", "0.166s"),
      enterEasing: getCSSValue(lyricsElement, "--blyrics-line-enter-easing", "ease"),
      exitEasing: getCSSValue(lyricsElement, "--blyrics-line-exit-easing", "ease"),
      enterFrom: getCSSValue(lyricsElement, "--blyrics-line-enter-transform-from", "scale(var(--blyrics-scale))"),
      enterTo: getCSSValue(lyricsElement, "--blyrics-line-enter-transform-to", "scale(var(--blyrics-active-scale))"),
      exitFrom: getCSSValue(lyricsElement, "--blyrics-line-exit-transform-from", "scale(var(--blyrics-active-scale))"),
      exitTo: getCSSValue(lyricsElement, "--blyrics-line-exit-transform-to", "scale(var(--blyrics-scale))"),
    },
    highlight: {
      fadeInDurationMs: getCSSDurationWithFallback(
        lyricsElement,
        "--blyrics-lyric-highlight-fade-in-duration",
        "0.33s"
      ),
      fadeOutDurationMs: getCSSDurationWithFallback(
        lyricsElement,
        "--blyrics-lyric-highlight-fade-out-duration",
        "0.5s"
      ),
      fadeInEasing: getCSSValue(lyricsElement, "--blyrics-lyric-highlight-fade-in-easing", "ease"),
      fadeOutEasing: getCSSValue(lyricsElement, "--blyrics-lyric-highlight-fade-out-easing", "ease"),
      swipeEasing: getCSSValue(lyricsElement, "--blyrics-highlight-swipe-easing", "linear"),
      swipeStartFrom: getCSSValue(lyricsElement, "--blyrics-highlight-swipe-start-from", "-0.2"),
      swipeEndFrom: getCSSValue(lyricsElement, "--blyrics-highlight-swipe-end-from", "-0.1"),
      swipeStartTo: getCSSValue(lyricsElement, "--blyrics-highlight-swipe-start-to", "1.4"),
      swipeEndTo: getCSSValue(lyricsElement, "--blyrics-highlight-swipe-end-to", "1.5"),
      glowFrom: getCSSValue(
        lyricsElement,
        "--blyrics-highlight-glow-filter-from",
        "drop-shadow(0 0 0.8rem var(--blyrics-glow-color))"
      ),
      glowTo: getCSSValue(
        lyricsElement,
        "--blyrics-highlight-glow-filter-to",
        "drop-shadow(0 0 0 var(--blyrics-glow-color))"
      ),
      glowDurationRatio: getCSSNumber(lyricsElement, "--blyrics-highlight-glow-duration-ratio", 1.2),
      glowMinDurationMs: getCSSDurationWithFallback(lyricsElement, "--blyrics-highlight-glow-min-duration", "1.2s"),
      glowEasing: getCSSValue(lyricsElement, "--blyrics-highlight-glow-easing", "ease"),
    },
    word: {
      wobbleDurationMs: getCSSDurationWithFallback(lyricsElement, "--blyrics-wobble-duration", "1s"),
      wobbleEasing: getCSSValue(lyricsElement, "--blyrics-word-wobble-easing", "ease"),
      wobblePeakEasing: getCSSValue(lyricsElement, "--blyrics-word-wobble-peak-easing", "ease-in-out"),
      wobbleEndEasing: getCSSValue(lyricsElement, "--blyrics-word-wobble-end-easing", "ease-out"),
      wobbleFrom: getCSSValue(lyricsElement, "--blyrics-word-wobble-transform-from", "scaleX(1)"),
      wobblePeak: getCSSValue(
        lyricsElement,
        "--blyrics-word-wobble-transform-peak",
        "translateX(0.05em) scaleX(1.025)"
      ),
      wobbleSettle: getCSSValue(lyricsElement, "--blyrics-word-wobble-transform-settle", "translateX(0) scaleX(1)"),
      wobbleTo: getCSSValue(lyricsElement, "--blyrics-word-wobble-transform-to", "scaleX(1)"),
      wobblePeakOffset: getCSSOffset(lyricsElement, "--blyrics-word-wobble-peak-offset", 0.125),
      wobbleSettleOffset: getCSSOffset(lyricsElement, "--blyrics-word-wobble-settle-offset", 0.75),
    },
    instrumental: {
      fillFadeDurationMs: getCSSDurationWithFallback(
        lyricsElement,
        "--blyrics-instrumental-fill-fade-duration",
        "150ms"
      ),
      fillFadeEasing: getCSSValue(lyricsElement, "--blyrics-instrumental-fill-fade-easing", "ease"),
      fillFrom: getCSSValue(lyricsElement, "--blyrics-instrumental-fill-transform-from", "translateY(78%)"),
      fillTo: getCSSValue(lyricsElement, "--blyrics-instrumental-fill-transform-to", "translateY(-4%)"),
      fillEasing: getCSSValue(lyricsElement, "--blyrics-instrumental-fill-easing", "linear"),
      waveFrom: getCSSValue(lyricsElement, "--blyrics-instrumental-wave-transform-from", "scaleY(1.2)"),
      waveTo: getCSSValue(lyricsElement, "--blyrics-instrumental-wave-transform-to", "scaleY(0.0001)"),
      waveEasing: getCSSValue(lyricsElement, "--blyrics-instrumental-wave-easing", "ease-in"),
    },
    scroll: {
      durationMs: getCSSDurationWithFallback(lyricsElement, "--blyrics-lyric-scroll-duration", "750ms"),
      easing: getCSSValue(lyricsElement, "--blyrics-lyric-scroll-timing-function", "cubic-bezier(0.86, 0, 0.07, 1)"),
    },
  };
}

function animateScrollOffset(
  lyricsElement: HTMLElement,
  fromScrollTop: number,
  toScrollTop: number,
  durationMs: number,
  easing: string
): void {
  scrollAnimation?.cancel();

  const offset = toScrollTop - fromScrollTop;
  scrollAnimation = lyricsElement.animate(
    [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0px)" }],
    {
      duration: durationMs,
      easing,
      fill: "none",
    }
  );

  scrollAnimation.addEventListener(
    "finish",
    () => {
      scrollAnimation = null;
    },
    { once: true }
  );
}

// -- Skip Scrolls Decay --------------------------

function decaySkipScrolls(now: number): void {
  let j = 0;
  for (; j < animEngineState.skipScrollsDecayTimes.length; j++) {
    if (animEngineState.skipScrollsDecayTimes[j] > now) {
      break;
    }
  }
  animEngineState.skipScrollsDecayTimes = animEngineState.skipScrollsDecayTimes.slice(j);
  animEngineState.skipScrolls -= j;
  if (animEngineState.skipScrolls < 1) {
    animEngineState.skipScrolls = 1;
  }
}

// -- Passive Scroll Engine --------------------------

let passiveRAFId: number | null = null;

function stopPassiveScrollLoop(): void {
  if (passiveRAFId !== null) {
    cancelAnimationFrame(passiveRAFId);
    passiveRAFId = null;
  }
}

function startPassiveScrollLoop(): void {
  if (passiveRAFId !== null) return;
  passiveRAFId = requestAnimationFrame(passiveScrollRAFLoop);
}

function passiveScrollRAFLoop(): void {
  passiveRAFId = null;
  if (
    !AppState.isPassiveScrollEnabled ||
    !PASSIVE_SCROLL_ENABLED.getBooleanValue() ||
    AppState.lyricData?.syncType !== "none"
  )
    return;

  passiveScrollEngine(animEngineState.lastPlayState);
  passiveRAFId = requestAnimationFrame(passiveScrollRAFLoop);
}

function passiveScrollEngine(isPlaying: boolean): void {
  const lyricData = AppState.lyricData;
  if (!lyricData) return;

  const tabSelector = lyricData.tabSelector;
  if (!tabSelector || tabSelector.getAttribute("aria-selected") !== "true") return;

  if (isLoaderActive()) return;

  const tabRenderer = document.querySelector(TAB_RENDERER_SELECTOR) as HTMLElement;
  if (!tabRenderer) return;

  const now = Date.now();

  // -- Accumulate play time --------------------------
  if (animEngineState.passiveLastWallTime > 0 && isPlaying) {
    const wallDelta = (now - animEngineState.passiveLastWallTime) / 1000;
    animEngineState.passiveScrollAccumulatedTime += Math.min(wallDelta, 0.5);
  }
  animEngineState.passiveLastWallTime = now;

  // -- User scroll interruption --------------------------
  if (animEngineState.scrollResumeTime > now) {
    return;
  }

  if (animEngineState.wasUserScrolling) {
    getResumeScrollElement().setAttribute("autoscroll-hidden", "true");
    lyricData.lyricsContainer.classList.remove(USER_SCROLLING_CLASS);
    animEngineState.wasUserScrolling = false;

    // Re-sync accumulated time to current scroll position so scroll continues from where user left off
    const maxScroll = tabRenderer.scrollHeight - tabRenderer.clientHeight;
    if (maxScroll > 0) {
      const ratio = tabRenderer.scrollTop / maxScroll;
      const numLines = lyricData.lines.length;
      const scrollDuration = numLines * PASSIVE_SECONDS_PER_LINE.getNumberValue();
      animEngineState.passiveScrollAccumulatedTime = ratio * scrollDuration;
    }
  }

  // -- Cycle calculation --------------------------
  const numLines = lyricData.lines.length;
  if (numLines === 0) return;

  const scrollDuration = numLines * PASSIVE_SECONDS_PER_LINE.getNumberValue();
  const bottomPause = PASSIVE_BOTTOM_PAUSE_S.getNumberValue();
  const resetDuration = PASSIVE_RESET_DURATION_S.getNumberValue();
  const topPause = PASSIVE_TOP_PAUSE_S.getNumberValue();
  const cycleLength = scrollDuration + bottomPause + resetDuration + topPause;

  const maxScroll = tabRenderer.scrollHeight - tabRenderer.clientHeight;
  if (maxScroll <= 0) return;

  const cycleTime = animEngineState.passiveScrollAccumulatedTime % cycleLength;

  let targetScroll: number;
  if (cycleTime < scrollDuration) {
    // Phase 1: linear scroll down
    targetScroll = (cycleTime / scrollDuration) * maxScroll;
  } else if (cycleTime < scrollDuration + bottomPause) {
    // Phase 2: hold at bottom
    targetScroll = maxScroll;
  } else if (cycleTime < scrollDuration + bottomPause + resetDuration) {
    // Phase 3: ease-out scroll back to top
    const resetProgress = (cycleTime - scrollDuration - bottomPause) / resetDuration;
    const eased = 1 - (1 - resetProgress) * (1 - resetProgress);
    targetScroll = maxScroll * (1 - eased);
  } else {
    // Phase 4: hold at top
    targetScroll = 0;
  }

  const prevScrollTop = tabRenderer.scrollTop;
  tabRenderer.scrollTop = targetScroll;
  // Only skip the next scroll event if scrollTop actually changed.
  // When it doesn't change (pause phases, sub-pixel rounding), no programmatic
  // scroll event fires — setting skipScrolls would eat user scroll events instead.
  if (tabRenderer.scrollTop !== prevScrollTop) {
    animEngineState.skipScrolls = 1;
  }
}

/**
 * Sets up a ResizeObserver on the tab renderer to cache its height.
 * Avoids calling getBoundingClientRect() every tick which causes layout thrashing.
 */
function setupTabRendererObserver(element: HTMLElement) {
  if (tabRendererResizeObserver) {
    tabRendererResizeObserver.disconnect();
  }

  tabRendererResizeObserver = new ResizeObserver(() => {
    if (element && element.isConnected) {
      cachedTabRendererHeight = element.getBoundingClientRect().height;
    }
  });

  tabRendererResizeObserver.observe(element);
  observedTabRenderer = element;
  cachedTabRendererHeight = element.getBoundingClientRect().height;
}

/**
 * Main lyrics synchronization function that handles timing, highlighting, and scrolling.
 *
 * @param currentTime - Current playback time in seconds
 * @param eventCreationTime - Timestamp when the event was created (ms)
 * @param [isPlaying=true] - Whether audio is currently playing
 * @param [smoothScroll=true] - Whether to use smooth scrolling
 */
export function animationEngine(currentTime: number, eventCreationTime: number, isPlaying = true, smoothScroll = true) {
  const now = Date.now();
  // const frameStart = performance.now();
  if (!AppState.areLyricsTicking || (currentTime === 0 && !isPlaying)) {
    return;
  }

  if (AppState.lyricData?.syncType === "none") {
    if (!animEngineState.lastPlayState && isPlaying) {
      animEngineState.scrollResumeTime = 0;
    }
    animEngineState.lastPlayState = isPlaying;
    if (!AppState.isPassiveScrollEnabled) return;
    startPassiveScrollLoop();
    return;
  }

  const timeJumped =
    Math.abs(
      currentTime - animEngineState.lastTime - (eventCreationTime - animEngineState.lastEventCreationTime) / 1000
    ) > TIME_JUMP_THRESHOLD;

  animEngineState.lastTime = currentTime;
  animEngineState.lastPlayState = isPlaying;
  animEngineState.lastEventCreationTime = eventCreationTime;

  let timeOffset = now - eventCreationTime;
  if (!isPlaying || eventCreationTime === -1) {
    timeOffset = 0;
  }

  currentTime += timeOffset / 1000;

  let lyricData = AppState.lyricData;
  if (!lyricData) {
    AppState.areLyricsTicking = false;
    log("Lyrics are ticking, but lyricData are null!");
    return;
  }

  const tabSelector = lyricData.tabSelector;
  console.assert(tabSelector != null);

  const playerState = document.getElementById("player-page")?.getAttribute("player-ui-state");
  const isPlayerOpen =
    !playerState ||
    playerState === "PLAYER_PAGE_OPEN" ||
    playerState === "FULLSCREEN" ||
    playerState === "MINIPLAYER_IN_PLAYER_PAGE";
  // Don't tick lyrics if they're not visible
  if (tabSelector.getAttribute("aria-selected") !== "true" || !isPlayerOpen) {
    animEngineState.doneFirstInstantScroll = false;
    return;
  }

  if (isAdPlaying()) {
    showAdOverlay();
    return;
  } else {
    hideAdOverlay();
  }

  try {
    const lyricsElement = lyricData.lyricsContainer;
    // If lyrics element doesn't exist, clear the interval and return silently
    if (!lyricsElement) {
      AppState.areLyricsTicking = false;
      log(NO_LYRICS_ELEMENT_LOG);
      return;
    }

    const lines = AppState.lyricData!.lines;

    if (lyricData.syncType === "richsync") {
      currentTime += getCSSDurationInMs(lyricsElement, "--blyrics-richsync-timing-offset") / 1000;
    } else {
      currentTime += getCSSDurationInMs(lyricsElement, "--blyrics-timing-offset") / 1000;
    }

    const lyricScrollTime = currentTime + getCSSDurationInMs(lyricsElement, "--blyrics-scroll-timing-offset") / 1000;
    const animationConfig = readAnimationConfig(lyricsElement);

    // Read layout values before the loop writes class changes, to avoid forced reflow
    const tabRenderer = document.querySelector(TAB_RENDERER_SELECTOR) as HTMLElement | null;
    if (!tabRenderer) return;
    if (tabRenderer !== observedTabRenderer) {
      setupTabRendererObserver(tabRenderer);
    }
    const tabRendererHeight = cachedTabRendererHeight ?? tabRenderer.getBoundingClientRect().height;
    let scrollTop = tabRenderer.scrollTop;

    let activeElems = [] as LineData[];
    const linesToAnimate: LineData[] = [];
    let newLyricSelected = timeJumped;

    lines.every((lineData, index) => {
      const time = lineData.time;
      let nextTime = Infinity;
      if (index + 1 < lines.length) {
        const nextLyric = lines[index + 1];
        nextTime = nextLyric.time;
      }

      if (
        lyricScrollTime >= time - EARLY_SCROLL_CONSIDER.getNumberValue() &&
        (lyricScrollTime < nextTime || lyricScrollTime < time + lineData.duration)
      ) {
        activeElems.push(lineData);
        if (!animEngineState.lastActiveElements.includes(lineData) && lyricScrollTime >= time) {
          newLyricSelected = true;
        }

        // const timeDelta = lyricScrollTime - time;
        // if (animEngineState.selectedElementIndex !== index && timeDelta > 0.05 && index > 0) {
        //   Utils.log(`[BetterLyrics] Scrolling to new lyric was late, dt: ${timeDelta.toFixed(5)}s`);
        // }
        animEngineState.selectedElementIndex = index;
        if (!lineData.isScrolled) {
          lineData.lyricElement.classList.add(CURRENT_LYRICS_CLASS);
          lineData.isScrolled = true;
        }
      } else {
        if (lineData.isScrolled) {
          lineData.lyricElement.classList.remove(CURRENT_LYRICS_CLASS);
          lineData.isScrolled = false;
        }
      }

      /**
       * Time in seconds to set up animations. This shouldn't affect any visible effects, just help when the browser stutters
       */
      let setUpAnimationEarlyTime: number = 2;

      if (!isPlaying) {
        setUpAnimationEarlyTime = 0;
      }

      const effectiveEndTime = Math.max(nextTime, time + lineData.duration + 0.05);
      if (currentTime + setUpAnimationEarlyTime >= time && currentTime < effectiveEndTime) {
        lineData.isSelected = true;

        const timeDelta = currentTime - time;
        const animationTimingOffset = (now - lineData.animationStartTimeMs) / 1000 - timeDelta;
        lineData.accumulatedOffsetMs = lineData.accumulatedOffsetMs / 1.08;
        lineData.accumulatedOffsetMs += animationTimingOffset * 1000 * 0.4;
        if (lineData.isAnimating && Math.abs(lineData.accumulatedOffsetMs) > 100 && isPlaying) {
          resetLineAnimations(lineData);
          lineData.isAnimating = false;
          // console.warn("[BLyrics-diag] DRIFT RESET", {
          //   accumulatedOffsetMs: lineData.accumulatedOffsetMs.toFixed(1),
          //   animationTimingOffset: (animationTimingOffset * 1000).toFixed(1),
          // });
        }

        if (isPlaying !== lineData.isAnimationPlayStatePlaying) {
          lineData.isAnimationPlayStatePlaying = isPlaying;
          setAnimationsPlayState(lineData, isPlaying);
          if (isPlaying) lineData.isAnimating = false; // reset the animation against current media time
        }

        if (!lineData.isAnimating) {
          // We'll take care of the animation setup in a batch later
          linesToAnimate.push(lineData);
        }
      } else {
        if (lineData.isSelected) {
          if (isPlaying || timeJumped) {
            startLineExitAnimations(lineData, animationConfig, currentTime);
            lineData.isAnimating = false;
          } else {
            setAnimationsPlayState(lineData, false);
            lineData.isAnimationPlayStatePlaying = false;
          }
          lineData.isSelected = false;
        }
      }
      return true;
    });

    if (linesToAnimate.length > 0) {
      for (const lineData of linesToAnimate) {
        startLineAnimations(lineData, animationConfig, currentTime, now);
        lineData.isAnimating = true;
        lineData.lastAnimSetupAt = now;
        lineData.isAnimationPlayStatePlaying = isPlaying;
        lineData.accumulatedOffsetMs = 0;
        if (!isPlaying) setAnimationsPlayState(lineData, false);
      }
    }

    if (animEngineState.scrollResumeTime < Date.now() || animEngineState.scrollPos === -1) {
      if (activeElems.length == 0) {
        activeElems.push(lyricData.lines[0]);
      }

      animEngineState.lastActiveElements = activeElems.filter(
        elm => lyricScrollTime >= elm.time // remove elements that haven't reached their scroll time yet.
      );

      // Offset so lyrics appear towards the center of the screen.
      const scrollPosOffset = tabRendererHeight * SCROLL_POS_OFFSET_RATIO.getNumberValue();

      let lastActiveLyric = activeElems[activeElems.length - 1];

      let lyricPositions: number[] = activeElems
        .filter((lineData, index) => {
          // Ignore lyrics close to finishing unless it last active lyric
          return (
            lyricScrollTime < lineData.time + lineData.duration - LYRIC_ENDING_THRESHOLD_S.getNumberValue() ||
            index == activeElems.length - 1
          );
        })
        // We subtract selectedLyricHeight / 2 to center the selected lyric line vertically within the offset region,
        // so the lyric is not aligned at the very top of the offset but is visually centered.
        .map(lyricData => lyricData.position + lyricData.height / 2);

      let avgPos =
        lyricPositions.reduce((accumulator, currentValue) => accumulator + currentValue, 0) / lyricPositions.length;

      // Base position
      let scrollPos = avgPos - scrollPosOffset;

      // Make sure the first selected line is stays visible
      scrollPos = Math.min(scrollPos, activeElems[0].position);

      // Make sure bottom of last active lyric is visible
      scrollPos = Math.max(scrollPos, lastActiveLyric.position - tabRendererHeight + lastActiveLyric.height);

      // Make sure top of last active lyric is visible.
      scrollPos = Math.min(scrollPos, lastActiveLyric.position);

      // Make sure we're not trying to scroll to negative values
      scrollPos = Math.max(0, scrollPos);

      if (ENABLE_DEBUG_RENDER.getBooleanValue()) {
        let transform = window.getComputedStyle(lyricsElement).transform;
        const matrix = new DOMMatrix(transform);
        let yTransform = matrix.f;
        let yTop = scrollTop - yTransform;
        resetDebugRender(yTop);
        if (ctx) {
          ctx.strokeStyle = "green";
          ctx.fillStyle = "green";
          ctx?.fillText("visible top", 0, scrollTop);
          ctx?.beginPath();
          ctx?.moveTo(40, scrollTop);
          ctx?.lineTo(1000, scrollTop);
          ctx.stroke();

          ctx.strokeStyle = "blue";
          ctx.fillStyle = "blue";
          ctx?.fillText("visible bottom", 0, scrollTop + tabRendererHeight);
          ctx?.beginPath();
          ctx?.moveTo(40, scrollTop + tabRendererHeight);
          ctx?.lineTo(1000, scrollTop + tabRendererHeight);
          ctx.stroke();

          ctx.strokeStyle = "yellow";
          ctx.fillStyle = "yellow";
          ctx?.fillText("target", 0, scrollTop + scrollPosOffset);
          ctx?.beginPath();
          ctx?.moveTo(40, scrollTop + scrollPosOffset);
          ctx?.lineTo(1000, scrollTop + scrollPosOffset);
          ctx.stroke();

          function debugLyrics(
            xOffset: number,
            name: string,
            activeElems: LineData[],
            lyricPositions: number[],
            lyricScrollTime: number
          ) {
            ctx!.strokeStyle = "red";
            ctx!.fillStyle = "red";
            ctx!.fillText(name, xOffset + 2, yTop + 45);
            ctx!.fillText("scroll time: " + lyricScrollTime.toFixed(3), xOffset + 2, yTop + 60);

            activeElems.forEach(elm => {
              let timeTillActive = elm.time - lyricScrollTime;
              let endTime = elm.time + elm.duration;
              let timeTillEnd = endTime - lyricScrollTime;
              if (timeTillEnd < LYRIC_ENDING_THRESHOLD_S.getNumberValue()) {
                ctx!.strokeStyle = "gray";
                ctx!.fillStyle = "gray";
              } else if (timeTillActive > 0) {
                ctx!.strokeStyle = "magenta";
                ctx!.fillStyle = "magenta";
              } else {
                ctx!.strokeStyle = "orange";
                ctx!.fillStyle = "orange";
              }

              ctx?.beginPath();
              ctx?.moveTo(xOffset + 5, elm.position);
              ctx?.lineTo(xOffset + 5, elm.position + elm.height);
              ctx?.stroke();
              ctx?.fillText(
                "time: start=" + elm.time.toFixed(2) + " end=" + endTime.toFixed(2),
                xOffset + 15,
                elm.position
              );
              ctx?.fillText("till active: " + timeTillActive.toFixed(2), xOffset + 15, elm.position + 15);
              ctx?.fillText("till end: " + timeTillEnd.toFixed(2), xOffset + 15, elm.position + 30);
            });

            ctx!.strokeStyle = "pink";
            ctx!.fillStyle = "pink";
            lyricPositions.forEach(lyricPosition => {
              ctx?.beginPath();
              ctx?.arc(xOffset + 5, lyricPosition, 5, 0, 2 * Math.PI, false);
              ctx?.fill();
            });
          }

          debugLyrics(0, "realtime", activeElems, lyricPositions, lyricScrollTime);
          debugLyrics(
            160,
            "last scroll",
            animEngineState.lastScrollDebugContext.activeElms,
            animEngineState.lastScrollDebugContext.centers,
            animEngineState.lastScrollDebugContext.lyricScrollTime
          );
        }
      }

      if (scrollTop === 0 && !animEngineState.doneFirstInstantScroll) {
        // For some reason when the panel is opened our pos is set to zero. This instant scrolls to the correct position
        // to avoid always scrolling from the top when the panel is opened.
        smoothScroll = false;
        animEngineState.doneFirstInstantScroll = true;
        animEngineState.nextScrollAllowedTime = 0;
      }

      if (animEngineState.wasUserScrolling || newLyricSelected || animEngineState.queuedScroll) {
        if (Date.now() > animEngineState.nextScrollAllowedTime) {
          animEngineState.queuedScroll = false;
          animEngineState.lastScrollDebugContext.lyricScrollTime = lyricScrollTime;
          animEngineState.lastScrollDebugContext.centers = lyricPositions;
          animEngineState.lastScrollDebugContext.activeElms = activeElems;

          if (smoothScroll && Math.abs(scrollTop - scrollPos) > 2) {
            if (animationConfig.enabled.scroll) {
              const scrollTime = animationConfig.scroll.durationMs;
              animateScrollOffset(lyricsElement, scrollTop, scrollPos, scrollTime, animationConfig.scroll.easing);
              animEngineState.nextScrollAllowedTime = scrollTime + Date.now() + 20;
            } else {
              scrollAnimation?.cancel();
              scrollAnimation = null;
              animEngineState.nextScrollAllowedTime = Date.now();
            }
          } else {
            scrollAnimation?.cancel();
            scrollAnimation = null;
          }

          scrollTop = scrollPos;
          animEngineState.scrollPos = scrollTop;
          tabRenderer.scrollTop = scrollTop;
          animEngineState.skipScrolls += 1;
          animEngineState.skipScrollsDecayTimes.push(Date.now() + 2000);
        } else if (
          animEngineState.nextScrollAllowedTime - Date.now() < QUEUE_SCROLL_THRESHOLD.getNumberValue() ||
          timeJumped
        ) {
          // just missed out on being able to scroll, queue this once we finish our current lyric
          animEngineState.queuedScroll = true;
        }
      }
    }

    if (animEngineState.wasUserScrolling && animEngineState.scrollResumeTime < Date.now()) {
      getResumeScrollElement().setAttribute("autoscroll-hidden", "true");
      lyricsElement.classList.remove(USER_SCROLLING_CLASS);
      animEngineState.wasUserScrolling = false;
    }

    decaySkipScrolls(now);
    // const frameTime = performance.now() - frameStart;
    // if (frameTime > 5) {
    //   console.warn("[BLyrics-diag] SLOW FRAME", { ms: frameTime.toFixed(1) });
    // }
  } catch (err) {
    if (!(err as Error).message?.includes("undefined")) {
      log(LYRICS_CHECK_INTERVAL_ERROR, err);
    }
  }
}

// -- Debounced Lyrics Update --------------------------

let pendingLyricsUpdate = false;

/**
 * Called when a new lyrics element is added to trigger re-sync.
 * Debounced via requestAnimationFrame to avoid O(n²) layout thrashing
 * when translations/romanizations load (each addition would otherwise
 * trigger calculateLyricPositions on ALL lines).
 */
export function lyricsElementAdded(): void {
  if (!AppState.areLyricsTicking || pendingLyricsUpdate) {
    return;
  }
  pendingLyricsUpdate = true;
  requestAnimationFrame(() => {
    pendingLyricsUpdate = false;
    calculateLyricPositions();
    animationEngine(
      animEngineState.lastTime,
      animEngineState.lastEventCreationTime,
      animEngineState.lastPlayState,
      false
    );
  });
}

/**
 * Gets or creates the resume autoscroll button element.
 *
 * @returns The resume scroll button element
 */
export function getResumeScrollElement(): HTMLElement {
  let elem = document.getElementById("autoscroll-resume-button");
  if (!elem) {
    const wrapper = document.createElement("div");
    wrapper.id = "autoscroll-resume-wrapper";
    wrapper.className = "autoscroll-resume-wrapper";
    elem = document.createElement("button");
    elem.id = "autoscroll-resume-button";
    elem.innerText = t("lyrics_resumeAutoscroll");
    elem.classList.add("autoscroll-resume-button");
    elem.setAttribute("autoscroll-hidden", "true");
    elem.addEventListener("click", () => {
      animEngineState.scrollResumeTime = 0;
      elem!.setAttribute("autoscroll-hidden", "true");
    });

    (document.querySelector("#side-panel > tp-yt-paper-tabs") as HTMLElement).after(wrapper);
    wrapper.appendChild(elem);
  }
  return elem as HTMLElement;
}

/**
 * Converts CSS duration value to milliseconds.
 *
 * @returns Duration in milliseconds
 */
export function toMs(cssDuration: string): number {
  if (!cssDuration) return 0;
  if (cssDuration.endsWith("ms")) {
    return parseFloat(cssDuration.slice(0, -2));
  } else if (cssDuration.endsWith("s")) {
    return parseFloat(cssDuration.slice(0, -1)) * 1000;
  }
  return 0;
}

/**
 * Forces a reflow/repaint of the element by accessing its offsetHeight.
 *
 * @param elt - Element to reflow
 */
export function reflow(elt: HTMLElement): void {
  void elt.offsetHeight;
}
