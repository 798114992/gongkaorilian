export type EssayAnswerDisplayMode = "full" | "excerpt" | "link_only";
export type EssayAnswerCopyrightStatus = "original" | "authorized" | "fair_quote" | "link_only" | "pending_verification";

export type EssayAnswerPublicationInput = {
  id?: number | string;
  sourceName?: string;
  displayMode?: string;
  copyrightStatus?: string;
  publicationStatus?: string;
  status?: string;
  sourceActive?: boolean;
  content?: string;
  excerpt?: string;
  sourceUrl?: string;
  sortOrder?: number;
};

export declare const ESSAY_ANSWER_DISPLAY_MODES: readonly EssayAnswerDisplayMode[];
export declare const ESSAY_ANSWER_COPYRIGHT_STATUSES: readonly EssayAnswerCopyrightStatus[];
export declare function validateEssayAnswerPublication(input?: EssayAnswerPublicationInput): string[];
export declare function isEssayAnswerPubliclyVisible(input?: EssayAnswerPublicationInput): boolean;
export declare function sanitizePublicEssayAnswer(input?: EssayAnswerPublicationInput): {
  id: string;
  sourceName: string;
  displayMode: string;
  content: string;
  excerpt: string;
  sourceUrl: string;
  sortOrder: number;
};
