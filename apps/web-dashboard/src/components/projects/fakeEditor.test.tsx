import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RichTextEditor } from "./fakeEditor";

describe("fake editor HTML-to-text conversion", () => {
  it("drops an unterminated tag and keeps preceding or escaped text", () => {
    const { rerender } = render(
      <RichTextEditor ariaLabel="Comment" mentionCandidates={undefined} initialHtml="<p>Visible</p><script" />,
    );
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Visible");

    rerender(
      <RichTextEditor
        key="escaped"
        ariaLabel="Comment"
        mentionCandidates={undefined}
        initialHtml={"<p>&lt;script</p>"}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("<script");
  });
});
