import { describe, expect, it } from "vitest";
import { attachedLine, foldMedia, type MediaPolicy } from "./media.js";
import type { Message, ToolResultMessage } from "./messages.js";

const TYPES: Record<string, string> = {
  "session://a.png": "image/png",
  "session://b.png": "image/png",
  "session://c.png": "image/png",
  "session://d.png": "image/png",
  "session://e.png": "image/png",
  "session://v.wav": "audio/wav",
};

const policy = (over: Partial<MediaPolicy> = {}): MediaPolicy => ({
  cap: 4,
  keepDefault: false,
  info: (ref) => (TYPES[ref] ? { mediaType: TYPES[ref] } : undefined),
  ...over,
});

const user = (content: string, files?: string[]): Message => ({
  role: "user",
  content,
  ...(files ? { files } : {}),
});
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const result = (
  callId: string,
  media?: { ref: string; keep?: boolean }[],
): ToolResultMessage => ({
  role: "tool",
  callId,
  name: "files_read",
  content: "x",
  isError: false,
  ...(media ? { media } : {}),
});

describe("attachedLine", () => {
  it("names the file and its type, or that it is gone or cannot be viewed", () => {
    expect(attachedLine("session://a.png", { mediaType: "image/png" })).toBe(
      "[Attached: <session://a.png> (image/png)]",
    );
    expect(attachedLine("session://a.png", undefined)).toBe(
      "[Attached: <session://a.png> (no longer available)]",
    );
    expect(
      attachedLine(
        "session://a.png",
        { mediaType: "image/png" },
        { image: false, audio: true },
      ),
    ).toBe(
      "[Attached: <session://a.png> (image/png). The model in use cannot view images.]",
    );
    expect(
      attachedLine(
        "session://v.wav",
        { mediaType: "audio/wav" },
        { image: true, audio: false },
      ),
    ).toContain("cannot view audio");
  });
});

describe("foldMedia", () => {
  it("does nothing without a policy", () => {
    const m = [
      user("hi", ["session://a.png"]),
      result("c1", [{ ref: "session://b.png" }]),
    ];
    expect(foldMedia(m, undefined)).toEqual(m);
  });

  it("leaves messages without media as they are", () => {
    const m = [user("hi"), assistant("ok"), result("c1")];
    expect(foldMedia(m, policy())).toEqual(m);
  });

  it("keeps this turn's files inline and adds their text reference", () => {
    expect(
      foldMedia(
        [user("look", ["session://a.png", "session://v.wav"])],
        policy(),
      ),
    ).toEqual([
      {
        role: "user",
        content:
          "[Attached: <session://a.png> (image/png)]\n\n[Attached: <session://v.wav> (audio/wav)]\n\nlook",
        files: ["session://a.png", "session://v.wav"],
      },
    ]);
  });

  it("makes a message of files only a message of their references", () => {
    const [m] = foldMedia([user("", ["session://a.png"])], policy());
    expect(m).toEqual({
      role: "user",
      content: "[Attached: <session://a.png> (image/png)]",
      files: ["session://a.png"],
    });
  });

  it("turns an earlier turn's files into text unless they are kept", () => {
    const messages = [
      user("first", ["session://a.png"]),
      assistant("ok"),
      user("second", ["session://b.png"]),
    ];
    const out = foldMedia(messages, policy());
    expect(out[0]).toEqual({
      role: "user",
      content: "[Attached: <session://a.png> (image/png)]\n\nfirst",
    });
    expect(out[2]).toMatchObject({ files: ["session://b.png"] });
  });

  it("keeps an earlier file inline by the user's choice, the agent's keep or the global setting", () => {
    const messages = [
      user("one", ["session://a.png"]),
      assistant("ok"),
      user("two"),
    ];
    const chosen = foldMedia(
      messages,
      policy({ choices: new Map([["session://a.png", true]]) }),
    );
    expect(chosen[0]).toMatchObject({ files: ["session://a.png"] });
    const byDefault = foldMedia(messages, policy({ keepDefault: true }));
    expect(byDefault[0]).toMatchObject({ files: ["session://a.png"] });
    // The user's choice wins over the global setting.
    const dropped = foldMedia(
      messages,
      policy({
        keepDefault: true,
        choices: new Map([["session://a.png", false]]),
      }),
    );
    expect(dropped[0]).not.toHaveProperty("files");

    const read = [
      user("one"),
      result("c1", [{ ref: "session://b.png", keep: true }]),
      assistant("ok"),
      user("two"),
    ];
    const kept = foldMedia(read, policy());
    expect(kept[2]).toMatchObject({ files: ["session://b.png"] });
    // The user can still drop what the agent kept.
    const unkept = foldMedia(
      read,
      policy({ choices: new Map([["session://b.png", false]]) }),
    );
    expect(unkept[2]).not.toHaveProperty("files");
  });

  it("keeps only the newest items inline when more are kept than the cap", () => {
    const messages: Message[] = [
      user("1", ["session://a.png"]),
      assistant("."),
      user("2", ["session://b.png"]),
      assistant("."),
      user("3", ["session://c.png"]),
      assistant("."),
      user("4", ["session://d.png"]),
    ];
    const out = foldMedia(messages, policy({ cap: 2, keepDefault: true }));
    const inline = out.flatMap((m) =>
      m.role === "user" ? (m.files ?? []) : [],
    );
    // The newest two kept items from earlier turns, and this turn's.
    expect(inline).toEqual([
      "session://b.png",
      "session://c.png",
      "session://d.png",
    ]);
    expect(out[0]).not.toHaveProperty("files");
  });

  it("adds a tool turn's media in a user message after the results", () => {
    const out = foldMedia(
      [
        user("read it"),
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              callId: "c1",
              name: "files_read",
              arguments: {},
            },
            {
              type: "tool_call",
              callId: "c2",
              name: "files_read",
              arguments: {},
            },
          ],
        },
        result("c1", [{ ref: "session://a.png" }]),
        result("c2", [{ ref: "session://v.wav" }]),
      ],
      policy(),
    );
    expect(out).toHaveLength(5);
    expect(out[4]).toEqual({
      role: "user",
      content:
        "Media from the tool results above:\n[Attached: <session://a.png> (image/png)]\n[Attached: <session://v.wav> (audio/wav)]",
      files: ["session://a.png", "session://v.wav"],
    });
  });

  it("merges media from results before a new user message into that message, as text", () => {
    const out = foldMedia(
      [
        user("go"),
        result("c1", [{ ref: "session://a.png" }]),
        user("and then"),
      ],
      policy(),
    );
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({
      role: "user",
      content:
        "Media from the tool results above:\n[Attached: <session://a.png> (image/png)]\n\nand then",
    });
  });

  it("sends an earlier turn's tool media as text only", () => {
    const out = foldMedia(
      [
        user("one"),
        result("c1", [{ ref: "session://a.png" }]),
        assistant("ok"),
        user("two"),
      ],
      policy(),
    );
    expect(out[2]).toEqual({
      role: "user",
      content:
        "Media from the tool results above:\n[Attached: <session://a.png> (image/png)]",
    });
  });

  it("does not treat a reminder as a new turn", () => {
    const out = foldMedia(
      [
        user("task", ["session://a.png"]),
        assistant("working"),
        { role: "user", content: "Hand back now.", source: "reminder" },
      ],
      policy(),
    );
    expect(out[0]).toMatchObject({ files: ["session://a.png"] });
  });

  it("does not send what the model cannot read, and says so", () => {
    const out = foldMedia(
      [
        user("look", ["session://a.png", "session://v.wav"]),
        result("c1", [{ ref: "session://b.png" }]),
      ],
      policy({ support: { image: false, audio: true } }),
    );
    expect(out[0]).toMatchObject({
      files: ["session://v.wav"],
      content: expect.stringContaining("cannot view images"),
    });
    expect(out[2]).toEqual({
      role: "user",
      content:
        "Media from the tool results above:\n[Attached: <session://b.png> (image/png). The model in use cannot view images.]",
    });
  });

  it("gives a model that cannot view a file its text, when it has one", () => {
    const [m] = foldMedia(
      [user("look", ["session://a.png"])],
      policy({
        support: { image: false, audio: true },
        info: () => ({ mediaType: "image/png", derivedText: " A cat. " }),
      }),
    );
    expect(m).toEqual({
      role: "user",
      content:
        "[Attached: <session://a.png> (image/png). The model in use cannot view images. Its text: A cat.]\n\nlook",
    });
  });

  it("names a file that is gone instead of sending it", () => {
    const [m] = foldMedia([user("look", ["session://gone.png"])], policy());
    expect(m).toEqual({
      role: "user",
      content: "[Attached: <session://gone.png> (no longer available)]\n\nlook",
    });
  });

  it("does not change the messages it is given", () => {
    const messages = [user("look", ["session://a.png"])];
    const copy = structuredClone(messages);
    foldMedia(messages, policy());
    expect(messages).toEqual(copy);
  });
});
