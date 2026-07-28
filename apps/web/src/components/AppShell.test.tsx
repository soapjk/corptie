import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("renders the LAN identity and its nested route", () => {
    const router = createMemoryRouter([{
      path: "/",
      element: <AppShell />,
      children: [{ index: true, element: <h1>Sessions</h1> }]
    }]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
    expect(screen.getByLabelText("Corptie Sessions")).toBeInTheDocument();
    expect(screen.getByText("LAN")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "设置" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
  });
});
