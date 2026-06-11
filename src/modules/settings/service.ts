import type { DB } from "../../db/index.js";
import { nowIso } from "../../lib/time.js";
import type { ImportRules } from "../types.js";

export interface SiteSettings {
  authorName: string;
  authorXUrl: string;
  authorCtaHtml: string;
  showBlogViewCounts: boolean;
  showArchiveOnPostPages: boolean;
  amaEnabled: boolean;
  rssIncludeFullContent: boolean;
  customFooterHtml: string;
  controlledTagVocabulary: string[];
  statsIgnoredWords: string[];
}

export const DEFAULT_IMPORT_RULES: ImportRules = {
  minimumCharacterCount: 100,
  minimumQuoteCommentaryCount: 280,
  minimumXViewsForAutoPublish: undefined,
  minimumLikesForAutoPublish: undefined,
  importReplies: false,
  importReposts: false,
  importQuotes: true,
  combineThreads: true,
  autoPublishStandalonePosts: false,
  autoPublishAfterMinutes: 0,
  blockedKeywords: [],
  allowedLanguages: [],
};

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  authorName: "Author",
  authorXUrl: "",
  authorCtaHtml:
    `<p>P.S. I'm on X too if you'd like to follow more of my stories.</p>`,
  showBlogViewCounts: true,
  showArchiveOnPostPages: true,
  amaEnabled: false,
  rssIncludeFullContent: true,
  customFooterHtml: "",
  controlledTagVocabulary: [],
  statsIgnoredWords: [],
};

export class SettingsService {
  constructor(private db: DB) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return fallback;
    try {
      const parsed = JSON.parse(row.value_json);
      // merge so newly added default fields appear on old installs
      if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) {
        return { ...(fallback as object), ...(parsed as object) } as T;
      }
      return parsed as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), nowIso());
  }

  getImportRules(): ImportRules {
    return this.get("import_rules", DEFAULT_IMPORT_RULES);
  }

  setImportRules(rules: ImportRules): void {
    this.set("import_rules", rules);
  }

  getSiteSettings(): SiteSettings {
    return this.get("site", DEFAULT_SITE_SETTINGS);
  }

  setSiteSettings(settings: SiteSettings): void {
    this.set("site", settings);
  }
}
