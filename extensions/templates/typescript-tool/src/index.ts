/**
 * The extension's entry point. `run` is what the box calls with the tool's
 * arguments; return plain JSON the assistant can read back.
 */
export interface Input {
  readonly text: string;
}

export interface Output {
  readonly words: number;
  readonly characters: number;
}

export function run(input: Input): Output {
  const text = String(input.text ?? "");
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  return { words, characters: text.length };
}
