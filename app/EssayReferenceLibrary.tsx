"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import styles from "./EssayReferenceLibrary.module.css";

export type EssayReferenceMaterial = {
  id: string;
  label: string;
  title?: string;
  content: string;
  order?: number;
};

export type EssayReferencePaper = {
  id: string;
  code?: string;
  title: string;
  examType?: string;
  region: string;
  year: string | number;
  volumeType: string;
  description?: string;
  updatedAt?: string;
  paperUrl?: string;
  tags?: string[];
  materials?: EssayReferenceMaterial[];
  questionCount?: number;
  sourceCount?: number;
};

export type EssayReferenceQuestion = {
  id: string;
  paperId: string;
  number: string | number;
  title?: string;
  prompt: string;
  requirements?: string;
  score?: number;
  wordLimit?: number;
  materialIds?: string[];
  order?: number;
};

export type EssayReferenceSource = {
  id: string;
  questionId: string;
  name: string;
  /** full：展示全文；excerpt：展示节选；link：仅展示原文入口。 */
  displayMode?: "full" | "excerpt" | "link" | "link_only";
  content?: string;
  originalTitle?: string;
  originalUrl?: string;
  updatedAt?: string;
  accent?: string;
  order?: number;
};

/** 公共资料库接口的来源答案结构。 */
export type EssayLibrarySource = {
  id: string;
  sourceName: string;
  displayMode?: "full" | "excerpt" | "link" | "link_only";
  content?: string;
  excerpt?: string;
  sourceUrl?: string;
  originalTitle?: string;
  updatedAt?: string;
  accent?: string;
  sortOrder?: number;
};

/** 公共资料库接口的题目结构。 */
export type EssayLibraryQuestion = {
  id: string;
  code?: string;
  number: string | number;
  prompt: string;
  requirements?: string;
  score?: number;
  wordLimit?: number;
  questionType?: string;
  materialIds?: string[];
  sortOrder?: number;
  sources?: EssayLibrarySource[];
};

/** 公共资料库接口的材料结构。 */
export type EssayLibraryMaterial = {
  id: string;
  label: string;
  title?: string;
  content: string;
  sortOrder?: number;
};

/**
 * 公共资料库接口的试卷结构。题目与多来源答案随试卷返回，便于一次请求完成翻查。
 */
export type EssayLibraryPaper = {
  id: string;
  code?: string;
  title: string;
  examType?: string;
  region: string;
  examYear: string | number;
  paperType: string;
  description?: string;
  sourceUrl?: string;
  resourceUrl?: string;
  updatedAt?: string;
  tags?: string[];
  materials?: EssayLibraryMaterial[];
  questions?: EssayLibraryQuestion[];
  questionCount?: number;
  sourceCount?: number;
};

export type EssayReferenceLibraryProps = {
  /** 支持公共接口嵌套结构，也兼容父页面传入的扁平结构。 */
  papers: Array<EssayLibraryPaper | EssayReferencePaper>;
  questions?: EssayReferenceQuestion[];
  sources?: EssayReferenceSource[];
  onClose: () => void;
  initialPaperId?: string;
  favoritePaperIds?: string[];
  recentPaperIds?: string[];
  onFavoritePaperIdsChange?: (ids: string[]) => void;
  onRecentPaperIdsChange?: (ids: string[]) => void;
  onPaperOpen?: (paperId: string) => void | Promise<void>;
  onPaperExit?: () => void;
  onSharePaper?: (paper: EssayReferencePaper) => void | Promise<void>;
  hasMore?: boolean;
  totalCount?: number;
  loadingMore?: boolean;
  onLoadMore?: () => void | Promise<void>;
  storageKey?: string;
  title?: string;
  subtitle?: string;
};

type LibraryView = "all" | "recent" | "favorite";

const sourceAccents = ["#25689b", "#3a8d74", "#9a6a2f", "#7b63a7", "#a85252", "#467c91"];

function ChevronIcon({ direction = "down" }: { direction?: "down" | "left" | "right" }) {
  const rotation = direction === "left" ? "90deg" : direction === "right" ? "-90deg" : "0deg";
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={styles.icon} style={direction === "down" ? undefined : { transform: `rotate(${rotation})` }}>
      <path d="m6.5 9 5.5 5.5L17.5 9" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={styles.icon}>
      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={styles.icon}>
      <circle cx="10.8" cy="10.8" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="m15.6 15.6 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.9" />
    </svg>
  );
}

function BookmarkIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={styles.icon}>
      <path d="M7 4.8c0-.9.7-1.6 1.6-1.6h6.8c.9 0 1.6.7 1.6 1.6v15l-5-3.1-5 3.1v-15Z" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={styles.icon}>
      <path d="M13.5 5H19v5.5M18.5 5.5 11 13M10 6H6.5A1.5 1.5 0 0 0 5 7.5v10A1.5 1.5 0 0 0 6.5 19h10a1.5 1.5 0 0 0 1.5-1.5V14" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={styles.icon}>
      <circle cx="6" cy="12" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="6" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="18" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8 11 6.8-3.8M8 13l6.8 3.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function normalize(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN");
}

function safeResourceUrl(value: unknown) {
  const url = String(value ?? "").trim();
  if (!url) return "";
  if (/^\/api\/app\?media=[0-9a-f-]{36}$/i.test(url)) return url;
  try { return new URL(url).protocol === "https:" ? url : ""; } catch { return ""; }
}

function ordered<T extends { order?: number }>(items: T[]) {
  return [...items].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
}

function compactDate(value?: string) {
  if (!value) return "";
  const matched = value.match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/);
  return matched ? matched[0].replace(/[/.]/g, "-") : value;
}

function uniqueValues(values: Array<string | number>) {
  return Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean)));
}

function readStoredIds(key: string) {
  if (typeof window === "undefined") return [];
  try {
    const value = localStorage.getItem(key);
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function isApiPaper(paper: EssayLibraryPaper | EssayReferencePaper): paper is EssayLibraryPaper {
  return "examYear" in paper || "paperType" in paper || "questions" in paper;
}

function normalizeLibraryData(
  paperData: Array<EssayLibraryPaper | EssayReferencePaper>,
  flatQuestions: EssayReferenceQuestion[],
  flatSources: EssayReferenceSource[],
) {
  const papers: EssayReferencePaper[] = paperData.map((paper) => {
    if (!isApiPaper(paper)) return {
      ...paper,
      id: String(paper.id),
      code: paper.code,
      region: String(paper.region ?? ""),
      year: paper.year ?? "",
      volumeType: String(paper.volumeType ?? ""),
      paperUrl: safeResourceUrl(paper.paperUrl),
      materials: paper.materials?.map((material) => ({ ...material, id: String(material.id) })),
      questionCount: paper.questionCount,
      sourceCount: paper.sourceCount,
    };
    return {
      id: String(paper.id),
      code: paper.code,
      title: paper.title,
      examType: paper.examType,
      region: String(paper.region ?? ""),
      year: paper.examYear ?? "",
      volumeType: String(paper.paperType ?? ""),
      description: paper.description,
      updatedAt: paper.updatedAt,
      paperUrl: safeResourceUrl(paper.resourceUrl || paper.sourceUrl),
      tags: paper.tags,
      questionCount: paper.questionCount,
      sourceCount: paper.sourceCount,
      materials: paper.materials?.map((material) => ({
        id: String(material.id),
        label: material.label,
        title: material.title,
        content: material.content,
        order: material.sortOrder,
      })),
    };
  });

  const nestedQuestions: EssayReferenceQuestion[] = [];
  const nestedSources: EssayReferenceSource[] = [];
  paperData.forEach((paper) => {
    if (!isApiPaper(paper)) return;
    (paper.questions ?? []).forEach((question) => {
      nestedQuestions.push({
        id: String(question.id),
        paperId: String(paper.id),
        number: question.number,
        title: question.questionType,
        prompt: question.prompt,
        requirements: question.requirements,
        score: question.score ?? undefined,
        wordLimit: question.wordLimit ?? undefined,
        materialIds: question.materialIds?.map(String),
        order: question.sortOrder,
      });
      (question.sources ?? []).forEach((source) => {
        nestedSources.push({
          id: String(source.id),
          questionId: String(question.id),
          name: source.sourceName,
          displayMode: source.displayMode === "link_only" ? "link" : source.displayMode,
          content: source.displayMode === "excerpt" ? source.excerpt || source.content : source.content || source.excerpt,
          originalTitle: source.originalTitle,
          originalUrl: safeResourceUrl(source.sourceUrl),
          updatedAt: source.updatedAt,
          accent: source.accent,
          order: source.sortOrder,
        });
      });
    });
  });

  return {
    papers,
    questions: [
      ...flatQuestions.map((question) => ({
        ...question,
        id: String(question.id),
        paperId: String(question.paperId),
        score: question.score ?? undefined,
        wordLimit: question.wordLimit ?? undefined,
        materialIds: question.materialIds?.map(String),
      })),
      ...nestedQuestions,
    ],
    sources: [
      ...flatSources.map((source) => ({ ...source, id: String(source.id), questionId: String(source.questionId), originalUrl: safeResourceUrl(source.originalUrl) })),
      ...nestedSources,
    ],
  };
}

export default function EssayReferenceLibrary({
  papers: paperData,
  questions: flatQuestions = [],
  sources: flatSources = [],
  onClose,
  initialPaperId,
  favoritePaperIds,
  recentPaperIds,
  onFavoritePaperIdsChange,
  onRecentPaperIdsChange,
  onPaperOpen,
  onPaperExit,
  onSharePaper,
  hasMore = false,
  totalCount,
  loadingMore = false,
  onLoadMore,
  storageKey = "gongkao-rilian:essay-reference-library",
  title = "申论真题资料库",
  subtitle = "历年真题与多来源参考答案集中查询",
}: EssayReferenceLibraryProps) {
  const { papers, questions, sources } = useMemo(
    () => normalizeLibraryData(paperData, flatQuestions, flatSources),
    [flatQuestions, flatSources, paperData],
  );
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(() => (
    initialPaperId && papers.some((paper) => paper.id === initialPaperId) ? initialPaperId : null
  ));
  const [query, setQuery] = useState("");
  const [examType, setExamType] = useState("全部考试");
  const [region, setRegion] = useState("全部地区");
  const [year, setYear] = useState("全部年份");
  const [volumeType, setVolumeType] = useState("全部卷种");
  const [libraryView, setLibraryView] = useState<LibraryView>("all");
  const [openingPaperId, setOpeningPaperId] = useState<string | null>(null);
  const [localFavorites, setLocalFavorites] = useState<string[]>(() => readStoredIds(`${storageKey}:favorites`));
  const [localRecent, setLocalRecent] = useState<string[]>(() => readStoredIds(`${storageKey}:recent`));
  const [expandedMaterials, setExpandedMaterials] = useState<Set<string>>(new Set());
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const questionRefs = useRef<Record<string, HTMLElement | null>>({});
  const initialOnClose = useRef(onClose);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      initialOnClose.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const favorites = favoritePaperIds ?? localFavorites;
  const recent = recentPaperIds ?? localRecent;

  const questionsByPaper = useMemo(() => {
    const result = new Map<string, EssayReferenceQuestion[]>();
    questions.forEach((question) => {
      const current = result.get(question.paperId) ?? [];
      current.push(question);
      result.set(question.paperId, current);
    });
    result.forEach((items, key) => result.set(key, ordered(items)));
    return result;
  }, [questions]);

  const sourcesByQuestion = useMemo(() => {
    const result = new Map<string, EssayReferenceSource[]>();
    sources.forEach((source) => {
      const current = result.get(source.questionId) ?? [];
      current.push(source);
      result.set(source.questionId, current);
    });
    result.forEach((items, key) => result.set(key, ordered(items)));
    return result;
  }, [sources]);

  const sourceCountByPaper = useMemo(() => {
    const result = new Map<string, number>();
    papers.forEach((paper) => {
      const sourceNames = new Set<string>();
      (questionsByPaper.get(paper.id) ?? []).forEach((question) => {
        (sourcesByQuestion.get(question.id) ?? []).forEach((source) => sourceNames.add(source.name));
      });
      result.set(paper.id, sourceNames.size || paper.sourceCount || 0);
    });
    return result;
  }, [papers, questionsByPaper, sourcesByQuestion]);

  const filterOptions = useMemo(() => ({
    examTypes: uniqueValues(papers.map((paper) => paper.examType ?? "")).sort((a, b) => a.localeCompare(b, "zh-CN")),
    regions: uniqueValues(papers.map((paper) => paper.region)).sort((a, b) => a.localeCompare(b, "zh-CN")),
    years: uniqueValues(papers.map((paper) => paper.year)).sort((a, b) => Number(b) - Number(a)),
    volumeTypes: uniqueValues(papers.map((paper) => paper.volumeType)).sort((a, b) => a.localeCompare(b, "zh-CN")),
  }), [papers]);

  const filteredPapers = useMemo(() => {
    const term = normalize(query);
    const recentOrder = new Map(recent.map((id, index) => [id, index]));
    const result = papers.filter((paper) => {
      if (examType !== "全部考试" && paper.examType !== examType) return false;
      if (region !== "全部地区" && paper.region !== region) return false;
      if (year !== "全部年份" && String(paper.year) !== year) return false;
      if (volumeType !== "全部卷种" && paper.volumeType !== volumeType) return false;
      if (libraryView === "recent" && !recent.includes(paper.id)) return false;
      if (libraryView === "favorite" && !favorites.includes(paper.id)) return false;
      if (!term) return true;

      const questionText = (questionsByPaper.get(paper.id) ?? [])
        .map((question) => `${question.title ?? ""} ${question.prompt}`)
        .join(" ");
      const sourceText = (questionsByPaper.get(paper.id) ?? [])
        .flatMap((question) => sourcesByQuestion.get(question.id) ?? [])
        .map((source) => source.name)
        .join(" ");
      return normalize([
        paper.title,
        paper.examType,
        paper.region,
        paper.year,
        paper.volumeType,
        paper.description,
        ...(paper.tags ?? []),
        questionText,
        sourceText,
      ].join(" ")).includes(term);
    });

    if (libraryView === "recent") {
      return result.sort((a, b) => (recentOrder.get(a.id) ?? 9999) - (recentOrder.get(b.id) ?? 9999));
    }
    return result.sort((a, b) => Number(b.year) - Number(a.year) || a.title.localeCompare(b.title, "zh-CN"));
  }, [examType, favorites, libraryView, papers, query, questionsByPaper, recent, region, sourcesByQuestion, volumeType, year]);

  const selectedPaper = papers.find((paper) => paper.id === selectedPaperId) ?? null;
  const selectedQuestions = selectedPaper ? questionsByPaper.get(selectedPaper.id) ?? [] : [];

  const updateFavorites = (next: string[]) => {
    if (favoritePaperIds === undefined) {
      setLocalFavorites(next);
      try { localStorage.setItem(`${storageKey}:favorites`, JSON.stringify(next)); } catch { /* 忽略 */ }
    }
    onFavoritePaperIdsChange?.(next);
  };

  const toggleFavorite = (paperId: string) => {
    const next = favorites.includes(paperId)
      ? favorites.filter((id) => id !== paperId)
      : [paperId, ...favorites];
    updateFavorites(next);
  };

  const openPaper = async (paperId: string) => {
    if (openingPaperId) return;
    setOpeningPaperId(paperId);
    try {
      await onPaperOpen?.(paperId);
      setSelectedPaperId(paperId);
      setExpandedMaterials(new Set());
      setExpandedSources(new Set());
      const nextRecent = [paperId, ...recent.filter((id) => id !== paperId)].slice(0, 20);
      if (recentPaperIds === undefined) {
        setLocalRecent(nextRecent);
        try { localStorage.setItem(`${storageKey}:recent`, JSON.stringify(nextRecent)); } catch { /* 忽略 */ }
      }
      onRecentPaperIdsChange?.(nextRecent);
    } catch {
      // 父页面负责展示加载失败提示；失败时保持在资料目录。
    } finally {
      setOpeningPaperId(null);
    }
  };

  const toggleInSet = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    id: string,
  ) => {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const jumpToQuestion = (questionId: string) => {
    questionRefs.current[questionId]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const resetFilters = () => {
    setQuery("");
    setExamType("全部考试");
    setRegion("全部地区");
    setYear("全部年份");
    setVolumeType("全部卷种");
    setLibraryView("all");
  };

  return (
    <section className={styles.shell} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.appFrame}>
        <header className={styles.topbar}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={selectedPaper ? () => { setSelectedPaperId(null); onPaperExit?.(); } : onClose}
            aria-label={selectedPaper ? "返回资料目录" : "关闭资料库"}
          >
            {selectedPaper ? <ChevronIcon direction="left" /> : <CloseIcon />}
          </button>
          <div className={styles.topbarTitle}>
            <strong>{selectedPaper ? "试卷详情" : title}</strong>
            {!selectedPaper && <span>{subtitle}</span>}
          </div>
          {selectedPaper ? (
            <div className={styles.topbarActions}>
              {onSharePaper && <button type="button" className={styles.iconButton} onClick={() => void onSharePaper(selectedPaper)} aria-label="分享试卷"><ShareIcon /></button>}
              <button
                type="button"
                className={`${styles.iconButton} ${favorites.includes(selectedPaper.id) ? styles.iconButtonActive : ""}`}
                onClick={() => toggleFavorite(selectedPaper.id)}
                aria-label={favorites.includes(selectedPaper.id) ? "取消收藏" : "收藏试卷"}
                aria-pressed={favorites.includes(selectedPaper.id)}
              >
                <BookmarkIcon filled={favorites.includes(selectedPaper.id)} />
              </button>
            </div>
          ) : (
            <span className={styles.topbarSpacer} aria-hidden="true" />
          )}
        </header>

        {!selectedPaper ? (
          <main className={styles.catalog}>
            <div className={styles.searchPanel}>
              <div className={styles.searchBox} role="search">
                <SearchIcon />
                <label className={styles.visuallyHidden} htmlFor="essay-library-search">搜索资料</label>
                <input
                  id="essay-library-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索地区、年份、卷种、题目或来源"
                  autoComplete="off"
                />
                {query && (
                  <button type="button" onClick={() => setQuery("")} aria-label="清除搜索内容">
                    <CloseIcon />
                  </button>
                )}
              </div>

              <div className={styles.filterGrid}>
                <label>
                  <span>考试</span>
                  <select value={examType} onChange={(event) => setExamType(event.target.value)}>
                    <option>全部考试</option>
                    {filterOptions.examTypes.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
                <label>
                  <span>地区</span>
                  <select value={region} onChange={(event) => setRegion(event.target.value)}>
                    <option>全部地区</option>
                    {filterOptions.regions.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
                <label>
                  <span>年份</span>
                  <select value={year} onChange={(event) => setYear(event.target.value)}>
                    <option>全部年份</option>
                    {filterOptions.years.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
                <label>
                  <span>卷种</span>
                  <select value={volumeType} onChange={(event) => setVolumeType(event.target.value)}>
                    <option>全部卷种</option>
                    {filterOptions.volumeTypes.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
              </div>
            </div>

            <nav className={styles.viewTabs} aria-label="资料范围">
              {([
                ["all", "全部资料", papers.length],
                ["recent", "最近查看", recent.length],
                ["favorite", "我的收藏", favorites.length],
              ] as Array<[LibraryView, string, number]>).map(([value, label, count]) => (
                <button
                  type="button"
                  key={value}
                  className={libraryView === value ? styles.viewTabActive : ""}
                  onClick={() => setLibraryView(value)}
                  aria-current={libraryView === value ? "page" : undefined}
                >
                  {label}<span>{count}</span>
                </button>
              ))}
            </nav>

            <div className={styles.resultHeader}>
              <strong>{libraryView === "favorite" ? "已收藏资料" : libraryView === "recent" ? "最近查看资料" : "资料目录"}</strong>
              <span>{libraryView === "all" && !query && examType === "全部考试" && region === "全部地区" && year === "全部年份" && volumeType === "全部卷种" && totalCount !== undefined
                ? `已加载 ${papers.length} / 共 ${totalCount} 套`
                : `当前 ${filteredPapers.length} 套`}</span>
            </div>

            {filteredPapers.length ? (
              <>
              <div className={styles.paperList}>
                {filteredPapers.map((paper) => {
                  const paperQuestions = questionsByPaper.get(paper.id) ?? [];
                  const isFavorite = favorites.includes(paper.id);
                  const opening = openingPaperId === paper.id;
                  return (
                    <article key={paper.id} className={styles.paperCard}>
                      <button type="button" className={styles.paperMain} onClick={() => void openPaper(paper.id)} disabled={Boolean(openingPaperId)} aria-busy={opening || undefined}>
                        <div className={styles.paperStamp} aria-hidden="true">
                          <b>{paper.year}</b><span>{paper.region.slice(0, 4)}</span>
                        </div>
                        <div className={styles.paperCopy}>
                          <div className={styles.paperLabels}>
                            {paper.examType && <span>{paper.examType}</span>}
                            <span>{paper.volumeType}</span>
                          </div>
                          <h2>{paper.title}</h2>
                          {paper.description && <p>{paper.description}</p>}
                          <div className={styles.paperMeta}>
                            <span>{paperQuestions.length || paper.questionCount || 0} 道题</span>
                            <i aria-hidden="true" />
                            <span>{sourceCountByPaper.get(paper.id) ?? 0} 个答案来源</span>
                            {paper.updatedAt && <><i aria-hidden="true" /><span>{compactDate(paper.updatedAt)} 更新</span></>}
                          </div>
                        </div>
                        {opening ? <span className={styles.paperOpening}>加载中</span> : <ChevronIcon direction="right" />}
                      </button>
                      <button
                        type="button"
                        className={`${styles.bookmarkButton} ${isFavorite ? styles.bookmarkButtonActive : ""}`}
                        onClick={() => toggleFavorite(paper.id)}
                        aria-label={isFavorite ? `取消收藏${paper.title}` : `收藏${paper.title}`}
                        aria-pressed={isFavorite}
                      >
                        <BookmarkIcon filled={isFavorite} />
                      </button>
                    </article>
                  );
                })}
              </div>
              {hasMore && libraryView === "all" && (
                <button type="button" className={styles.loadMoreButton} disabled={loadingMore} onClick={() => void onLoadMore?.()}>{loadingMore ? "正在加载" : query || region !== "全部地区" || year !== "全部年份" || volumeType !== "全部卷种" || examType !== "全部考试" ? "加载更多并继续筛选" : "加载更多资料"}</button>
              )}
              </>
            ) : (
              <div className={styles.emptyState}>
                <div aria-hidden="true">文</div>
                <strong>{papers.length === 0 ? "资料正在整理中" : libraryView === "favorite" ? "暂未收藏资料" : libraryView === "recent" ? "暂无查看记录" : "未找到相关资料"}</strong>
                <p>{papers.length === 0 ? "后台发布首批申论真题资料后，将自动显示在这里。" : libraryView === "all" ? "请调整搜索内容或筛选条件后重试。" : "可返回全部资料进行查看。"}</p>
                <button type="button" onClick={papers.length === 0 ? onClose : resetFilters}>{papers.length === 0 ? "返回题库" : "查看全部资料"}</button>
              </div>
            )}
          </main>
        ) : (
          <main className={styles.detail}>
            <section className={styles.paperHero}>
              <div className={styles.heroLabels}>
                {selectedPaper.examType && <span>{selectedPaper.examType}</span>}
                <span>{selectedPaper.region}</span>
                <span>{selectedPaper.volumeType}</span>
              </div>
              <h1>{selectedPaper.title}</h1>
              {selectedPaper.description && <p>{selectedPaper.description}</p>}
              <div className={styles.heroMeta}>
                <span>{selectedQuestions.length} 道题</span>
                <span>{sourceCountByPaper.get(selectedPaper.id) ?? 0} 个答案来源</span>
                {selectedPaper.updatedAt && <span>{compactDate(selectedPaper.updatedAt)} 更新</span>}
              </div>
              {selectedPaper.paperUrl && (
                <a href={selectedPaper.paperUrl} target="_blank" rel="noreferrer" className={styles.paperLink}>
                  查看完整试卷 <ExternalIcon />
                </a>
              )}
            </section>

            {selectedPaper.materials?.length ? (
              <section className={styles.sectionBlock}>
                <div className={styles.sectionHeading}>
                  <div><small>材料</small><h2>给定资料</h2></div>
                  <span>{selectedPaper.materials.length} 则</span>
                </div>
                <div className={styles.materialList}>
                  {ordered(selectedPaper.materials).map((material) => {
                    const expanded = expandedMaterials.has(material.id);
                    return (
                      <article key={material.id} className={`${styles.accordion} ${expanded ? styles.accordionOpen : ""}`}>
                        <button
                          type="button"
                          onClick={() => toggleInSet(setExpandedMaterials, material.id)}
                          aria-expanded={expanded}
                        >
                          <span className={styles.materialLabel}>{material.label}</span>
                          <strong>{material.title || material.label}</strong>
                          <ChevronIcon />
                        </button>
                        {expanded && <div className={styles.materialContent}>{material.content}</div>}
                      </article>
                    );
                  })}
                </div>
              </section>
            ) : null}

            <section className={styles.questionSection}>
              <div className={styles.sectionHeading}>
                <div><small>题目</small><h2>题目与参考答案</h2></div>
                <span>{selectedQuestions.length} 题</span>
              </div>

              {selectedQuestions.length > 1 && (
                <nav className={styles.questionNav} aria-label="题目快速跳转">
                  {selectedQuestions.map((question) => (
                    <button type="button" key={question.id} onClick={() => jumpToQuestion(question.id)}>
                      第{question.number}题
                    </button>
                  ))}
                </nav>
              )}

              {selectedQuestions.length ? (
                <div className={styles.questionList}>
                  {selectedQuestions.map((question) => {
                    const questionSources = sourcesByQuestion.get(question.id) ?? [];
                    const materialLabels = (question.materialIds ?? []).map((materialId) => (
                      selectedPaper.materials?.find((material) => material.id === materialId)?.label
                    )).filter((label): label is string => Boolean(label));
                    return (
                      <article
                        key={question.id}
                        className={styles.questionCard}
                        ref={(node) => { questionRefs.current[question.id] = node; }}
                      >
                        <header className={styles.questionHeader}>
                          <div className={styles.questionNumber}>第{question.number}题</div>
                          <div className={styles.questionMeta}>
                            {question.score !== undefined && <span>{question.score}分</span>}
                            {question.wordLimit !== undefined && <span>{question.wordLimit}字以内</span>}
                            {materialLabels.length ? <span>依据{materialLabels.join("、")}</span> : null}
                          </div>
                        </header>
                        {question.title && <h3>{question.title}</h3>}
                        <p className={styles.questionPrompt}>{question.prompt}</p>
                        {question.requirements && (
                          <div className={styles.requirements}><strong>作答要求</strong><span>{question.requirements}</span></div>
                        )}

                        <div className={styles.answerHeading}>
                          <strong>参考答案</strong>
                          <span>{questionSources.length} 个来源</span>
                        </div>

                        {questionSources.length ? (
                          <div className={styles.sourceList}>
                            {questionSources.map((source, sourceIndex) => {
                              const expanded = expandedSources.has(source.id);
                              const configuredMode = source.displayMode === "link_only" ? "link" : source.displayMode;
                              const mode = configuredMode ?? (source.content ? "full" : "link");
                              const accent = source.accent || sourceAccents[sourceIndex % sourceAccents.length];
                              const canExpand = mode !== "link" && Boolean(source.content);
                              const sourceHeading = <>
                                <span className={styles.sourceMonogram} aria-hidden="true">{source.name.slice(0, 1)}</span>
                                <span className={styles.sourceIdentity}><strong>{source.name}</strong></span>
                                {canExpand ? <ChevronIcon /> : source.originalUrl ? <ExternalIcon /> : null}
                              </>;
                              return (
                                <article
                                  key={source.id}
                                  className={`${styles.sourceCard} ${expanded ? styles.sourceCardOpen : ""}`}
                                  style={{ "--source-accent": accent } as CSSProperties}
                                >
                                  {canExpand ? <button
                                      type="button"
                                      className={styles.sourceToggle}
                                      onClick={() => toggleInSet(setExpandedSources, source.id)}
                                      aria-expanded={expanded}
                                    >{sourceHeading}</button>
                                    : source.originalUrl ? <a className={styles.sourceToggle} href={source.originalUrl} target="_blank" rel="noreferrer" aria-label={`查看${source.name}原文`}>{sourceHeading}</a>
                                      : <div className={styles.sourceToggle}>{sourceHeading}</div>}
                                  {expanded && canExpand && (
                                    <div className={styles.sourceBody}>
                                      <div className={styles.answerContent}>{source.content}</div>
                                      {source.originalUrl && (
                                        <div className={styles.sourceFoot}>
                                          <a href={source.originalUrl} target="_blank" rel="noreferrer">
                                            查看原文 <ExternalIcon />
                                          </a>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </article>
                              );
                            })}
                          </div>
                        ) : (
                          <div className={styles.noAnswer}>该题参考答案正在整理中</div>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.noQuestion}>该试卷题目资料正在整理中</div>
              )}
            </section>

          </main>
        )}
      </div>
    </section>
  );
}
