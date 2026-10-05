import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { isRecord } from "./util";

export interface ClaudeRunHandle {
  readonly result: Promise<string>;
  readonly sessionId: Promise<string | undefined>;
  cancel(): void;
}

export interface ClaudeRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  executable: string;
  extraArgs: string[];
  model?: string;
  onDelta?: (text: string) => void;
  prompt: string;
  resumeSessionId?: string;
}

export class ClaudeRunError extends Error {
  constructor(
    message: string,
    readonly cancelled: boolean,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ClaudeRunError";
  }
}

interface StreamDelta {
  type?: string;
  text?: string;
}

interface StreamEvent {
  delta?: StreamDelta;
  type?: string;
}

interface StreamEnvelope {
  event?: StreamEvent;
  is_error?: boolean;
  result?: unknown;
  session_id?: string;
  type?: string;
}

function parseStreamLine(line: string): StreamEnvelope | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isRecord(parsed)) {
      return parsed as StreamEnvelope;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function runClaude(options: ClaudeRunOptions): ClaudeRunHandle {
  const streaming = options.onDelta !== undefined;
  const args = ["-p"];
  if (streaming) {
    args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");
  } else {
    args.push("--output-format", "text");
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  args.push(...options.extraArgs, options.prompt);

  let child: ChildProcess | undefined;
  let cancelled = false;
  let finalResult: string | undefined;
  let resultError = false;
  let streamedText = "";

  let resolveSessionId: (sessionId: string | undefined) => void = () => {};
  const sessionId = new Promise<string | undefined>((resolve) => {
    resolveSessionId = resolve;
  });

  const result = new Promise<string>((resolve, reject) => {
    child = spawn(options.executable, args, { cwd: options.cwd, env: options.env });

    let stdout = "";
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (streaming && child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (!line.trim()) {
          return;
        }
        const envelope = parseStreamLine(line);
        if (!envelope) {
          return;
        }
        if (typeof envelope.session_id === "string") {
          resolveSessionId(envelope.session_id);
        }
        if (
          envelope.type === "stream_event" &&
          envelope.event?.type === "content_block_delta" &&
          envelope.event.delta?.type === "text_delta"
        ) {
          const text = envelope.event.delta.text ?? "";
          if (text) {
            streamedText += text;
            options.onDelta?.(text);
          }
          return;
        }
        if (envelope.type === "result") {
          resultError = envelope.is_error === true;
          if (typeof envelope.result === "string") {
            finalResult = envelope.result;
          }
        }
      });
    } else if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
    }

    child.on("error", (error: NodeJS.ErrnoException) => {
      resolveSessionId(undefined);
      reject(
        new ClaudeRunError(
          `Failed to start "${options.executable}": ${error.message}. ` +
            "Is Claude Code installed and on PATH? You can set kloser.claudeExecutable to an absolute path.",
          false,
          stderr,
        ),
      );
    });

    child.on("close", (code, signal) => {
      resolveSessionId(undefined);
      if (cancelled || signal === "SIGTERM" || signal === "SIGKILL") {
        reject(new ClaudeRunError("Request cancelled", true, stderr));
        return;
      }
      if (code === 0 && !resultError) {
        resolve(streaming ? (finalResult ?? streamedText) : stdout);
        return;
      }
      const fallback = streaming ? (finalResult ?? streamedText) : stdout;
      const detail = (stderr || fallback).trim().slice(0, 2000);
      reject(
        new ClaudeRunError(
          `claude request failed (exit ${code ?? "unknown"}${resultError ? ", api error" : ""}): ${detail}`,
          false,
          stderr,
        ),
      );
    });
  });

  return {
    cancel(): void {
      cancelled = true;
      if (child && !child.killed) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child && !child.killed) {
            child.kill("SIGKILL");
          }
        }, 2000);
      }
    },
    result,
    sessionId,
  };
}
