import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";

export interface RunPythonResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunPythonEnvironment = Record<string, string | undefined>;

/**
 * Run a Python entrypoint with JSON on stdin and return both output streams.
 * An explicit environment replaces the inherited environment when supplied.
 */
export function runPython(
  scriptRelPath: string,
  argv: readonly string[],
  stdinJson: unknown,
  cwd: string,
  env?: RunPythonEnvironment,
  timeoutMs?: number,
): Promise<RunPythonResult> {
  return new Promise((resolve) => {
    let stdinError = "";
    const child = execFile(
      "python3",
      [scriptRelPath, ...argv],
      { cwd, ...(env ? { env } : {}), ...(timeoutMs ? { timeout: timeoutMs } : {}) },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        let code = 0;
        if (error) {
          code = typeof error.code === "number" ? error.code : 1;
        }
        resolve({
          code: stdinError && code === 0 ? 1 : code,
          stdout,
          stderr: [stderr, stdinError].filter(Boolean).join("\n"),
        });
      },
    );
    child.stdin?.on("error", (error) => {
      stdinError = error instanceof Error ? error.message : String(error);
    });
    try {
      child.stdin?.end(JSON.stringify(stdinJson));
    } catch (error) {
      stdinError = error instanceof Error ? error.message : String(error);
    }
  });
}
