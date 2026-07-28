import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionMetadata } from "../../lib/api/client";
import { SessionMetadata } from "./SessionMetadata";

vi.mock("../../lib/api/client", () => ({
  getSessionMetadata: vi.fn()
}));

vi.mock("../../lib/realtime/useLiveQueryInvalidation", () => ({
  useLiveQueryInvalidation: vi.fn()
}));

describe("SessionMetadata", () => {
  afterEach(cleanup);

  it("renders context and quota as compact icon-number items", async () => {
    vi.mocked(getSessionMetadata).mockResolvedValue({
      apiVersion: "1",
      eventCursor: 1,
      sessionId: "codex:one",
      branch: "main",
      avatarUrl: null,
      contextUsage: {
        usedTokens: 21_942,
        contextWindow: 258_400,
        remainingTokens: 236_458,
        usedPercent: 8.49
      },
      accountUsage: {
        rateLimits: {
          primary: {
            usedPercent: 24
          }
        }
      }
    });

    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionMetadata sessionId="codex:one" />
      </QueryClientProvider>
    );

    expect(await screen.findByLabelText(/上下文用量.*21,942\/258,400/)).toBeInTheDocument();
    expect(screen.getByLabelText(/套餐余额：76%/)).toBeInTheDocument();
    expect(container.querySelector(".session-metadata-panel")).toHaveTextContent("main");
    expect(container.querySelector(".session-metadata-panel")).toHaveTextContent("21,942/258,400");
    expect(container.querySelector(".session-metadata-panel")).toHaveTextContent("76%");
    expect(container.querySelector(".session-metadata-panel")?.textContent).not.toContain("上下文用量");
    expect(container.querySelector(".session-metadata-panel")?.textContent).not.toContain("套餐余额");
  });
});
