import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { Avatar } from "@/components/ui/avatar";

describe("Avatar", () => {
  it("exposes the user's name to assistive tech", () => {
    render(<Avatar name="Priya Sharma" id="user-1" />);
    const img = screen.getByRole("img", { name: "Priya Sharma" });
    expect(img).toBeInTheDocument();
  });

  it("renders initials when no image is provided", () => {
    render(<Avatar name="Arun Kumar" id="user-2" />);
    expect(screen.getByText("AK")).toBeInTheDocument();
  });

  it("renders an <img> when an image URL is provided", () => {
    const { container } = render(
      <Avatar name="Prasanna" id="user-3" image="https://example.com/a.png" />,
    );
    const inner = container.querySelector("img");
    expect(inner).toHaveAttribute("alt", "Prasanna");
    expect(inner).toHaveAttribute("src", "https://example.com/a.png");
  });
});
