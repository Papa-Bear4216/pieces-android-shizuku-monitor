import { vi } from "vitest";

// Default every test to the non-native (browser) platform. Individual tests
// that exercise native paths override this with vi.mocked(...).mockReturnValue(true).
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: vi.fn(() => false),
    },
    registerPlugin: vi.fn(() => ({})),
  };
});

// @capacitor/preferences → in-memory store, reset per test file via beforeEach in each test.
const store = new Map<string, string>();
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      store.delete(key);
    }),
  },
  __store: store,
}));
