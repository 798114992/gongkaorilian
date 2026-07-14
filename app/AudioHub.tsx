"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Question } from "./data/content";
import type { AudioCategory, AudioTrack } from "./data/audio";

type Filter = "all" | AudioCategory;

type AudioHubProps = {
  active: boolean;
  tracks: AudioTrack[];
  wrongQuestions: Question[];
  notify: (message: string) => void;
  trackEvent: (eventName: string, eventData?: Record<string, unknown>) => void;
};

const filterOptions: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "精选" },
  { id: "current", label: "时政电台" },
  { id: "essay", label: "申论晨读" },
  { id: "wrong", label: "错题听练" },
];

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
  const wrongTracks = useMemo<AudioTrack[]>(() => wrongQuestions.map((question) => ({
    id: `wrong-${question.id}`,
    category: "wrong",
    title: `${question.module}错题：${question.knowledge}`,
    kicker: "错题语音朗读",
    source: "我的错题本",
    duration: "约1分钟",
    description: question.stem,
    text: `开始复习一道${question.module}错题。题目是：${question.stem}。选项分别是：${question.options.map((option, index) => `${String.fromCharCode(65 + index)}，${option}`).join("；")}。请先暂停十秒，独立回忆答案和解题思路，再继续播放。正确答案是${String.fromCharCode(65 + question.answer)}，${question.options[question.answer]}。解析：${question.explanation}。最后请复述本题考点和错误原因。`,
  })), [wrongQuestions]);

  const tracks = useMemo(() => [...curatedTracks, ...wrongTracks], [curatedTracks, wrongTracks]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState(curatedTracks[0]?.id ?? wrongTracks[0]?.id ?? "");
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [cachedIds, setCachedIds] = useState<string[]>([]);
  const online = useSyncExternalStore(subscribeOnlineStatus, readOnlineStatus, readServerOnlineStatus);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sessionRef = useRef(0);
  const speedRef = useRef(speed);
  const loopRef = useRef(loop);
  const timerRef = useRef<number | null>(null);

  const visibleTracks = useMemo(
    () => filter === "all" ? tracks : tracks.filter((track) => track.category === filter),
    [filter, tracks],
  );
  const selectedTrack = visibleTracks.find((track) => track.id === selectedId) ?? visibleTracks[0];

  useEffect(() => {
    speedRef.current = speed;
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    loopRef.current = loop;
    if (audioRef.current) audioRef.current.loop = loop;
  }, [loop]);

  useEffect(() => {
    const audioElement = audioRef.current;
    const cachedTimer = window.setTimeout(() => {
      try { setCachedIds(JSON.parse(window.localStorage.getItem("gkrl-cached-audio") ?? "[]") as string[]); }
      catch { setCachedIds([]); }
    }, 0);
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
    return () => {
      window.clearTimeout(cachedTimer);
      sessionRef.current += 1;
      window.speechSynthesis?.cancel();
      audioElement?.pause();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const stop = useCallback((message?: string) => {
    sessionRef.current += 1;
    window.speechSynthesis?.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPlaying(false);
    setPaused(false);
    setProgress(0);
    if (message) notify(message);
  }, [notify]);

  const changeFilter = (nextFilter: Filter) => {
    if (nextFilter === filter) return;
    const nextTracks = nextFilter === "all" ? tracks : tracks.filter((track) => track.category === nextFilter);
    stop();
    setFilter(nextFilter);
    setSelectedId(nextTracks[0]?.id ?? "");
  };

  const startSpeech = useCallback((track: AudioTrack) => {
    if (!("speechSynthesis" in window)) {
      notify("当前浏览器暂不支持错题语音朗读");
      return;
    }
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    window.speechSynthesis.cancel();
    const chunks = splitForSpeech(track.text);
    const speakChunk = (index: number) => {
      if (sessionRef.current !== session) return;
      if (index >= chunks.length) {
        if (loopRef.current) {
          setProgress(0);
          speakChunk(0);
        } else {
          setPlaying(false);
          setPaused(false);
          setProgress(100);
        }
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.lang = "zh-CN";
      utterance.rate = speedRef.current;
      utterance.onend = () => {
        setProgress(Math.round(((index + 1) / chunks.length) * 100));
        speakChunk(index + 1);
      };
      utterance.onerror = () => {
        if (sessionRef.current === session) {
          setPlaying(false);
          setPaused(false);
        }
      };
      window.speechSynthesis.speak(utterance);
    };
    setPlaying(true);
    setPaused(false);
    setProgress(0);
    speakChunk(0);
  }, [notify]);

  const updateMediaSession = useCallback((track: AudioTrack) => {
    if (!("mediaSession" in navigator) || !("MediaMetadata" in window)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: "公考日练 · 日练电台",
      album: track.kicker,
    });
    navigator.mediaSession.setActionHandler("play", () => void audioRef.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => {
      if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 15);
    });
    navigator.mediaSession.setActionHandler("seekforward", () => {
      if (audioRef.current) audioRef.current.currentTime = Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + 15);
    });
  }, []);

  const start = useCallback(async (track: AudioTrack) => {
    sessionRef.current += 1;
    window.speechSynthesis?.cancel();
    audioRef.current?.pause();
    setSelectedId(track.id);
    setProgress(0);
    trackEvent("audio_play", { trackId: track.id, category: track.category, fixedAudio: Boolean(track.audioUrl) });
    if (!track.audioUrl) {
      startSpeech(track);
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = track.audioUrl;
    audio.playbackRate = speedRef.current;
    audio.loop = loopRef.current;
    try {
      await audio.play();
      setPlaying(true);
      setPaused(false);
      updateMediaSession(track);
    } catch {
      setPlaying(false);
      notify("播放未启动，请再次点击播放按钮");
    }
  }, [notify, startSpeech, trackEvent, updateMediaSession]);

  const togglePlayback = () => {
    if (!selectedTrack) return;
    if (!playing) return void start(selectedTrack);
    if (selectedTrack.audioUrl) {
      if (paused) {
        void audioRef.current?.play();
        setPaused(false);
      } else {
        audioRef.current?.pause();
        setPaused(true);
      }
      return;
    }
    if (paused) {
      window.speechSynthesis.resume();
      setPaused(false);
    } else {
      window.speechSynthesis.pause();
      setPaused(true);
    }
  };

  const changeSpeed = (nextSpeed: number) => {
    speedRef.current = nextSpeed;
    setSpeed(nextSpeed);
    if (audioRef.current) audioRef.current.playbackRate = nextSpeed;
    if (playing && selectedTrack && !selectedTrack.audioUrl) startSpeech(selectedTrack);
  };

  const toggleLoop = () => {
    const next = !loop;
    loopRef.current = next;
    setLoop(next);
    if (audioRef.current) audioRef.current.loop = next;
  };

  const setSleepTimer = (minutes: number) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setSleepMinutes(minutes);
    if (!minutes) return notify("定时关闭已取消");
    timerRef.current = window.setTimeout(() => {
      stop("定时播放已结束");
      setSleepMinutes(0);
    }, minutes * 60 * 1000);
    notify(`将在 ${minutes} 分钟后停止播放`);
  };

  const cacheTrack = async (track: AudioTrack) => {
    if (!("caches" in window)) return notify("当前浏览器暂不支持离线缓冲");
    try {
      const cache = await caches.open("gongkao-audio-v2");
      const request = new Request(track.audioUrl ?? `/__offline_audio__/${track.id}.json`);
      const response = track.audioUrl
        ? await fetch(track.audioUrl)
        : new Response(JSON.stringify(track), { headers: { "content-type": "application/json; charset=utf-8" } });
      if (!response.ok) throw new Error("audio fetch failed");
      await cache.put(request, response.clone());
      const next = Array.from(new Set([...cachedIds, track.id]));
      setCachedIds(next);
      window.localStorage.setItem("gkrl-cached-audio", JSON.stringify(next));
      trackEvent("audio_cached", { trackId: track.id });
      notify(track.audioUrl ? "音频文件已缓存，可离线播放" : "错题听练已缓存到本机");
    } catch {
      notify("离线缓冲失败，请检查网络和浏览器存储权限");
    }
  };

  const playTrackFromButton = (event: React.MouseEvent<HTMLButtonElement>) => {
    const track = tracks.find((item) => item.id === event.currentTarget.dataset.trackId);
    if (track) void start(track);
  };

  const selectTrackFromButton = (event: React.MouseEvent<HTMLButtonElement>) => {
    const id = event.currentTarget.dataset.trackId;
    if (!id || id === selectedId) return;
    stop();
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

  return (
    <div className={`page-content subpage audio-page ${active ? "" : "is-hidden"}`} aria-hidden={!active}>
      <audio ref={audioRef} preload="metadata" onTimeUpdate={updateAudioProgress} onEnded={() => { if (!loopRef.current) { setPlaying(false); setPaused(false); setProgress(100); } }} />
      <div className="subpage-heading audio-heading">
        <div><span>日练电台</span><h1>通勤也能练</h1><p>上下班路上，听完一组时政热点、申论表达或个人错题。</p></div>
        <span className={`network-badge ${online ? "" : "offline"}`}>{online ? "在线" : "离线模式"}</span>
      </div>

      {selectedTrack ? (
        <section className="audio-hero">
          <div className="audio-live"><i /> 精选更新 · 支持锁屏播放</div>
          <h2>{selectedTrack.title}</h2>
          <p>{selectedTrack.description}</p>
          <div className={`waveform ${playing && !paused ? "playing" : ""}`} aria-hidden="true">
            {Array.from({ length: 22 }).map((_, index) => <i key={index} style={{ "--bar": `${16 + (index * 13) % 34}px`, animationDelay: `-${index * 37}ms` } as React.CSSProperties} />)}
          </div>
          <button onClick={togglePlayback}>{playing && !paused ? "Ⅱ 暂停播放" : paused ? "▶ 继续播放" : "▶ 开始收听"}</button>
          {selectedTrack.category === "wrong" && <small className="audio-recall-tip">听到“暂停十秒”时先独立作答，再继续听答案。</small>}
        </section>
      ) : null}

      <div className="audio-filters" aria-label="音频分类">
        {filterOptions.map((option) => <button key={option.id} className={filter === option.id ? "active" : ""} onClick={() => changeFilter(option.id)}>{option.label}</button>)}
      </div>

      <section className="audio-list" aria-label="音频节目列表">
        {visibleTracks.length === 0 ? (
          filter === "wrong" ? (
            <div className="audio-empty"><span>错</span><div><h3>完成行测后再来听</h3><p>系统会把真实错题的题干、答案和解析生成 AI 听练内容。</p></div></div>
          ) : (
            <div className="audio-empty"><span>新</span><div><h3>本栏目内容准备中</h3><p>新的时政与申论音频会按内容计划陆续更新。</p></div></div>
          )
        ) : visibleTracks.map((track) => {
          const selected = selectedTrack?.id === track.id;
          const cached = cachedIds.includes(track.id);
          return (
            <article className={`audio-track ${selected ? "selected" : ""}`} key={track.id}>
              <button className="track-play" data-track-id={track.id} onClick={playTrackFromButton} aria-label={`播放${track.title}`}>{selected && playing && !paused ? "Ⅱ" : "▶"}</button>
              <button className="track-copy" data-track-id={track.id} onClick={selectTrackFromButton}>
                <span>{track.kicker}{track.audioUrl ? " · 真人/固定音频" : " · AI合成朗读"}</span><h3>{track.title}</h3><p>{track.source} · {track.duration}</p>
              </button>
              <button className={`cache-button ${cached ? "cached" : ""}`} onClick={() => void cacheTrack(track)} aria-label={`离线缓冲${track.title}`}>{cached ? "✓ 已缓冲" : "↓ 离线"}</button>
            </article>
          );
        })}
      </section>

      {selectedTrack ? (
        <section className="audio-player" aria-label="播放控制器">
          <div className="player-top"><div><span>正在播放</span><h3>{selectedTrack.title}</h3></div><button onClick={() => stop()}>停止</button></div>
          <div className="audio-progress"><i style={{ width: `${progress}%` }} /></div>
          <div className="player-controls">
            <button className={loop ? "active" : ""} aria-pressed={loop} onClick={toggleLoop}>↻ {loop ? "循环中" : "循环"}</button>
            <label>倍速<select value={speed} onChange={(event) => changeSpeed(Number(event.target.value))}><option value={0.75}>0.75×</option><option value={1}>1.0×</option><option value={1.25}>1.25×</option><option value={1.5}>1.5×</option></select></label>
            <label>定时<select value={sleepMinutes} onChange={(event) => setSleepTimer(Number(event.target.value))}><option value={0}>关闭</option><option value={10}>10分钟</option><option value={20}>20分钟</option><option value={30}>30分钟</option><option value={60}>60分钟</option></select></label>
            <button className="player-main" onClick={togglePlayback}>{playing && !paused ? "Ⅱ" : "▶"}</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
