import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Branching as BranchingInfo } from "../../../api";
import {
  BranchSwitcher,
  Continuations,
  EditMessageBox,
  ForkedFromLine,
  forkTitle,
  MessageActions,
  openForkDialog,
} from "./Branching";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params: Record<string, string>;
    children?: React.ReactNode;
  }) => (
    <a href={to.replace("$sessionId", params.sessionId ?? "")} {...rest}>
      {children}
    </a>
  ),
}));

/*
 * The controls on their own: which actions each message is offered, what the
 * edit box sends, and how the "2/3" control moves between branches.
 */

afterEach(() => vi.restoreAllMocks());

function ui(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <ModalsProvider>{node}</ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

const branching = (over: Partial<BranchingInfo> = {}): BranchingInfo => ({
  points: [],
  editable: [],
  regenerate: null,
  continuations: [],
  ...over,
});

describe("MessageActions", () => {
  const handlers = {
    onEdit: vi.fn(),
    onBranchOff: vi.fn(),
    onFork: vi.fn(),
    onRegenerate: vi.fn(),
  };

  it("offers Edit on the user's own messages and Branch off at points", () => {
    ui(
      <MessageActions
        messageId="m1"
        branching={branching({ points: ["m1"], editable: ["m1"] })}
        last={false}
        {...handlers}
      />,
    );
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Branch off"));
    fireEvent.click(screen.getByText("Fork"));
    expect(handlers.onEdit).toHaveBeenCalled();
    expect(handlers.onBranchOff).toHaveBeenCalled();
    expect(handlers.onFork).toHaveBeenCalled();
    expect(screen.queryByText("Regenerate")).toBeNull();
  });

  it("offers Regenerate on the last message when there is a turn to redo", () => {
    ui(
      <MessageActions
        messageId="m2"
        branching={branching({ regenerate: "m1" })}
        last
        {...handlers}
      />,
    );
    fireEvent.click(screen.getByText("Regenerate"));
    expect(handlers.onRegenerate).toHaveBeenCalled();
  });

  it("offers nothing on a message that is not a point", () => {
    ui(
      <MessageActions
        messageId="m3"
        branching={branching({ points: ["m1"], regenerate: "m1" })}
        last={false}
        {...handlers}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("EditMessageBox", () => {
  it("saves in the default mode, or the other from the menu", async () => {
    const onSave = vi.fn();
    ui(
      <EditMessageBox
        initial="Hello"
        hasFiles={false}
        defaultMode="branch"
        saving={false}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Message text"), {
      target: { value: "Hello there" },
    });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalledWith("Hello there", "branch");

    fireEvent.click(screen.getByLabelText("Save another way"));
    fireEvent.click(await screen.findByText(/Save in place/));
    expect(onSave).toHaveBeenLastCalledWith("Hello there", "in_place");
  });

  it("cannot save an empty message unless it has files", () => {
    const { unmount } = ui(
      <EditMessageBox
        initial=""
        hasFiles={false}
        defaultMode="branch"
        saving={false}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      screen.getByText("Save").closest("button")?.hasAttribute("disabled"),
    ).toBe(true);
    unmount();
    ui(
      <EditMessageBox
        initial=""
        hasFiles
        defaultMode="branch"
        saving={false}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      screen.getByText("Save").closest("button")?.hasAttribute("disabled"),
    ).toBe(false);
  });

  it("calls onCancel", () => {
    const onCancel = vi.fn();
    ui(
      <EditMessageBox
        initial="x"
        hasFiles={false}
        defaultMode="in_place"
        saving={false}
        onSave={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("BranchSwitcher", () => {
  it("shows the place among the branches and moves to the neighbours", () => {
    const onSwitch = vi.fn();
    ui(
      <BranchSwitcher
        branches={{ ids: ["a", "b", "c"], index: 1 }}
        disabled={false}
        onSwitch={onSwitch}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByText("2/3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Previous branch"));
    expect(onSwitch).toHaveBeenLastCalledWith("a");
    fireEvent.click(screen.getByLabelText("Next branch"));
    expect(onSwitch).toHaveBeenLastCalledWith("c");
  });

  it("has no previous on the first or next on the last", () => {
    ui(
      <BranchSwitcher
        branches={{ ids: ["a", "b"], index: 0 }}
        disabled={false}
        onSwitch={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(
      screen.getByLabelText("Previous branch").hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByLabelText("Next branch").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("deletes the shown branch after a confirmation", async () => {
    const onDelete = vi.fn();
    ui(
      <BranchSwitcher
        branches={{ ids: ["a", "b"], index: 1 }}
        disabled={false}
        onSwitch={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByText("Delete branch"));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete branch",
      }),
    );
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("b"));
  });
});

describe("Continuations", () => {
  it("lists what else continues from the end and switches to it", () => {
    const onSwitch = vi.fn();
    ui(
      <Continuations
        items={[{ id: "x", role: "user", preview: "And then?" }]}
        disabled={false}
        onSwitch={onSwitch}
      />,
    );
    fireEvent.click(screen.getByText(/And then\?/));
    expect(onSwitch).toHaveBeenCalledWith("x");
  });

  it("shows nothing when there are none", () => {
    ui(<Continuations items={[]} disabled={false} onSwitch={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("forking", () => {
  it("asks for a title, starting from the session's, and forks with it", async () => {
    const onCreate = vi.fn();
    ui(<div />);
    act(() => openForkDialog("My story", onCreate));
    const box = (await screen.findByLabelText(
      "Title of the new session",
    )) as HTMLInputElement;
    expect(box.value).toBe(forkTitle("My story"));
    expect(box.value).toBe("My story (fork)");
    fireEvent.change(box, { target: { value: "  Other draft " } });
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Fork",
      }),
    );
    expect(onCreate).toHaveBeenCalledWith("Other draft");
  });

  it("does not fork with an empty title", async () => {
    const onCreate = vi.fn();
    ui(<div />);
    act(() => openForkDialog("My story", onCreate));
    const box = await screen.findByLabelText("Title of the new session");
    fireEvent.change(box, { target: { value: "   " } });
    expect(
      within(screen.getByRole("dialog"))
        .getByRole("button", { name: "Fork" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("ForkedFromLine", () => {
  it("links to the session it came from", () => {
    ui(
      <ForkedFromLine from={{ id: "s0", title: "Original", state: "live" }} />,
    );
    expect(
      screen.getByRole("link", { name: "Original" }).getAttribute("href"),
    ).toBe("/sessions/s0");
  });

  it("says when that session is in the Trash", () => {
    ui(
      <ForkedFromLine
        from={{ id: "s0", title: "Original", state: "trashed" }}
      />,
    );
    expect(screen.getByRole("link", { name: "Original" })).toBeTruthy();
    expect(screen.getByText(/in the Trash/)).toBeTruthy();
  });

  it("shows the old title without a link when it is gone", () => {
    ui(
      <ForkedFromLine from={{ id: "s0", title: "Original", state: "gone" }} />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Original \(deleted\)/)).toBeTruthy();
  });
});
