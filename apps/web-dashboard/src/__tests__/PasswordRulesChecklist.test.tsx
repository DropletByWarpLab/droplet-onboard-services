import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";

describe("PasswordRulesChecklist", () => {
  it("marks length + classes satisfied for a strong password", () => {
    render(<PasswordRulesChecklist password="Abcdefghijk1" />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.getByText(/Between 12 and 128/)).toBeInTheDocument();
  });

  it("shows a 'passwords match' row when confirm is provided", () => {
    render(<PasswordRulesChecklist password="Abcdefghijk1" confirm="Abcdefghijk1" />);
    expect(screen.getByText(/Passwords match/)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("flags an unmet rule via aria text", () => {
    render(<PasswordRulesChecklist password="short" />);
    expect(screen.getAllByText(/not satisfied/i).length).toBeGreaterThan(0);
  });
});
