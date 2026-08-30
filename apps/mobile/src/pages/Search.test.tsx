import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../lib/semanticSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/semanticSearch")>();
  return { ...actual, semanticSearch: vi.fn() };
});
vi.mock("../lib/usage", () => ({ recordEvent: vi.fn() }));

import { semanticSearch } from "../lib/semanticSearch";
import { recordEvent } from "../lib/usage";
import Search from "./Search";

beforeEach(() => vi.clearAllMocks());

async function type(value: string) {
  const input = screen.getByPlaceholderText(/search/i);
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: /search/i }));
}

describe("Search page", () => {
  test("renders hits with source badges and records a telemetry event", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({
      hits: [
        { text: "bought a lamp", score: 0.8, timestamp: "2026-02-01T00:00:00Z", source: "local", app_label: "Amazon" },
        { text: "wrote the report", score: 0.7, timestamp: "2026-02-02T00:00:00Z", source: "server" },
      ],
      serverSkipped: false,
      mode: "relevant",
    });
    render(<Search />);
    await type("stuff");
    await waitFor(() => expect(screen.getByText("bought a lamp")).toBeTruthy());
    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]).getByText("On this device")).toBeTruthy();
    expect(within(cards[1]).getByText("From home PC")).toBeTruthy();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "search", screen: "recent", query: "stuff", resultCount: 2, mode: "relevant" }),
    );
  });

  test("renders a server hit's human-readable timestamp literally and formats a local ISO timestamp", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({
      hits: [
        { text: "wrote the report", score: 0.7, timestamp: "3 days ago", source: "server" },
        { text: "bought a lamp", score: 0.8, timestamp: "2026-02-01T00:00:00Z", source: "local", app_label: "Amazon" },
      ],
      serverSkipped: false,
      mode: "relevant",
    });
    render(<Search />);
    await type("stuff");
    await waitFor(() => expect(screen.getByText("wrote the report")).toBeTruthy());
    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]).getByText("3 days ago")).toBeTruthy();
    expect(within(cards[0]).queryByText(/invalid date/i)).toBeNull();
    const localMeta = within(cards[1]).getByText(new Date("2026-02-01T00:00:00Z").toLocaleString());
    expect(localMeta).toBeTruthy();
  });

  test("shows the offline banner when serverSkipped", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({ hits: [], serverSkipped: true, mode: "relevant" });
    render(<Search />);
    await type("x");
    await waitFor(() => expect(screen.getByText(/home pc offline/i)).toBeTruthy());
  });

  test("shows the empty state when there are no hits", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({ hits: [], serverSkipped: false, mode: "relevant" });
    render(<Search />);
    await type("nothing");
    await waitFor(() => expect(screen.getByText(/nothing matched/i)).toBeTruthy());
  });

  test("shows the fallback note when mode is text-fallback", async () => {
    vi.mocked(semanticSearch).mockResolvedValue({
      hits: [{ text: "t", score: 1, timestamp: "2026-02-01T00:00:00Z", source: "local" }],
      serverSkipped: false,
      mode: "text-fallback",
    });
    render(<Search />);
    await type("t");
    await waitFor(() => expect(screen.getByText(/meaning-based search isn't available/i)).toBeTruthy());
  });

  test("shows an error + retry when semanticSearch throws", async () => {
    vi.mocked(semanticSearch).mockRejectedValue(new Error("boom"));
    render(<Search />);
    await type("x");
    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy());
  });
});
