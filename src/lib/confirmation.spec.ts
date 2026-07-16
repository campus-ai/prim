import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}));

import { createInterface } from "node:readline/promises";
import { askConfirmation } from "./confirmation.js";

describe("askConfirmation", () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    mockQuestion.mockReset();
    mockClose.mockReset();
    vi.mocked(createInterface).mockClear();
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it("returns false when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    expect(await askConfirmation("test?")).toBe(false);
  });

  it('returns true for "y"', async () => {
    mockQuestion.mockResolvedValue("y");
    expect(await askConfirmation("test?")).toBe(true);
  });

  it('returns true for "yes"', async () => {
    mockQuestion.mockResolvedValue("yes");
    expect(await askConfirmation("test?")).toBe(true);
  });

  it('returns true for "Y" (case-insensitive)', async () => {
    mockQuestion.mockResolvedValue("Y");
    expect(await askConfirmation("test?")).toBe(true);
  });

  it("returns false for empty input", async () => {
    mockQuestion.mockResolvedValue("");
    expect(await askConfirmation("test?")).toBe(false);
  });

  it('returns false for "n"', async () => {
    mockQuestion.mockResolvedValue("n");
    expect(await askConfirmation("test?")).toBe(false);
  });

  it("closes readline interface after use", async () => {
    mockQuestion.mockResolvedValue("y");
    await askConfirmation("test?");
    expect(mockClose).toHaveBeenCalled();
  });

  it("preserves stdout as the default prompt stream", async () => {
    mockQuestion.mockResolvedValue("y");
    await askConfirmation("test?");
    expect(createInterface).toHaveBeenCalledWith({ input: process.stdin, output: process.stdout });
    expect(mockQuestion).toHaveBeenCalledWith("test? [y/N] ");
  });

  it("uses a caller-provided prompt stream", async () => {
    mockQuestion.mockResolvedValue("y");
    await askConfirmation("test?", process.stderr);
    expect(createInterface).toHaveBeenCalledWith({ input: process.stdin, output: process.stderr });
  });
});
