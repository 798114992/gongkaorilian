"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Question } from "./data/content";
import type { AudioTrack } from "./data/audio";

type Filter = string;
type PlaybackEngine = "audio" | "speech" | null;
const AUDIO_CACHE_NAME = "gongkao-audio-v3";

type SpeechCursor = {
  trackId: string;
  chunks: string[];
  chunkIndex: number;
  charIndex: number;
};

type ReviewAwareQuestion = Question & {
  due?: boolean;
  reviewDue?: boolean;
  nextReviewAt?: string | null;
  reviewDueAt?: string | null;
  next_review_at?: string | null;
};

type AudioHubProps = {
  active: boolean;
  tracks: AudioTrack[];
  wrongQuestions: Question[];
  notify: (message: string) => void;
  trackEvent: (eventName: string, eventData?: Record<string, unknown>) => void;
  authorizePlayback: (track: AudioTrack) => Promise<boolean>;
};

const builtInCategoryMeta: Record<string, { label: string; title: string; empty: string; color: string }> = {
  current: { label: "时政", title: "时政电台", empty: "月度热点、重要会议和新法解读会在这里更新。", color: "#245c92" },
  essay: { label: "申论", title: "申论晨读", empty: "人民日报评论拆解、规范表达和分主题金句会在这里更新。", color: "#e27f42" },
  wrong: { label: "错题", title: "错题语音朗读", empty: "完成行测后，个人错题会自动生成听练内容。", color: "#2f8067" },
};

// A stable session reference keeps due-ordering deterministic across re-renders.
const audioReviewReferenceTime = Date.now();

function trackSeriesId(track: AudioTrack) {
  return track.seriesId?.trim() || track.category || "other";
}

function managedAudioUrl(value: string | undefined) {
  if (!value?.startsWith("/api/app?")) return false;
  try {
    const url = new URL(value, "https://gongkao-rilian.invalid");
    return url.origin === "https://gongkao-rilian.invalid"
      && url.pathname === "/api/app"
      && Array.from(url.searchParams.keys()).length === 1
      && /^[0-9a-f-]{36}$/i.test(url.searchParams.get("media") ?? "");
  } catch { return false; }
}

function canCacheOffline(track: AudioTrack) {
  return track.accessLevel === "free" && managedAudioUrl(track.audioUrl);
}

const NEWS_MALE_VOICE = {
  id: "newsMale",
  label: "新闻男声",
  tone: "稳重磁性播报",
  pitch: 0.88,
  rateOffset: -0.03,
  preferredHints: ["yunyang", "kangkang", "yunxi", "male", "男"],
  avoidedHints: ["xiaoxiao", "xiaoyi", "huihui", "female", "女"],
};

function clampSpeechRate(rate: number) {
  return Math.max(0.75, Math.min(1.5, rate));
}

function pickNewsMaleVoice(voices: SpeechSynthesisVoice[]) {
  const chineseVoices = voices.filter((voice) => /zh|cmn|yue|中文|普通话|mandarin|chinese/i.test(`${voice.lang} ${voice.name}`));
  const candidates = chineseVoices.length ? chineseVoices : voices;
  const ranked = candidates
    .map((voice, index) => {
      const haystack = `${voice.name} ${voice.lang}`.toLowerCase();
      const preferredIndex = NEWS_MALE_VOICE.preferredHints.findIndex((hint) => haystack.includes(hint.toLowerCase()));
      const avoided = NEWS_MALE_VOICE.avoidedHints.some((hint) => haystack.includes(hint.toLowerCase()));
      return {
        voice,
        score: (preferredIndex >= 0 ? 100 - preferredIndex * 10 : 0) - (avoided ? 100 : 0) - index / 100,
      };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.voice ?? null;
}

function splitForSpeech(text: string) {
  const sentences = text.split(/(?<=[。！？；])/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if ((current + sentence).length > 180 && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

function speechProgress(cursor: SpeechCursor) {
  const total = cursor.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!total) return 0;
  const completed = cursor.chunks.slice(0, cursor.chunkIndex).reduce((sum, chunk) => sum + chunk.length, 0);
  return Math.min(99, Math.round(((completed + cursor.charIndex) / total) * 100));
}

function clampProgress(value: number) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function speechCursorFromProgress(trackId: string, chunks: string[], progress: number): SpeechCursor {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!total || !chunks.length) return { trackId, chunks, chunkIndex: 0, charIndex: 0 };
  const target = Math.min(total - 1, Math.floor(total * clampProgress(progress) / 100));
  let completed = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const nextCompleted = completed + chunks[chunkIndex].length;
    if (target < nextCompleted) {
      return { trackId, chunks, chunkIndex, charIndex: Math.max(0, target - completed) };
    }
    completed = nextCompleted;
  }
  const lastIndex = chunks.length - 1;
  return { trackId, chunks, chunkIndex: lastIndex, charIndex: Math.max(0, chunks[lastIndex].length - 1) };
}

function trackDurationSeconds(track: AudioTrack | undefined) {
  if (!track) return 0;
  const label = track.duration || "";
  const hours = Number(label.match(/(\d+(?:\.\d+)?)\s*(?:小时|时)/)?.[1] ?? 0);
  const minutes = Number(label.match(/(\d+(?:\.\d+)?)\s*分钟/)?.[1] ?? 0);
  const seconds = Number(label.match(/(\d+(?:\.\d+)?)\s*秒/)?.[1] ?? 0);
  const labeled = hours * 3600 + minutes * 60 + seconds;
  if (labeled > 0) return Math.round(labeled);
  const text = (track.text || track.description || "").trim();
  return text ? Math.max(30, Math.round(text.length / 3.5)) : 0;
}

function speechDurationSeconds(track: AudioTrack | undefined) {
  if (!track) return 0;
  const text = (track.text || track.description || "").trim();
  return text ? Math.max(30, Math.round(text.length / 3.5)) : trackDurationSeconds(track);
}

function formatPlaybackTime(value: number) {
  const seconds = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function reviewDueTimestamp(question: ReviewAwareQuestion) {
  const raw = question.nextReviewAt ?? question.reviewDueAt ?? question.next_review_at;
  const timestamp = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isReviewDue(question: ReviewAwareQuestion, now: number) {
  const dueAt = reviewDueTimestamp(question);
  return question.due === true || question.reviewDue === true || (dueAt !== null && dueAt <= now);
}

function subscribeOnlineStatus(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function readOnlineStatus() {
  return navigator.onLine;
}

function readServerOnlineStatus() {
  return true;
}

export default function AudioHub({ active, tracks: curatedTracks, wrongQuestions, notify, trackEvent, authorizePlayback }: AudioHubProps) {
  const wrongTracks = useMemo<AudioTrack[]>(() => {
    const now = audioReviewReferenceTime;
    const prioritized = wrongQuestions
      .map((question, originalIndex) => ({ question: question as ReviewAwareQuestion, originalIndex }))
      .sort((a, b) => {
        const dueDifference = Number(isReviewDue(b.question, now)) - Number(isReviewDue(a.question, now));
        if (dueDifference) return dueDifference;
        const aDueAt = reviewDueTimestamp(a.question) ?? Number.POSITIVE_INFINITY;
        const bDueAt = reviewDueTimestamp(b.question) ?? Number.POSITIVE_INFINITY;
        return aDueAt - bDueAt || a.originalIndex - b.originalIndex;
      });
    return prioritized.map(({ question }, index) => ({
      id: `wrong-${question.id}`,
      category: "wrong",
      title: `${question.module}错题：${question.knowledge}`,
      kicker: isReviewDue(question, now) ? "到期错题优先" : "错题语音朗读",
      source: "我的错题本",
      duration: "约1分钟",
      description: question.stem,
      seriesId: "wrong",
      seriesTitle: "错题语音朗读",
      seriesLabel: "错题",
      seriesColor: "#2f8067",
      sortOrder: 10_000 + index,
      text: `开始复习一道${question.module}错题。题目是：${question.stem}。选项分别是：${question.options.map((option, optionIndex) => `${String.fromCharCode(65 + optionIndex)}，${option}`).join("；")}。请先暂停十秒，独立回忆答案和解题思路，再继续播放。正确答案是${String.fromCharCode(65 + question.answer)}，${question.options[question.answer]}。解析：${question.explanation}。最后请复述本题考点和错误原因。`,
    }));
  }, [wrongQuestions]);

  const tracks = useMemo(() => [...curatedTracks, ...wrongTracks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)), [curatedTracks, wrongTracks]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState(curatedTracks[0]?.id ?? wrongTracks[0]?.id ?? "");
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [playbackEngine, setPlaybackEngine] = useState<PlaybackEngine>(null);
  const [progress, setProgress] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [totalSeconds, setTotalSeconds] = useState(0);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [cachedIds, setCachedIds] = useState<string[]>([]);
  const [speechFallbackIds, setSpeechFallbackIds] = useState<string[]>([]);
  const online = useSyncExternalStore(subscribeOnlineStatus, readOnlineStatus, readServerOnlineStatus);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sessionRef = useRef(0);
  const engineRef = useRef<PlaybackEngine>(null);
  const activeTrackRef = useRef<AudioTrack | null>(null);
  const speechCursorRef = useRef<SpeechCursor | null>(null);
  const speechNeedsRestartRef = useRef(false);
  const fallbackSessionRef = useRef<number | null>(null);
  const suppressAudioPauseRef = useRef(false);
  const audioPauseReasonRef = useRef("native_control");
  const objectUrlRef = useRef<string | null>(null);
  const speedRef = useRef(speed);
  const progressRef = useRef(progress);
  const seekPreviewRef = useRef<number | null>(null);
  const loopRef = useRef(loop);
  const speechFallbackIdsRef = useRef<string[]>([]);
  const speechVoicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const timerRef = useRef<number | null>(null);

  const emitAudioBehavior = useCallback((track: AudioTrack | null, action: string, extra?: Record<string, unknown>) => {
    if (!track) return;
    trackEvent("audio_play", {
      trackId: track.id,
      category: track.category,
      action,
      engine: engineRef.current,
      fixedAudio: Boolean(track.audioUrl),
      ...extra,
    });
  }, [trackEvent]);

  const emitPlaybackLifecycle = useCallback((eventName: "audio_pause" | "audio_close" | "audio_complete" | "audio_speed_change", track: AudioTrack | null, reason: string, extra?: Record<string, unknown>) => {
    if (!track) return;
    trackEvent(eventName, {
      trackId: track.id,
      category: track.category,
      reason,
      engine: engineRef.current,
      progress: progressRef.current,
      ...extra,
    });
  }, [trackEvent]);

  const revokeObjectUrl = useCallback(() => {
    if (!objectUrlRef.current) return;
    URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);

  const series = useMemo(() => {
    const map = new Map<string, { id: string; label: string; title: string; empty: string; color: string; icon: string; sortOrder: number }>();
    for (const track of tracks) {
      const id = trackSeriesId(track);
      if (map.has(id)) continue;
      const fallback = builtInCategoryMeta[track.category] ?? { label: "音频", title: "日练电台", empty: "栏目内容准备中。", color: "#6c7d8e" };
      map.set(id, {
        id,
        label: track.seriesLabel?.trim() || fallback.label,
        title: track.seriesTitle?.trim() || fallback.title,
        empty: fallback.empty,
        color: /^#[0-9a-f]{6}$/i.test(track.seriesColor ?? "") ? String(track.seriesColor) : fallback.color,
        icon: track.seriesIcon?.trim().slice(0, 2) || (track.seriesLabel?.trim() || fallback.label).slice(0, 1),
        sortOrder: track.sortOrder ?? 0,
      });
    }
    return Array.from(map.values()).sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
  }, [tracks]);
  const filterOptions = useMemo(() => [{ id: "all", label: "精选" }, ...series.map((item) => ({ id: item.id, label: item.title }))], [series]);
  const visibleTracks = useMemo(
    () => filter === "all" ? tracks : tracks.filter((track) => trackSeriesId(track) === filter),
    [filter, tracks],
  );
  const tracksBySeries = useMemo(() => new Map(series.map((item) => [item.id, tracks.filter((track) => trackSeriesId(track) === item.id)])), [series, tracks]);
  const selectedTrack = visibleTracks.find((track) => track.id === selectedId) ?? visibleTracks[0];

  useEffect(() => {
    speedRef.current = speed;
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    loopRef.current = loop;
    if (audioRef.current) audioRef.current.loop = loop;
  }, [loop]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return undefined;
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      speechVoicesRef.current = voices;
    };
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, []);

  const offlineCacheableIds = useMemo(() => curatedTracks.filter(canCacheOffline).map((track) => track.id).sort(), [curatedTracks]);
  const offlineCacheableKey = offlineCacheableIds.join("|");

  useEffect(() => {
    const audioElement = audioRef.current;
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
    if ("caches" in window) void caches.delete("gongkao-audio-v2");
    return () => {
      sessionRef.current += 1;
      engineRef.current = null;
      window.speechSynthesis?.cancel();
      audioElement?.pause();
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  useEffect(() => {
    const allowed = new Set(offlineCacheableKey.split("|").filter(Boolean));
    const cachedTimer = window.setTimeout(() => {
      let stored: string[] = [];
      try { stored = JSON.parse(window.localStorage.getItem("gkrl-cached-audio") ?? "[]") as string[]; }
      catch { stored = []; }
      const next = stored.filter((id) => allowed.has(id));
      setCachedIds(next);
      window.localStorage.setItem("gkrl-cached-audio", JSON.stringify(next));
    }, 0);
    return () => window.clearTimeout(cachedTimer);
  }, [offlineCacheableKey]);

  const stop = useCallback((message?: string, reason = "stop") => {
    const stoppedTrack = activeTrackRef.current;
    const stoppedEngine = engineRef.current;
    if (stoppedTrack && stoppedEngine) {
      const completionReasons = new Set(["timer_complete", "natural_complete"]);
      emitPlaybackLifecycle(completionReasons.has(reason) ? "audio_complete" : "audio_close", stoppedTrack, reason, { engine: stoppedEngine });
    }
    sessionRef.current += 1;
    engineRef.current = null;
    setPlaybackEngine(null);
    activeTrackRef.current = null;
    speechCursorRef.current = null;
    speechNeedsRestartRef.current = false;
    fallbackSessionRef.current = null;
    window.speechSynthesis?.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      try { audioRef.current.currentTime = 0; } catch { /* source may not be ready */ }
      audioRef.current.removeAttribute("src");
    }
    revokeObjectUrl();
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setPlaying(false);
    setPaused(false);
    setBuffering(false);
    setProgress(0);
    setElapsedSeconds(0);
    setTotalSeconds(0);
    seekPreviewRef.current = null;
    setSeekPreview(null);
    setSleepMinutes(0);
    if (message) notify(message);
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.metadata = null;
      for (const action of ["play", "pause", "stop", "seekbackward", "seekforward"] as const) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* unsupported action */ }
      }
    }
  }, [emitPlaybackLifecycle, notify, revokeObjectUrl]);

  const changeFilter = (nextFilter: Filter) => {
    if (nextFilter === filter) return;
    const nextTracks = nextFilter === "all" ? tracks : tracks.filter((track) => trackSeriesId(track) === nextFilter);
    stop();
    setFilter(nextFilter);
    setSelectedId(nextTracks[0]?.id ?? "");
  };

  const markSpeechFallback = useCallback((trackId: string) => {
    const next = Array.from(new Set([...speechFallbackIdsRef.current, trackId]));
    speechFallbackIdsRef.current = next;
    setSpeechFallbackIds(next);
  }, []);

  const clearSpeechFallback = useCallback((trackId: string) => {
    const next = speechFallbackIdsRef.current.filter((id) => id !== trackId);
    speechFallbackIdsRef.current = next;
    setSpeechFallbackIds(next);
  }, []);

  const startSpeech = useCallback((track: AudioTrack, preservePosition = false) => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      engineRef.current = null;
      setPlaybackEngine(null);
      activeTrackRef.current = null;
      setPlaying(false);
      setPaused(false);
      setBuffering(false);
      notify("当前设备暂不支持系统朗读，请更换设备或浏览器后重试");
      return;
    }
    const text = (typeof track.text === "string" ? track.text.trim() : "")
      || (typeof track.description === "string" ? track.description.trim() : "");
    if (!text) {
      engineRef.current = null;
      setPlaybackEngine(null);
      activeTrackRef.current = null;
      setPlaying(false);
      setPaused(false);
      setBuffering(false);
      notify("该节目暂缺音频与朗读文本，请稍后再试");
      return;
    }
    const previous = preservePosition && speechCursorRef.current?.trackId === track.id ? speechCursorRef.current : null;
    const chunks = splitForSpeech(text);
    const timelineDuration = speechDurationSeconds(track);
    const firstChunkIndex = previous ? Math.min(previous.chunkIndex, chunks.length - 1) : 0;
    const firstCharIndex = previous ? Math.min(previous.charIndex, Math.max(0, chunks[firstChunkIndex].length - 1)) : 0;
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    window.speechSynthesis.cancel();
    engineRef.current = "speech";
    setPlaybackEngine("speech");
    activeTrackRef.current = track;
    speechNeedsRestartRef.current = false;
    const speakChunk = (index: number, charIndex = 0) => {
      if (sessionRef.current !== session) return;
      if (index >= chunks.length) {
        if (loopRef.current) {
          speechCursorRef.current = { trackId: track.id, chunks, chunkIndex: 0, charIndex: 0 };
          setProgress(0);
          setElapsedSeconds(0);
          speakChunk(0, 0);
        } else {
          emitPlaybackLifecycle("audio_complete", track, "natural_complete", { engine: "speech", progress: 100 });
          engineRef.current = null;
          setPlaybackEngine(null);
          activeTrackRef.current = null;
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = null;
          setSleepMinutes(0);
          setPlaying(false);
          setPaused(false);
          setBuffering(false);
          setProgress(100);
          setElapsedSeconds(timelineDuration);
          if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
        }
        return;
      }
      const currentChunk = chunks[index];
      const safeCharIndex = Math.min(charIndex, Math.max(0, currentChunk.length - 1));
      const cursor: SpeechCursor = { trackId: track.id, chunks, chunkIndex: index, charIndex: safeCharIndex };
      speechCursorRef.current = cursor;
      const utterance = new SpeechSynthesisUtterance(currentChunk.slice(safeCharIndex));
      const voice = pickNewsMaleVoice(
        speechVoicesRef.current.length ? speechVoicesRef.current : window.speechSynthesis.getVoices(),
      );
      utterance.lang = "zh-CN";
      utterance.rate = clampSpeechRate(speedRef.current + NEWS_MALE_VOICE.rateOffset);
      utterance.pitch = NEWS_MALE_VOICE.pitch;
      if (voice) utterance.voice = voice;
      utterance.onstart = () => {
        if (sessionRef.current === session) setBuffering(false);
      };
      utterance.onboundary = (event) => {
        if (sessionRef.current !== session || speechCursorRef.current?.trackId !== track.id) return;
        speechCursorRef.current.charIndex = Math.min(currentChunk.length, safeCharIndex + event.charIndex);
        const nextProgress = speechProgress(speechCursorRef.current);
        setProgress(nextProgress);
        setElapsedSeconds(timelineDuration * nextProgress / 100);
      };
      utterance.onend = () => {
        if (sessionRef.current !== session) return;
        speechCursorRef.current = { trackId: track.id, chunks, chunkIndex: index + 1, charIndex: 0 };
        const nextProgress = index + 1 >= chunks.length ? 100 : speechProgress(speechCursorRef.current);
        setProgress(nextProgress);
        setElapsedSeconds(timelineDuration * nextProgress / 100);
        speakChunk(index + 1, 0);
      };
      utterance.onerror = () => {
        if (sessionRef.current === session) {
          engineRef.current = null;
          setPlaybackEngine(null);
          activeTrackRef.current = null;
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = null;
          setSleepMinutes(0);
          setPlaying(false);
          setPaused(false);
          setBuffering(false);
          notify("系统朗读启动失败，请检查媒体音量，或换用支持中文语音的浏览器");
        }
      };
      window.speechSynthesis.speak(utterance);
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    };
    setPlaying(true);
    setPaused(false);
    setBuffering(false);
    const initialProgress = previous ? speechProgress({ trackId: track.id, chunks, chunkIndex: firstChunkIndex, charIndex: firstCharIndex }) : 0;
    setProgress(initialProgress);
    setElapsedSeconds(timelineDuration * initialProgress / 100);
    setTotalSeconds(timelineDuration);
    if (!preservePosition) {
      emitAudioBehavior(track, "start", {
        engine: "speech",
        fallbackFromFixedAudio: Boolean(track.audioUrl),
        speed: speedRef.current,
        voicePreset: NEWS_MALE_VOICE.id,
        loop: loopRef.current,
      });
    }
    speakChunk(firstChunkIndex, firstCharIndex);
  }, [emitAudioBehavior, emitPlaybackLifecycle, notify]);

  const updateMediaSession = useCallback((track: AudioTrack) => {
    if (!("mediaSession" in navigator) || !("MediaMetadata" in window)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: "公考日练 · 日练电台",
      album: track.kicker,
    });
    const setAction = (action: "play" | "pause" | "stop" | "seekbackward" | "seekforward", handler: () => void) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* action is optional on some WebViews */ }
    };
    setAction("play", () => {
      const currentTrack = activeTrackRef.current ?? track;
      const shouldUseSpeech = engineRef.current === "speech"
        || (engineRef.current === null && (!currentTrack.audioUrl || speechFallbackIdsRef.current.includes(currentTrack.id)));
      if (shouldUseSpeech) {
        if (engineRef.current === "speech" && speechNeedsRestartRef.current) startSpeech(currentTrack, true);
        else if (engineRef.current === "speech") window.speechSynthesis?.resume();
        else startSpeech(currentTrack, false);
      } else {
        const audio = audioRef.current;
        if (!audio) return;
        const resumingExistingAudio = engineRef.current === "audio";
        if (audio.ended) audio.currentTime = 0;
        engineRef.current = "audio";
        activeTrackRef.current = currentTrack;
        setPlaybackEngine("audio");
        void audio.play().then(() => {
          if (!resumingExistingAudio) emitAudioBehavior(currentTrack, "start", { engine: "audio", source: "media_session" });
        }).catch(() => notify("系统播放控制未能恢复音频，请回到页面点击播放"));
      }
      setPlaying(true);
      setPaused(false);
      setBuffering(false);
      navigator.mediaSession.playbackState = "playing";
    });
    setAction("pause", () => {
      const currentTrack = activeTrackRef.current ?? track;
      const currentEngine = engineRef.current;
      if (!currentEngine) return;
      if (currentEngine === "speech") window.speechSynthesis?.pause();
      else {
        audioPauseReasonRef.current = "media_session";
        audioRef.current?.pause();
      }
      setPaused(true);
      setBuffering(false);
      if (currentEngine === "speech") emitPlaybackLifecycle("audio_pause", currentTrack, "media_session", { engine: currentEngine });
      navigator.mediaSession.playbackState = "paused";
    });
    setAction("stop", () => stop(undefined, "media_stop"));
    setAction("seekbackward", () => {
      if (engineRef.current === "audio" && audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 15);
    });
    setAction("seekforward", () => {
      if (engineRef.current === "audio" && audioRef.current) audioRef.current.currentTime = Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + 15);
    });
    navigator.mediaSession.playbackState = engineRef.current ? "playing" : "none";
  }, [emitAudioBehavior, emitPlaybackLifecycle, notify, startSpeech, stop]);

  const cachedAudioSource = useCallback(async (track: AudioTrack) => {
    if (!canCacheOffline(track) || !track.audioUrl || !("caches" in window)) return null;
    const cache = await caches.open(AUDIO_CACHE_NAME);
    const request = new Request(new URL(track.audioUrl, window.location.origin).toString());
    const response = await cache.match(request);
    if (!response) return null;
    const blob = await response.blob();
    if (!blob.size) return null;
    revokeObjectUrl();
    const objectUrl = URL.createObjectURL(blob);
    objectUrlRef.current = objectUrl;
    return objectUrl;
  }, [revokeObjectUrl]);

  const fallbackToSpeech = useCallback((track: AudioTrack, expectedSession: number, reason: "load" | "offline" | "timeout") => {
    if (sessionRef.current !== expectedSession || fallbackSessionRef.current === expectedSession) return;
    fallbackSessionRef.current = expectedSession;
    if (audioRef.current && !audioRef.current.paused) {
      suppressAudioPauseRef.current = true;
      audioRef.current.pause();
    }
    markSpeechFallback(track.id);
    notify(reason === "offline"
      ? "当前未找到可用的离线音频，已切换为系统朗读"
      : "录制音频未能播放，已自动切换为系统朗读");
    startSpeech(track, false);
    updateMediaSession(track);
  }, [markSpeechFallback, notify, startSpeech, updateMediaSession]);

  const start = useCallback(async (track: AudioTrack) => {
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    const cachedFreePlayback = !online && canCacheOffline(track) && cachedIds.includes(track.id);
    const authorized = cachedFreePlayback || await authorizePlayback(track);
    if (sessionRef.current !== session) return;
    if (!authorized) {
      setPlaying(false);
      setPaused(false);
      setBuffering(false);
      engineRef.current = null;
      setPlaybackEngine(null);
      return;
    }
    if (activeTrackRef.current && activeTrackRef.current.id !== track.id && engineRef.current) {
      emitPlaybackLifecycle("audio_close", activeTrackRef.current, "switch", { engine: engineRef.current });
    }
    fallbackSessionRef.current = null;
    const preferSpeechFallback = Boolean(track.audioUrl && speechFallbackIdsRef.current.includes(track.id));
    window.speechSynthesis?.cancel();
    if (audioRef.current && !audioRef.current.paused) {
      suppressAudioPauseRef.current = true;
      audioRef.current.pause();
    }
    revokeObjectUrl();
    activeTrackRef.current = track;
    setSelectedId(track.id);
    setProgress(0);
    setElapsedSeconds(0);
    setTotalSeconds(trackDurationSeconds(track));
    seekPreviewRef.current = null;
    setSeekPreview(null);
    setPlaying(true);
    setPaused(false);
    setBuffering(Boolean(track.audioUrl && !preferSpeechFallback));
    engineRef.current = track.audioUrl && !preferSpeechFallback ? "audio" : "speech";
    setPlaybackEngine(track.audioUrl && !preferSpeechFallback ? "audio" : "speech");
    if (!track.audioUrl || preferSpeechFallback) {
      startSpeech(track);
      updateMediaSession(track);
      return;
    }
    const audio = audioRef.current;
    if (!audio) {
      setPlaying(false);
      setBuffering(false);
      engineRef.current = null;
      setPlaybackEngine(null);
      notify("播放器初始化失败，请刷新页面后重试");
      return;
    }
    let source: string | null = track.audioUrl;
    if (!online) {
      source = cachedIds.includes(track.id) ? await cachedAudioSource(track) : null;
      if (sessionRef.current !== session) return;
      if (!source) {
        fallbackToSpeech(track, session, "offline");
        return;
      }
    }
    clearSpeechFallback(track.id);
    audio.src = source;
    audio.playbackRate = speedRef.current;
    audio.loop = loopRef.current;
    audio.load();
    let timeoutId: number | null = null;
    try {
      await Promise.race([
        audio.play(),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error("audio-start-timeout")), 8_000);
        }),
      ]);
      if (sessionRef.current !== session) return;
      if (timeoutId) window.clearTimeout(timeoutId);
      setPlaying(true);
      setPaused(false);
      setBuffering(false);
      updateMediaSession(track);
      emitAudioBehavior(track, "start", {
        engine: "audio",
        speed: speedRef.current,
        loop: loopRef.current,
        offlineCache: !online,
      });
    } catch (error) {
      if (timeoutId) window.clearTimeout(timeoutId);
      if (sessionRef.current !== session) return;
      fallbackToSpeech(track, session, error instanceof Error && error.message === "audio-start-timeout" ? "timeout" : "load");
    }
  }, [authorizePlayback, cachedAudioSource, cachedIds, clearSpeechFallback, emitAudioBehavior, emitPlaybackLifecycle, fallbackToSpeech, notify, online, revokeObjectUrl, startSpeech, updateMediaSession]);

  const togglePlayback = () => {
    if (!selectedTrack) return;
    if (buffering && engineRef.current === "audio") {
      stop(undefined, "cancel_buffering");
      return;
    }
    if (!playing) return void start(selectedTrack);
    if (engineRef.current === "audio") {
      if (paused) {
        setBuffering(true);
        const session = sessionRef.current;
        void audioRef.current?.play().then(() => {
          if (sessionRef.current !== session) return;
          setBuffering(false);
          setPaused(false);
          if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
        }).catch(() => fallbackToSpeech(selectedTrack, session, "load"));
        setPaused(false);
      } else {
        audioPauseReasonRef.current = "control";
        audioRef.current?.pause();
        setPaused(true);
        setBuffering(false);
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
      }
      return;
    }
    if (paused) {
      if (speechNeedsRestartRef.current) startSpeech(selectedTrack, true);
      else window.speechSynthesis.resume();
      setPaused(false);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    } else {
      window.speechSynthesis.pause();
      setPaused(true);
      emitPlaybackLifecycle("audio_pause", selectedTrack, "control", { engine: "speech" });
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    }
  };

  const changeSpeed = (nextSpeed: number) => {
    const safeSpeed = clampSpeechRate(nextSpeed);
    const previousSpeed = speedRef.current;
    speedRef.current = safeSpeed;
    setSpeed(safeSpeed);
    if (audioRef.current) audioRef.current.playbackRate = safeSpeed;
    if (selectedTrack && engineRef.current) emitPlaybackLifecycle("audio_speed_change", selectedTrack, "control", { previousSpeed, speed: safeSpeed });
    if (playing && selectedTrack && engineRef.current === "speech") {
      if (paused) {
        sessionRef.current += 1;
        window.speechSynthesis.cancel();
        speechNeedsRestartRef.current = true;
      } else startSpeech(selectedTrack, true);
    }
  };

  const toggleLoop = () => {
    const next = !loop;
    loopRef.current = next;
    setLoop(next);
    if (audioRef.current) audioRef.current.loop = next;
  };

  const setSleepTimer = (minutes: number) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setSleepMinutes(minutes);
    if (!minutes) return notify("定时关闭已取消");
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      stop("定时播放已结束", "timer_complete");
    }, minutes * 60 * 1000);
    notify(`将在 ${minutes} 分钟后停止播放`);
  };

  const cacheTrack = async (track: AudioTrack) => {
    if (!track.audioUrl) return notify("系统朗读使用当前设备语音，无需缓存音频");
    if (!canCacheOffline(track)) return notify("该节目需在线收听；免费试听音频支持离线缓存");
    if (!("caches" in window)) return notify("当前浏览器暂不支持离线缓存");
    try {
      const cache = await caches.open(AUDIO_CACHE_NAME);
      const request = new Request(new URL(track.audioUrl, window.location.origin).toString());
      const response = await fetch(request);
      if (!response.ok && response.type !== "opaque") throw new Error("audio fetch failed");
      await cache.put(request, response.clone());
      const next = Array.from(new Set([...cachedIds, track.id]));
      setCachedIds(next);
      window.localStorage.setItem("gkrl-cached-audio", JSON.stringify(next));
      clearSpeechFallback(track.id);
      trackEvent("audio_cached", { trackId: track.id, category: track.category, action: "complete" });
      notify("音频已缓存，可在离线状态下收听");
    } catch {
      notify("离线缓存失败，请检查网络和浏览器存储权限");
    }
  };

  const playTrackFromButton = (event: React.MouseEvent<HTMLButtonElement>) => {
    const track = tracks.find((item) => item.id === event.currentTarget.dataset.trackId);
    if (!track) return;
    if (track.id === selectedTrack?.id && (playing || paused || buffering)) togglePlayback();
    else void start(track);
  };

  const selectTrackFromButton = (event: React.MouseEvent<HTMLButtonElement>) => {
    const id = event.currentTarget.dataset.trackId;
    if (!id || id === selectedId) return;
    stop(undefined, "switch");
    setSelectedId(id);
  };

  const updateAudioProgress = () => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const nextProgress = Math.round((audio.currentTime / audio.duration) * 100);
    setProgress(nextProgress);
    setElapsedSeconds(audio.currentTime);
    setTotalSeconds(audio.duration);
    if ("mediaSession" in navigator && "setPositionState" in navigator.mediaSession) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: audio.currentTime }); } catch { /* unsupported transient state */ }
    }
  };

  const previewSeek = (value: number) => {
    const nextProgress = clampProgress(value);
    seekPreviewRef.current = nextProgress;
    setSeekPreview(nextProgress);
  };

  const commitSeek = (value = seekPreviewRef.current) => {
    if (!selectedTrack || value === null) return;
    const nextProgress = clampProgress(value);
    seekPreviewRef.current = null;
    setSeekPreview(null);
    progressRef.current = nextProgress;
    setProgress(nextProgress);
    const fallbackDuration = totalSeconds || trackDurationSeconds(selectedTrack);
    setElapsedSeconds(fallbackDuration * nextProgress / 100);
    trackEvent("audio_seek", {
      trackId: selectedTrack.id,
      category: selectedTrack.category,
      engine: engineRef.current,
      progress: nextProgress,
    });

    if (engineRef.current === "audio" && audioRef.current && Number.isFinite(audioRef.current.duration) && audioRef.current.duration > 0) {
      audioRef.current.currentTime = audioRef.current.duration * nextProgress / 100;
      updateAudioProgress();
      return;
    }

    if (engineRef.current !== "speech") return;
    const text = (selectedTrack.text || selectedTrack.description || "").trim();
    if (!text) return;
    const chunks = splitForSpeech(text);
    speechCursorRef.current = speechCursorFromProgress(selectedTrack.id, chunks, nextProgress);
    sessionRef.current += 1;
    window.speechSynthesis.cancel();
    if (paused) {
      speechNeedsRestartRef.current = true;
      setBuffering(false);
    } else {
      startSpeech(selectedTrack, true);
    }
  };

  const finishSeek = (value?: number) => {
    if (seekPreviewRef.current === null) return;
    commitSeek(typeof value === "number" ? value : seekPreviewRef.current);
  };

  const handleAudioError = () => {
    const track = activeTrackRef.current;
    const session = sessionRef.current;
    if (!track?.audioUrl || engineRef.current !== "audio") return;
    fallbackToSpeech(track, session, "load");
  };

  const miniPlayerVisible = Boolean(selectedTrack && (playing || paused));
  const playbackStatus = buffering ? "正在缓冲" : playing ? (paused ? "已暂停" : "正在播放") : progress >= 100 ? "播放完成" : "待播放";
  const selectedUsesSpeech = Boolean(selectedTrack && (playbackEngine === "speech" || !selectedTrack.audioUrl || speechFallbackIds.includes(selectedTrack.id)));
  const displayedProgress = seekPreview ?? progress;
  const displayedTotalSeconds = totalSeconds || trackDurationSeconds(selectedTrack);
  const displayedElapsedSeconds = seekPreview === null
    ? elapsedSeconds
    : displayedTotalSeconds * displayedProgress / 100;
  const timelineLabel = `${formatPlaybackTime(displayedElapsedSeconds)} / ${selectedUsesSpeech ? "约" : ""}${formatPlaybackTime(displayedTotalSeconds)}`;
  const seekDisabled = buffering || (!playing && !paused);
  const seekStyle = { "--seek-progress": `${displayedProgress}%` } as React.CSSProperties;

  return (
    <>
    <div className={`page-content subpage audio-page ${active ? "" : "is-hidden"}`} aria-hidden={!active}>
      <div className="subpage-heading audio-heading">
        <div><span>日练电台</span><h1>通勤听练</h1><p>可收听时政热点、申论表达和个人错题。</p></div>
        <span className={`network-badge ${online ? "" : "offline"}`}>{online ? "在线" : "离线模式"}</span>
      </div>

      {selectedTrack ? (
        <section className="audio-hero">
          <div className="audio-live"><i /> {selectedUsesSpeech ? "系统朗读 · 锁屏播放以设备支持为准" : "录制音频 · 锁屏播放以设备支持为准"}</div>
          <h2>{selectedTrack.title}</h2>
          <p>{selectedTrack.description}</p>
          <div className={`waveform ${playing && !paused ? "playing" : ""}`} aria-hidden="true">
            {Array.from({ length: 22 }).map((_, index) => <i key={index} style={{ "--bar": `${16 + (index * 13) % 34}px`, animationDelay: `-${index * 37}ms` } as React.CSSProperties} />)}
          </div>
          <button onClick={togglePlayback}>{buffering ? "× 取消加载" : playing && !paused ? "Ⅱ 暂停播放" : paused ? "▶ 继续播放" : "▶ 开始收听"}</button>
          <small className="audio-voice-tip">{selectedUsesSpeech ? `${NEWS_MALE_VOICE.label} · ${NEWS_MALE_VOICE.tone}；实际效果以当前设备支持为准` : "录制音频保留原声；播放受限时将自动切换为新闻男声朗读"}</small>
          {selectedTrack.category === "wrong" && <small className="audio-recall-tip">听到“暂停十秒”时先独立作答，再继续听答案。</small>}
        </section>
      ) : null}

      <div className="audio-filters" aria-label="音频分类">
        {filterOptions.map((option) => <button key={option.id} className={filter === option.id ? "active" : ""} onClick={() => changeFilter(option.id)}>{option.label}</button>)}
      </div>

      {filter === "all" ? (
        <section className="audio-category-board" aria-label="音频精选分类">
          {series.map((item) => {
            const categoryTracks = tracksBySeries.get(item.id) ?? [];
            const hasCacheableAudio = categoryTracks.some(canCacheOffline);
            return (
              <article className={`audio-category-card ${item.id === "current" || item.id === "essay" || item.id === "wrong" ? item.id : "dynamic"}`} style={{ "--series-color": item.color } as React.CSSProperties} key={item.id}>
                <header><span>{item.icon}</span><div><h3>{item.title}</h3><p>{categoryTracks.length ? `${categoryTracks.length} 个节目 · 支持倍速、循环${hasCacheableAudio ? "和离线缓存" : ""}` : item.empty}</p></div></header>
                <div>
                  {categoryTracks.slice(0, 2).map((track) => {
                    const selected = selectedTrack?.id === track.id;
                    return <button className={selected ? "selected" : ""} data-track-id={track.id} onClick={selectTrackFromButton} key={track.id}><b>{track.title}</b><small>{track.kicker} · {track.duration}</small></button>;
                  })}
                  {!categoryTracks.length && <small className="category-empty">{item.empty}</small>}
                </div>
              </article>
            );
          })}
          {!series.length && <div className="audio-empty"><span>台</span><div><h3>暂无已发布栏目</h3><p>内容更新后将显示在此处。</p></div></div>}
        </section>
      ) : (
        <section className="audio-list" aria-label="音频节目列表">
          {visibleTracks.length === 0 ? (
            filter === "wrong" ? (
              <div className="audio-empty"><span>错</span><div><h3>暂无错题朗读内容</h3><p>系统将根据错题的题干、答案和解析生成朗读内容，并优先展示到期复习题。</p></div></div>
            ) : (
              <div className="audio-empty"><span>新</span><div><h3>本栏目内容准备中</h3><p>新的时政与申论音频会按内容计划陆续更新。</p></div></div>
            )
          ) : visibleTracks.map((track) => {
            const selected = selectedTrack?.id === track.id;
            const cacheable = canCacheOffline(track);
            const cached = cacheable && cachedIds.includes(track.id);
            return (
              <article className={`audio-track ${selected ? "selected" : ""}`} key={track.id}>
                <button className="track-play" data-track-id={track.id} onClick={playTrackFromButton} aria-label={`播放${track.title}`}>{selected && playing && !paused ? "Ⅱ" : "▶"}</button>
                <button className="track-copy" data-track-id={track.id} onClick={selectTrackFromButton}>
                  <span>{track.kicker}{track.audioUrl && !speechFallbackIds.includes(track.id) ? " · 录制音频" : " · 系统朗读"}</span><h3>{track.title}</h3><p>{track.source} · {track.duration}</p>
                </button>
                <button className={`cache-button ${cached ? "cached" : ""}`} disabled={!cacheable} onClick={() => void cacheTrack(track)} aria-label={cacheable ? `离线缓存${track.title}` : track.audioUrl ? `${track.title}需在线收听` : `${track.title}使用系统朗读，无需缓存音频`}>{cacheable ? (cached ? "✓ 已缓存" : "↓ 缓存") : track.audioUrl ? "在线收听" : "系统朗读"}</button>
              </article>
            );
          })}
        </section>
      )}

      {selectedTrack ? (
        <section className="audio-player" aria-label="播放控制器">
          <audio
            ref={audioRef}
            className="native-audio-control"
            preload="metadata"
            controls={Boolean(selectedTrack.audioUrl && !selectedUsesSpeech)}
            controlsList="nodownload"
            onError={handleAudioError}
            onLoadStart={() => { if (engineRef.current === "audio") setBuffering(true); }}
            onCanPlay={() => { if (engineRef.current === "audio") setBuffering(false); }}
            onWaiting={() => { if (engineRef.current === "audio") setBuffering(true); }}
            onLoadedMetadata={updateAudioProgress}
            onDurationChange={updateAudioProgress}
            onPlaying={() => { if (engineRef.current === "audio") { setPlaying(true); setPaused(false); setBuffering(false); updateMediaSession(selectedTrack); } }}
            onPause={() => {
              if (suppressAudioPauseRef.current) {
                suppressAudioPauseRef.current = false;
                audioPauseReasonRef.current = "native_control";
                return;
              }
              if (engineRef.current === "audio" && playing && !audioRef.current?.ended) {
                const reason = audioPauseReasonRef.current;
                audioPauseReasonRef.current = "native_control";
                setPaused(true);
                setBuffering(false);
                emitPlaybackLifecycle("audio_pause", activeTrackRef.current ?? selectedTrack, reason, { engine: "audio" });
                if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
              }
            }}
            onTimeUpdate={updateAudioProgress}
            onEnded={() => { if (!loopRef.current) { emitPlaybackLifecycle("audio_complete", selectedTrack, "natural_complete", { engine: "audio", progress: 100 }); engineRef.current = null; activeTrackRef.current = null; if (timerRef.current) window.clearTimeout(timerRef.current); timerRef.current = null; setSleepMinutes(0); setPlaybackEngine(null); setPlaying(false); setPaused(false); setBuffering(false); setProgress(100); setElapsedSeconds(totalSeconds || audioRef.current?.duration || 0); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none"; } }}
          />
          <div className="player-top"><div><span>{playbackStatus}</span><h3>{selectedTrack.title}</h3></div><button onClick={() => stop(undefined, "stop")} disabled={!playing && !paused}>停止</button></div>
          <div className="audio-progress-row">
            <input
              className="audio-seek"
              type="range"
              min={0}
              max={100}
              step={0.1}
              value={displayedProgress}
              disabled={seekDisabled}
              style={seekStyle}
              aria-label="播放进度"
              aria-valuetext={timelineLabel}
              onChange={(event) => previewSeek(Number(event.target.value))}
              onPointerUp={(event) => finishSeek(Number(event.currentTarget.value))}
              onPointerCancel={(event) => finishSeek(Number(event.currentTarget.value))}
              onTouchEnd={(event) => finishSeek(Number(event.currentTarget.value))}
              onMouseUp={(event) => finishSeek(Number(event.currentTarget.value))}
              onKeyUp={(event) => finishSeek(Number(event.currentTarget.value))}
              onBlur={(event) => finishSeek(Number(event.currentTarget.value))}
            />
            <time>{timelineLabel}</time>
          </div>
          <div className="player-controls">
            <button className={loop ? "active" : ""} aria-pressed={loop} onClick={toggleLoop}>↻ {loop ? "循环中" : "循环"}</button>
            <label>倍速<select aria-label="播放倍速" value={speed} onChange={(event) => changeSpeed(Number(event.target.value))}><option value={0.75}>0.75×</option><option value={1}>1.0×</option><option value={1.25}>1.25×</option><option value={1.5}>1.5×</option></select></label>
            <label>定时<select aria-label="定时关闭" value={sleepMinutes} onChange={(event) => setSleepTimer(Number(event.target.value))}><option value={0}>关闭</option><option value={10}>10分钟</option><option value={20}>20分钟</option><option value={30}>30分钟</option><option value={60}>60分钟</option></select></label>
            <button className="player-main" onClick={togglePlayback} aria-label={buffering ? "取消加载" : playing && !paused ? "暂停" : "播放"}>{buffering ? "×" : playing && !paused ? "Ⅱ" : "▶"}</button>
          </div>
        </section>
      ) : null}
    </div>
    {selectedTrack && miniPlayerVisible && (
      <section className={`audio-floating-player ${paused ? "paused" : "playing"}`} aria-label="底部播放控制">
        <div className="audio-floating-copy">
          <span>{buffering ? "正在缓冲" : paused ? "已暂停" : "正在播放"}</span>
          <b>{selectedTrack.title}</b>
          <div className="audio-floating-timeline">
            <input
              className="audio-seek audio-floating-progress"
              type="range"
              min={0}
              max={100}
              step={0.1}
              value={displayedProgress}
              disabled={seekDisabled}
              style={seekStyle}
              aria-label="悬浮播放器进度"
              aria-valuetext={timelineLabel}
              onChange={(event) => previewSeek(Number(event.target.value))}
              onPointerUp={(event) => finishSeek(Number(event.currentTarget.value))}
              onPointerCancel={(event) => finishSeek(Number(event.currentTarget.value))}
              onTouchEnd={(event) => finishSeek(Number(event.currentTarget.value))}
              onMouseUp={(event) => finishSeek(Number(event.currentTarget.value))}
              onKeyUp={(event) => finishSeek(Number(event.currentTarget.value))}
              onBlur={(event) => finishSeek(Number(event.currentTarget.value))}
            />
            <time>{timelineLabel}</time>
          </div>
        </div>
        <button className="audio-mini-toggle" onClick={togglePlayback}>{buffering ? "取消" : paused ? "继续" : "暂停"}</button>
        <button className="audio-mini-close" onClick={() => stop("已关闭播放", "close")} aria-label={`关闭播放${selectedTrack.title}`}>×</button>
      </section>
    )}
    </>
  );
}
