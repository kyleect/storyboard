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

describe("AskUserForm for forms other tools show (tool prompts)", () => {
  const scopeForm: Form = {
    title: 'Save "a.md" where?',
    description: "New markdown file, 3 characters: # A",
    fields: [
      {
        name: "scope",
        label: "Save to",
        required: true,
        noOther: true,
        kind: "choice",
        options: ["session", "project", "global"],
        labels: {
          session: "This conversation only",
          project: 'Every conversation in "Ashfall" (suggested)',
          global: "Every conversation",
        },
        default: "project",
      },
      {
        name: "remember",
        label: "Use this for the rest of this session",
        required: false,
        noOther: true,
        kind: "boolean",
        default: false,
      },
    ],
    submitLabel: "Save",
    skipLabel: "Don't save",
  };

  function openScope() {
    const onAnswer = vi.fn<(a: InputAnswer) => void>();
    renderUi(
      <AskUserForm
        form={scopeForm}
        state={{ mode: "open", requestId: "r1", busy: false, onAnswer }}
      />,
    );
    return onAnswer;
  }

  it("shows option labels, no Other, and the tool's button names", () => {
    const onAnswer = openScope();
    expect(
      screen.getByText("New markdown file, 3 characters: # A"),
    ).toBeTruthy();
    expect(
      (label('Every conversation in "Ashfall" (suggested)') as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.queryByLabelText("Other")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onAnswer).toHaveBeenCalledWith({
      outcome: "answered",
      answers: { scope: "project", remember: false },
    });
  });

  it("draws a yes/no without Other as a checkbox", () => {
    const onAnswer = openScope();
    click("This conversation only");
    click("Use this for the rest of this session");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onAnswer).toHaveBeenCalledWith({
      outcome: "answered",
      answers: { scope: "session", remember: true },
    });
  });

  it("skips with the tool's skip button", () => {
    const onAnswer = openScope();
    fireEvent.click(screen.getByRole("button", { name: "Don't save" }));
    expect(onAnswer).toHaveBeenCalledWith({ outcome: "skipped" });
  });
});

describe("AskUserForm name check (tool prompts Q20)", () => {
  it("shows a pattern error next to the field and does not save", () => {
    const onAnswer = vi.fn<(a: InputAnswer) => void>();
    renderUi(
      <AskUserForm
        form={{
          title: "Save a new file",
          fields: [
            {
              name: "name",
              label: "Name",
              required: true,
              kind: "text",
              multiline: false,
              pattern: "^[A-Za-z0-9._-]+$",
              patternMessage: 'Use only letters, digits, "-", "_" and ".".',
              default: "a/b",
            },
          ],
          submitLabel: "Save",
        }}
        state={{ mode: "open", requestId: "r1", busy: false, onAnswer }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByText('Use only letters, digits, "-", "_" and ".".'),
    ).toBeTruthy();
    expect(onAnswer).not.toHaveBeenCalled();
    type("Name", "a-b");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onAnswer).toHaveBeenCalledWith({
      outcome: "answered",
      answers: { name: "a-b" },
    });
  });
});
