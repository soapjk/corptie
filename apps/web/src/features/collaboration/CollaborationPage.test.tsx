import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCollaborationOverview, getCollaborationTask } from "../../lib/api/client";
import { CollaborationPage } from "./CollaborationPage";

vi.mock("../../lib/api/client", () => ({
  getCollaborationOverview: vi.fn(),
  getCollaborationTask: vi.fn(),
  performCollaborationAction: vi.fn()
}));

describe("CollaborationPage", () => {
  afterEach(cleanup);
  it("shows overview and a task timeline", async () => {
    vi.mocked(getCollaborationOverview).mockResolvedValue({
      apiVersion: "1", eventCursor: 2,
      agents: [{ agentId: "a" }], services: [{ serviceId: "s" }],
      tasks: [{ taskId: "t", title: "Review API", status: "working", type: "change_request" }]
    });
    vi.mocked(getCollaborationTask).mockResolvedValue({
      apiVersion: "1", eventCursor: 2,
      task: { taskId: "t", title: "Review API", status: "working", messages: [{ messageId: "m", messageType: "reply", body: "Looks good" }] },
      deliveries: [{ deliveryId: "d", status: "failed", lastError: "offline" }]
    });
    render(<QueryClientProvider client={new QueryClient()}><CollaborationPage /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Review API/ }));
    expect(await screen.findByText("Looks good")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
