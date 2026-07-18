import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SchedulePresetCards } from "../SchedulePresetCards";
import { presetById } from "../schedule-presets";

describe("SchedulePresetCards", () => {
  it("renders three cards with the preset names", () => {
    render(
      <SchedulePresetCards
        onUseRecurring={vi.fn()}
        onUseOverride={vi.fn()}
      />,
    );
    expect(screen.getByText("Bedtime")).toBeInTheDocument();
    expect(screen.getByText("School hours")).toBeInTheDocument();
    expect(screen.getByText("Focus mode")).toBeInTheDocument();
  });

  it("clicking Use preset on Bedtime calls onUseRecurring with the Bedtime preset", () => {
    const onUseRecurring = vi.fn();
    const onUseOverride = vi.fn();
    render(
      <SchedulePresetCards
        onUseRecurring={onUseRecurring}
        onUseOverride={onUseOverride}
      />,
    );
    const bedtimeCard = screen.getByTestId("preset-card-bedtime");
    fireEvent.click(
      bedtimeCard.querySelector("button")!,
    );
    expect(onUseRecurring).toHaveBeenCalledTimes(1);
    expect(onUseRecurring).toHaveBeenCalledWith(presetById("bedtime"));
    expect(onUseOverride).not.toHaveBeenCalled();
  });

  it("clicking Use preset on School calls onUseRecurring with the School preset", () => {
    const onUseRecurring = vi.fn();
    const onUseOverride = vi.fn();
    render(
      <SchedulePresetCards
        onUseRecurring={onUseRecurring}
        onUseOverride={onUseOverride}
      />,
    );
    const schoolCard = screen.getByTestId("preset-card-school");
    fireEvent.click(schoolCard.querySelector("button")!);
    expect(onUseRecurring).toHaveBeenCalledTimes(1);
    expect(onUseRecurring).toHaveBeenCalledWith(presetById("school"));
    expect(onUseOverride).not.toHaveBeenCalled();
  });

  it("clicking Use preset on Homework calls onUseOverride with the Homework preset", () => {
    const onUseRecurring = vi.fn();
    const onUseOverride = vi.fn();
    render(
      <SchedulePresetCards
        onUseRecurring={onUseRecurring}
        onUseOverride={onUseOverride}
      />,
    );
    const homeworkCard = screen.getByTestId("preset-card-homework");
    fireEvent.click(homeworkCard.querySelector("button")!);
    expect(onUseOverride).toHaveBeenCalledTimes(1);
    expect(onUseOverride).toHaveBeenCalledWith(presetById("homework"));
    expect(onUseRecurring).not.toHaveBeenCalled();
  });

  it("renders a Lucide icon for each preset", () => {
    render(
      <SchedulePresetCards
        onUseRecurring={vi.fn()}
        onUseOverride={vi.fn()}
      />,
    );
    expect(screen.getByTestId("preset-icon-bedtime")).toBeInTheDocument();
    expect(screen.getByTestId("preset-icon-school")).toBeInTheDocument();
    expect(screen.getByTestId("preset-icon-homework")).toBeInTheDocument();
  });
});
