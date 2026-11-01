import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Form, InputAnswer } from "@harness/core";
import { AskUserForm } from "./AskUserForm";

const renderUi = (ui: ReactElement) =>
  render(<MantineProvider>{ui}</MantineProvider>);

const form: Form = {
  title: "Story",
  fields: [
    {
      name: "title",
      label: "Working title",
      required: true,
      kind: "text",
      multiline: false,
    },
    {
      name: "genre",
      label: "Genre",
      required: false,
      kind: "choice",
      options: ["noir", "sci-fi"],
    },
    {
      name: "themes",
      label: "Themes",
      required: false,
      kind: "multi",
      options: ["loss", "home"],
    },
    {
      name: "words",
      label: "Words",
      required: false,
      kind: "number",
      integer: true,
    },
    { name: "dark", label: "Dark?", required: false, kind: "boolean" },
  ],
};

function open() {
  const onAnswer = vi.fn<(a: InputAnswer) => void>();
  renderUi(
    <AskUserForm
      form={form}
      state={{ mode: "open", requestId: "r1", busy: false, onAnswer }}
    />,
  );
  return onAnswer;
}

/** A label, with or without the required mark. */
const label = (text: string) =>
  screen.getByLabelText(
    new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\*?$`),
  );
const type = (text: string, value: string) =>
  fireEvent.change(label(text), { target: { value } });
const click = (text: string) => fireEvent.click(label(text));
const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));

describe("AskUserForm", () => {
  it("submits the answers, leaving unanswered questions out", () => {
    const onAnswer = open();
    type("Working title", "Ash");
    click("noir");
    click("loss");
    click("Yes");
    submit();
    expect(onAnswer).toHaveBeenCalledWith({
      outcome: "answered",
      answers: { title: "Ash", genre: "noir", themes: ["loss"], dark: true },
    });
  });

  it('offers "Other" on every question but text, sent as free text', () => {
    const onAnswer = open();
    type("Working title", "Ash");
    // Choice, multi-choice and yes/no each have an "Other" option.
    const others = screen.getAllByLabelText("Other");
    expect(others).toHaveLength(4);
    for (const o of others) fireEvent.click(o);
    type("Genre: other", "cozy mystery");
    type("Themes: other", "found family");
    type("Words", "about 3000");
    type("Dark?: other", "a little");
    submit();
    expect(onAnswer).toHaveBeenCalledWith({
      outcome: "answered",
      answers: {
        title: "Ash",
        genre: "cozy mystery",
        themes: ["found family"],
        words: "about 3000",
        dark: "a little",
      },
    });
  });

  it("shows problems next to the questions and does not submit", () => {
    const onAnswer = open();
    // The choice's "Other", left empty.
    fireEvent.click(screen.getAllByLabelText("Other")[0] as HTMLElement);
    submit();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText("Answer this question.")).toBeTruthy();
    expect(screen.getByText('Write your answer in "Other".')).toBeTruthy();
  });

  it("skips", () => {
    const onAnswer = open();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onAnswer).toHaveBeenCalledWith({ outcome: "skipped" });
  });

  it("uses a dropdown for long choice lists, with Other… as the last item", async () => {
    const long: Form = {
      fields: [
        {
          name: "g",
          label: "Genre",
          required: true,
          kind: "choice",
          options: ["a", "b", "c", "d", "e", "f", "g"],
        },
      ],
    };
    renderUi(
      <AskUserForm
        form={long}
        state={{
          mode: "open",
          requestId: "r1",
          busy: false,
          onAnswer: () => {},
        }}
      />,
    );
    expect(screen.queryByRole("radio")).toBeNull();
    // The input and its list both carry the label; the input comes first.
    fireEvent.click(screen.getAllByLabelText(/^Genre/)[0] as HTMLElement);
    const items = await screen.findAllByRole("option", { hidden: true });
    expect(items.at(-1)?.textContent).toBe("Other…");
  });

  it("shows answered forms read-only, with Other answers in their boxes", () => {
    renderUi(
      <AskUserForm
        form={form}
        state={{
          mode: "answered",
          answers: { title: "Ash", genre: "cozy mystery", words: 1200 },
        }}
      />,
    );
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    const title = label("Working title") as HTMLInputElement;
    expect(title.value).toBe("Ash");
    expect(title.disabled).toBe(true);
    expect((label("Genre: other") as HTMLInputElement).value).toBe(
      "cozy mystery",
    );
    expect((label("Words") as HTMLInputElement).value).toBe("1200");
  });

  it("marks a skipped form", () => {
    renderUi(<AskUserForm form={form} state={{ mode: "skipped" }} />);
    expect(screen.getByText("Skipped")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });
});
