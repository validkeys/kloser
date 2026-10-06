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

/**
 * Type guard to validate StreamEnvelope structure.
 * Ensures parsed JSON conforms to expected stream format.
 */
function isStreamEnvelope(value: unknown): value is StreamEnvelope {
  if (!isRecord(value)) return false;
  
  const record = value as Record<string, unknown>;
  
  // Optional type field must be string
  if ("type" in record && typeof record.type !== "string") return false;
  
  // Optional is_error must be boolean
  if ("is_error" in record && typeof record.is_error !== "boolean") return false;
  
  // Optional session_id must be string
  if ("session_id" in record && typeof record.session_id !== "string") return false;
  
  // Optional event must be object
  if ("event" in record) {
    if (!isRecord(record.event)) return false;
    const event = record.event as Record<string, unknown>;
    
    // event.type must be string if present
    if ("type" in event && typeof event.type !== "string") return false;
    
    // event.delta must be object if present
    if ("delta" in event) {
      if (!isRecord(event.delta)) return false;
      const delta = event.delta as Record<string, unknown>;
      
      // delta.type must be string if present
      if ("type" in delta && typeof delta.type !== "string") return false;
      
      // delta.text must be string if present
      if ("text" in delta && typeof delta.text !== "string") return false;
    }
  }
  
  return true;
}

function parseStreamLine(line: string): StreamEnvelope | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isStreamEnvelope(parsed)) {
      // Malformed stream data - log but continue
      // (Claude may send debug messages that aren't envelopes)
      return undefined;
    }
    return parsed;
  } catch {
    // JSON parse error - not a valid envelope
    return undefined;
  }
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
  let killTimeout: NodeJS.Timeout | undefined;

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
      if (killTimeout) {
        clearTimeout(killTimeout);
        killTimeout = undefined;
      }
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
      if (killTimeout) {
        clearTimeout(killTimeout);
        killTimeout = undefined;
      }
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
      if (child && !child.killed && child.pid) {
        try {
          child.kill("SIGTERM");
          
          // Set timeout for SIGKILL fallback
          killTimeout = setTimeout(() => {
            if (child && !child.killed && child.pid) {
              try {
                child.kill("SIGKILL");
              } catch (err) {
                // Process might already be dead
              }
            }
            killTimeout = undefined;
          }, 2000);
        } catch (err) {
          // Process might already be dead
          if (killTimeout) {
            clearTimeout(killTimeout);
            killTimeout = undefined;
          }
        }
      }
    },
    result,
    sessionId,
  };
}
