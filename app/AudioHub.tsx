"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Question } from "./data/content";
import type { AudioTrack } from "./data/audio";

type Filter = string;
type VoicePreset = "newsMale" | "newsFemale" | "youngMale" | "youngFemale";
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
};

const builtInCategoryMeta: Record<string, { label: string; title: string; empty: string; color: string }> = {
  current: { label: "时政", title: "时政电台", empty: "月度热点、重要会议和新法解读会在这里更新。", color: "#245c92" },
  essay: { label: "申论", title: "申论晨读", empty: "人民日报评论拆解、规范表达和分主题金句会在这里更新。", color: "#e27f42" },
  wrong: { label: "错题", title: "错题语音朗读", empty: "完成行测后，真实错题会自动生成听练内容。", color: "#2f8067" },
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

const voiceOptions: Array<{ id: VoicePreset; label: string; tone: string; pitch: number; rateOffset: number; hints: string[] }> = [
  { id: "newsMale", label: "新闻男", tone: "稳重播报", pitch: 0.82, rateOffset: -0.04, hints: ["yunyang", "yunxi", "kangkang", "male", "男"] },
  { id: "newsFemale", label: "新闻女", tone: "清晰播报", pitch: 1.02, rateOffset: -0.02, hints: ["xiaoxiao", "xiaoyi", "huihui", "female", "女"] },
  { id: "youngMale", label: "青年男", tone: "轻快讲解", pitch: 0.94, rateOffset: 0.03, hints: ["yunxi", "yunyang", "male", "男"] },
  { id: "youngFemale", label: "青年女", tone: "亲和带练", pitch: 1.14, rateOffset: 0.04, hints: ["xiaoyi", "xiaoxiao", "female", "女"] },
];

function getVoiceOption(id: VoicePreset) {
  return voiceOptions.find((option) => option.id === id) ?? voiceOptions[1];
}

function clampSpeechRate(rate: number) {
  return Math.max(0.75, Math.min(1.5, rate));
}

function resolveSpeechVoice(preset: VoicePreset, voices: SpeechSynthesisVoice[]) {
  const option = getVoiceOption(preset);
  const chineseVoices = voices.filter((voice) => /zh|cmn|yue|中文|普通话|mandarin|chinese/i.test(`${voice.lang} ${voice.name}`));
  const candidates = chineseVoices.length ? chineseVoices : voices;
  const matchedVoice = candidates.find((voice) => {
    const haystack = `${voice.name} ${voice.lang}`.toLowerCase();
    return option.hints.some((hint) => haystack.includes(hint.toLowerCase()));
  });
  return { voice: matchedVoice ?? candidates[0] ?? null, matchedPreset: Boolean(matchedVoice) };
}

function pickSpeechVoice(preset: VoicePreset, voices: SpeechSynthesisVoice[]) {
  return resolveSpeechVoice(preset, voices).voice;
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

export default function AudioHub({ active, tracks: curatedTracks, wrongQuestions, notify, trackEvent }: AudioHubProps) {
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
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [cachedIds, setCachedIds] = useState<string[]>([]);
  const [speechFallbackIds, setSpeechFallbackIds] = useState<string[]>([]);
  const [voicePreset, setVoicePreset] = useState<VoicePreset>("newsFemale");
  const [speechVoices, setSpeechVoices] = useState<SpeechSynthesisVoice[]>([]);
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
  const loopRef = useRef(loop);
  const speechFallbackIdsRef = useRef<string[]>([]);
  const voicePresetRef = useRef<VoicePreset>(voicePreset);
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
    voicePresetRef.current = voicePreset;
  }, [voicePreset]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return undefined;
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      speechVoicesRef.current = voices;
      setSpeechVoices(voices);
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
      notify("当前浏览器暂不支持系统语音；播放未启动，请使用下方原生播放器播放");
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
      notify("该节目缺少音频和朗读文本，请联系运营人员补充");
      return;
    }
    const previous = preservePosition && speechCursorRef.current?.trackId === track.id ? speechCursorRef.current : null;
    const chunks = splitForSpeech(text);
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
          if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
        }
        return;
      }
      const currentChunk = chunks[index];
      const safeCharIndex = Math.min(charIndex, Math.max(0, currentChunk.length - 1));
      const cursor: SpeechCursor = { trackId: track.id, chunks, chunkIndex: index, charIndex: safeCharIndex };
      speechCursorRef.current = cursor;
      const utterance = new SpeechSynthesisUtterance(currentChunk.slice(safeCharIndex));
      const option = getVoiceOption(voicePresetRef.current);
      const voice = pickSpeechVoice(
        voicePresetRef.current,
        speechVoicesRef.current.length ? speechVoicesRef.current : window.speechSynthesis.getVoices(),
      );
      utterance.lang = "zh-CN";
      utterance.rate = clampSpeechRate(speedRef.current + option.rateOffset);
      utterance.pitch = option.pitch;
      if (voice) utterance.voice = voice;
      utterance.onstart = () => {
        if (sessionRef.current === session) setBuffering(false);
      };
      utterance.onboundary = (event) => {
        if (sessionRef.current !== session || speechCursorRef.current?.trackId !== track.id) return;
        speechCursorRef.current.charIndex = Math.min(currentChunk.length, safeCharIndex + event.charIndex);
        setProgress(speechProgress(speechCursorRef.current));
      };
      utterance.onend = () => {
        if (sessionRef.current !== session) return;
        speechCursorRef.current = { trackId: track.id, chunks, chunkIndex: index + 1, charIndex: 0 };
        setProgress(index + 1 >= chunks.length ? 100 : speechProgress(speechCursorRef.current));
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
    setProgress(previous ? speechProgress({ trackId: track.id, chunks, chunkIndex: firstChunkIndex, charIndex: firstCharIndex }) : 0);
    if (!preservePosition) {
      emitAudioBehavior(track, "start", {
        engine: "speech",
        fallbackFromFixedAudio: Boolean(track.audioUrl),
        speed: speedRef.current,
        voicePreset: voicePresetRef.current,
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
      ? "当前离线且未找到有效缓冲，已切换为AI朗读（调用本机系统语音）"
      : "固定音频未启动，已自动切换为AI朗读（调用本机系统语音）");
    startSpeech(track, false);
    updateMediaSession(track);
  }, [markSpeechFallback, notify, startSpeech, updateMediaSession]);

  const start = useCallback(async (track: AudioTrack) => {
    if (activeTrackRef.current && activeTrackRef.current.id !== track.id && engineRef.current) {
      emitPlaybackLifecycle("audio_close", activeTrackRef.current, "switch", { engine: engineRef.current });
    }
    const session = sessionRef.current + 1;
    sessionRef.current = session;
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
  }, [cachedAudioSource, cachedIds, clearSpeechFallback, emitAudioBehavior, emitPlaybackLifecycle, fallbackToSpeech, notify, online, revokeObjectUrl, startSpeech, updateMediaSession]);

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

  const changeVoicePreset = (nextPreset: VoicePreset) => {
    voicePresetRef.current = nextPreset;
    setVoicePreset(nextPreset);
    const resolution = resolveSpeechVoice(nextPreset, speechVoicesRef.current);
    if (!resolution.matchedPreset) notify(`本机没有独立“${getVoiceOption(nextPreset).label}”音色，已用默认中文音色配合语速和音调呈现`);
    if (playing && selectedTrack && engineRef.current === "speech") {
      if (paused) {
        sessionRef.current += 1;
        window.speechSynthesis.cancel();
        speechNeedsRestartRef.current = true;
      } else startSpeech(selectedTrack, true);
      return;
    }
    if (selectedTrack?.audioUrl) notify("固定真人音频不改变音色；若自动切换AI朗读会使用所选音色");
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
    if (!track.audioUrl) return notify("系统合成朗读依赖当前设备语音，不标记为离线音频");
    if (!canCacheOffline(track)) return notify("会员节目需在线校验使用权益；仅免费试听音频支持离线缓冲");
    if (!("caches" in window)) return notify("当前浏览器暂不支持离线缓冲");
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
      notify("音频文件已缓冲；离线时会先校验缓存，未命中则明确回退到系统朗读");
    } catch {
      notify("离线缓冲失败，请检查网络和浏览器存储权限");
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
    setProgress(Math.round((audio.currentTime / audio.duration) * 100));
    if ("mediaSession" in navigator && "setPositionState" in navigator.mediaSession) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: audio.currentTime }); } catch { /* unsupported transient state */ }
    }
  };

  const handleAudioError = () => {
    const track = activeTrackRef.current;
    const session = sessionRef.current;
    if (!track?.audioUrl || engineRef.current !== "audio") return;
    fallbackToSpeech(track, session, "load");
  };

  const miniPlayerVisible = Boolean(selectedTrack && (playing || paused));
  const playbackStatus = buffering ? "正在缓冲" : playing ? (paused ? "已暂停" : "正在播放") : progress >= 100 ? "已播完" : "待播放";
  const currentVoiceOption = getVoiceOption(voicePreset);
  const currentVoiceResolution = resolveSpeechVoice(voicePreset, speechVoices);
  const voiceAvailability = currentVoiceResolution.matchedPreset && currentVoiceResolution.voice
    ? `本机音色：${currentVoiceResolution.voice.name}`
    : speechVoices.length
      ? `无独立${currentVoiceOption.label}，使用默认中文音色调节呈现`
      : "未检测到独立中文音色，将使用浏览器默认语音";
  const selectedUsesSpeech = Boolean(selectedTrack && (playbackEngine === "speech" || !selectedTrack.audioUrl || speechFallbackIds.includes(selectedTrack.id)));

  return (
    <>
    <div className={`page-content subpage audio-page ${active ? "" : "is-hidden"}`} aria-hidden={!active}>
      <div className="subpage-heading audio-heading">
        <div><span>日练电台</span><h1>通勤也能练</h1><p>上下班路上，听完一组时政热点、申论表达或个人错题。</p></div>
        <span className={`network-badge ${online ? "" : "offline"}`}>{online ? "在线" : "离线模式"}</span>
      </div>

      {selectedTrack ? (
        <section className="audio-hero">
          <div className="audio-live"><i /> {selectedUsesSpeech ? "系统朗读 · 锁屏能力依设备" : "固定音频 · 支持锁屏播放"}</div>
          <h2>{selectedTrack.title}</h2>
          <p>{selectedTrack.description}</p>
          <div className={`waveform ${playing && !paused ? "playing" : ""}`} aria-hidden="true">
            {Array.from({ length: 22 }).map((_, index) => <i key={index} style={{ "--bar": `${16 + (index * 13) % 34}px`, animationDelay: `-${index * 37}ms` } as React.CSSProperties} />)}
          </div>
          <button onClick={togglePlayback}>{buffering ? "× 取消加载" : playing && !paused ? "Ⅱ 暂停播放" : paused ? "▶ 继续播放" : "▶ 开始收听"}</button>
          <small className="audio-voice-tip">{selectedUsesSpeech ? `当前音色：${currentVoiceOption.label} · ${currentVoiceOption.tone}；实际声音取决于本机语音库` : "固定音频保留原声；若播放受限会自动切换AI朗读（本机系统语音）"}</small>
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
                <header><span>{item.icon}</span><div><h3>{item.title}</h3><p>{categoryTracks.length ? `${categoryTracks.length} 个节目 · 可倍速/循环${hasCacheableAudio ? "/离线缓冲" : ""}` : item.empty}</p></div></header>
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
          {!series.length && <div className="audio-empty"><span>台</span><div><h3>栏目正在上架</h3><p>运营人员发布栏目和节目后会自动出现在这里。</p></div></div>}
        </section>
      ) : (
        <section className="audio-list" aria-label="音频节目列表">
          {visibleTracks.length === 0 ? (
            filter === "wrong" ? (
              <div className="audio-empty"><span>错</span><div><h3>完成行测后再来听</h3><p>系统会把真实错题的题干、答案和解析生成听练内容，并优先排列到期复习题。</p></div></div>
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
                  <span>{track.kicker}{track.audioUrl && !speechFallbackIds.includes(track.id) ? " · 真人/固定音频" : " · 系统合成朗读"}</span><h3>{track.title}</h3><p>{track.source} · {track.duration}</p>
                </button>
                <button className={`cache-button ${cached ? "cached" : ""}`} disabled={!cacheable} onClick={() => void cacheTrack(track)} aria-label={cacheable ? `离线缓冲${track.title}` : track.audioUrl ? `${track.title}为会员在线音频，不能离线缓存` : `${track.title}使用设备语音，不能标记为离线音频`}>{cacheable ? (cached ? "✓ 已缓冲" : "↓ 离线") : track.audioUrl ? "在线收听" : "设备语音"}</button>
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
            onEnded={() => { if (!loopRef.current) { emitPlaybackLifecycle("audio_complete", selectedTrack, "natural_complete", { engine: "audio", progress: 100 }); engineRef.current = null; activeTrackRef.current = null; if (timerRef.current) window.clearTimeout(timerRef.current); timerRef.current = null; setSleepMinutes(0); setPlaybackEngine(null); setPlaying(false); setPaused(false); setBuffering(false); setProgress(100); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none"; } }}
          />
          <div className="player-top"><div><span>{playbackStatus}</span><h3>{selectedTrack.title}</h3></div><button onClick={() => stop(undefined, "stop")} disabled={!playing && !paused}>停止</button></div>
          <div className="audio-progress"><i style={{ width: `${progress}%` }} /></div>
          <div className="player-controls">
            <button className={loop ? "active" : ""} aria-pressed={loop} onClick={toggleLoop}>↻ {loop ? "循环中" : "循环"}</button>
            <label>倍速<select aria-label="播放倍速" value={speed} onChange={(event) => changeSpeed(Number(event.target.value))}><option value={0.75}>0.75×</option><option value={1}>1.0×</option><option value={1.25}>1.25×</option><option value={1.5}>1.5×</option></select></label>
            <label className="voice-select">音色<select aria-label="朗读音色" value={voicePreset} onChange={(event) => changeVoicePreset(event.target.value as VoicePreset)}>{voiceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><small>{voiceAvailability}</small></label>
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
          <div className="audio-floating-progress"><i style={{ width: `${Math.max(2, progress)}%` }} /></div>
        </div>
        <button className="audio-mini-toggle" onClick={togglePlayback}>{buffering ? "取消" : paused ? "继续" : "暂停"}</button>
        <button className="audio-mini-close" onClick={() => stop("已关闭播放", "close")} aria-label={`关闭播放${selectedTrack.title}`}>×</button>
      </section>
    )}
    </>
  );
}
