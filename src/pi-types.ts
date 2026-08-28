/**
 * Small structural surface consumed by this package. Keeping public
 * declarations on this boundary avoids coupling consumers to Pi's complete
 * provider/type graph while remaining assignable from Pi's runtime objects.
 */
export interface PiExtensionContext {
  readonly cwd: string;
  readonly sessionManager: { getSessionId(): string | undefined };
  readonly model?: { readonly id?: string };
  readonly getContextUsage: () => { readonly contextWindow?: number } | undefined;
  readonly ui: {
    readonly theme: { fg(color: string, value: string): string };
    setStatus(key: string, value: string): void;
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}

export interface PiExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PiExtensionAPI {
  on(event: string, handler: (...args: any[]) => unknown): void;
  exec(
    command: string,
    argv: readonly string[],
    options: { readonly cwd: string; readonly timeout: number },
  ): Promise<PiExecResult>;
  appendEntry(customType: string, data?: unknown): void;
  sendMessage(message: {
    readonly customType: string;
    readonly content: string;
    readonly display: boolean;
  }): void | Promise<void>;
  sendUserMessage(
    content: string,
    options?: { readonly deliverAs?: "steer" | "followUp" },
  ): unknown;
}

export interface PiToolResultEvent {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly isError: boolean;
}

export interface PiSessionShutdownEvent {
  readonly reason: string;
}

export interface PiAgentEndEvent {
  readonly messages: readonly unknown[];
}

export interface PiInputEvent {
  readonly text: string;
  readonly source: string;
  readonly streamingBehavior: string;
}

export interface PiMessageStartEvent {
  readonly message: unknown;
}
