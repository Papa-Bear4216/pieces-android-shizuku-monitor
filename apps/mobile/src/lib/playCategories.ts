import playCategories from "../data/playCategories.json";

// Static seed file, generated offline by scripts/play-category-scrape/ — a
// one-time scrape of Play Store listing pages, never fetched at runtime.
// Keeps this app's no-network-by-default posture: the picker's category
// grouping gets better labels without adding a live dependency on Play.
//
// Android's own ApplicationInfo.category (what the Java side reports) is
// rarely declared by developers, so most apps arrive here as
// "Uncategorized" — this fills the gap only for that case, never overrides
// a category the OS actually reported.
const PLAY_CATEGORIES: Record<string, string> = playCategories;

export function withPlayCategoryFallback<T extends { packageName: string; category: string }>(app: T): T {
  if (app.category !== "Uncategorized") return app;
  const fallback = PLAY_CATEGORIES[app.packageName];
  return fallback ? { ...app, category: fallback } : app;
}
