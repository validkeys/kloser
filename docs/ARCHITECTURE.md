# Kloser Architecture Overview

**Version:** 1.0  
**Last Updated:** October 6, 2026  
**Status:** Production Ready

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Core Components](#core-components)
3. [Data Flow](#data-flow)
4. [State Management](#state-management)
5. [Security Architecture](#security-architecture)
6. [Extension Points](#extension-points)
7. [Error Handling](#error-handling)

---

## System Overview

Kloser is a VS Code extension that provides AI-powered code completion and review through the Claude Code CLI. It enables developers to:

- Request code completions with natural language instructions
- Stream incremental updates in real-time
- Accept, reject, or redirect completions
- Review code and PR changes with AI assistance

### Architecture Principles

1. **Security First**: All inputs validated, no command injection vectors
2. **Resource Safety**: Proper cleanup, disposal guards, no leaks
3. **Type Safety**: Strict TypeScript, comprehensive validation
4. **User Experience**: Non-blocking operations, clear feedback
5. **Maintainability**: Small focused modules, clear responsibilities

---

## Core Components

### 1. RequestManager

**Location:** `src/requestManager.ts`  
**Responsibility:** Manages streaming code completion requests

```
┌─────────────────────┐
│  RequestManager     │
├─────────────────────┤
│ - active: Stream?   │
│ - handles: Map      │
│ - disposed: boolean │
├─────────────────────┤
│ + start()           │
│ + accept()          │
│ + reject()          │
│ + redirect()        │
│ + stopAll()         │
│ + dispose()         │
└─────────────────────┘
```

**Key Behaviors:**
- Tracks single active stream (one at a time)
- Manages multiple background handles
- Validates configuration before starting
- Prevents operations after disposal
- Handles config errors gracefully

**State Management:**
```
streaming → pending → finalizing (accept)
streaming → finalizing (reject)
streaming → redirecting → streaming (redirect)
```

### 2. StreamApplier

**Location:** `src/streamApplier.ts`  
**Responsibility:** Applies streaming text updates to the editor

```
┌─────────────────────┐
│  StreamApplier      │
├─────────────────────┤
│ - uri: Uri          │
│ - range: Range      │
│ - originalText: str │
│ - pendingText?: str │
│ - timer?: Timeout   │
│ - disposed: boolean │
├─────────────────────┤
│ + update()          │
│ + finalize()        │
│ + restore()         │
│ + adjustForChanges()│
│ + dispose()         │
└─────────────────────┘
```

**Key Behaviors:**
- Throttles updates (80ms) to reduce editor churn
- Tracks range as document changes
- Restores original text on reject
- Manages undo stops for user experience
- Queues operations to prevent race conditions

### 3. StreamStateMachine

**Location:** `src/streamState.ts`  
**Responsibility:** Enforces valid state transitions

```
┌──────────────────────────────────────────┐
│         StreamStateMachine               │
├──────────────────────────────────────────┤
│                                          │
│  streaming ──→ settling ──→ accepting    │
│       │            │   └──→ rejecting    │
│       │            └──→ redirecting      │
│       └──→ failed                        │
│                                          │
│  Terminal states: completed, failed      │
│                                          │
└──────────────────────────────────────────┘
```

**Key Behaviors:**
- Validates all state transitions
- Executes operations atomically
- Rolls back state on operation failure
- Serializes concurrent transitions
- Allows retry after failures

### 4. DecorationManager

**Location:** `src/decorationManager.ts`  
**Responsibility:** Visual feedback for active streams

```
┌─────────────────────┐
│ DecorationManager   │
├─────────────────────┤
│ - active: Map       │
│ - lingerDone: Map   │
│ - timers: Set       │
├─────────────────────┤
│ + track()           │
│ + setStatus()       │
│ + settle()          │
│ + remove()          │
│ + dispose()         │
└─────────────────────┘
```

**Key Behaviors:**
- Animated gutter icons (spinner, checkmark, error)
- Linger effect after completion
- Tracks all timers for cleanup
- Removes decorations on dispose

### 5. Validation Module

**Location:** `src/pr/validation.ts`  
**Responsibility:** Security-focused input validation

```
┌─────────────────────────────┐
│      Validation             │
├─────────────────────────────┤
│ validatePRNumber()          │
│ validateFilePath()          │
│ sanitizeGitReference()      │
│ validateWorkspacePath()     │
└─────────────────────────────┘
```

**Key Behaviors:**
- Prevents command injection
- Prevents path traversal
- Validates all external inputs
- Clear error messages for users

### 6. Configuration Module

**Location:** `src/config.ts`  
**Responsibility:** Type-safe configuration management

```
┌─────────────────────────────┐
│      Configuration          │
├─────────────────────────────┤
│ getKloserConfig()           │
│   - Validates contextLines  │
│   - Validates extraArgs     │
│   - Validates env           │
│ buildChildEnv()             │
└─────────────────────────────┘
```

**Key Behaviors:**
- Validates all config values
- Throws ConfigError on invalid config
- Merges environment variables
- Handles Bedrock-specific settings

---

## Data Flow

### Code Completion Flow

```
┌─────────┐
│  User   │
│ (Ctrl+  │
│ Shift+9)│
└────┬────┘
     │
     ├─→ extension.ts: completeSelection command
     │
     ├─→ promptForInstruction()
     │       └─→ User enters instruction
     │
     ├─→ RequestManager.start(editor, range, instruction)
     │       ├─→ getKloserConfig() (validate)
     │       ├─→ extractContext(document, range)
     │       ├─→ buildReplacementPrompt()
     │       └─→ dispatch(stream, prompt)
     │
     ├─→ runClaude()
     │       ├─→ spawn("claude", args)
     │       ├─→ Stream JSON lines
     │       └─→ onDelta(text) callback
     │
     ├─→ StreamApplier.update(text)
     │       ├─→ Throttle (80ms)
     │       ├─→ Queue operation
     │       └─→ editor.edit()
     │
     ├─→ User presses Tab (accept)
     │       └─→ RequestManager.accept()
     │               ├─→ StreamApplier.finalize()
     │               └─→ cleanup()
     │
     └─→ OR User presses Esc (reject)
             └─→ RequestManager.reject()
                     ├─→ StreamApplier.restore()
                     └─→ cleanup()
```

### PR Review Flow

```
┌─────────┐
│  User   │
│ (Ctrl+  │
│ Shift+8)│
└────┬────┘
     │
     ├─→ extension.ts: codeReview command
     │
     ├─→ ReviewManager.start(editor, range)
     │       ├─→ extractContext()
     │       ├─→ buildReviewPrompt()
     │       └─→ runClaude()
     │
     ├─→ ReviewWebview.show()
     │       ├─→ Stream markdown to webview
     │       └─→ Render with marked.js
     │
     └─→ User interacts
             ├─→ Click apply code button
             │       └─→ applyCodeBlock()
             └─→ Enter follow-up question
                     └─→ onInput callback
```

---

## State Management

### Request States

RequestManager uses a simple string-based state system:

```typescript
type StreamState = "streaming" | "pending" | "redirecting" | "finalizing";
```

**State Transitions:**
- `streaming`: Initial state, receiving data
- `pending`: Stream complete, awaiting user decision
- `redirecting`: User correcting the stream
- `finalizing`: Accept/reject in progress

**Validation:**
- Operations check state before executing
- Disposed flag prevents use-after-free
- Active stream tracked separately

### Stream State Machine

StreamStateMachine provides stronger guarantees:

```typescript
type StreamStatus = 
  | "streaming" | "settling" | "accepting" 
  | "rejecting" | "redirecting" | "completed" | "failed";
```

**Benefits:**
- Enforces valid transitions at runtime
- Atomic operation execution
- Automatic rollback on failure
- Serializes concurrent operations

**Integration:**
- Currently used standalone for testing/validation
- Can be integrated into RequestManager in future
- Already proven reliable with 27 passing tests

---

## Security Architecture

### Defense in Depth

Kloser implements multiple security layers:

#### Layer 1: Input Validation

**Location:** `src/pr/validation.ts`

```typescript
// All external inputs validated
validatePRNumber(userInput)      // Command injection prevention
validateFilePath(path)           // Path traversal prevention
sanitizeGitReference(ref)        // Git command injection prevention
validateWorkspacePath(root, path) // Sandbox enforcement
```

#### Layer 2: Configuration Validation

**Location:** `src/config.ts`

```typescript
// All config values validated
getKloserConfig()
  ├─→ contextLines: 0-1000 integer
  ├─→ extraArgs: string[] only
  └─→ env: string values only
```

#### Layer 3: Resource Safety

**Disposal guards:**
```typescript
class Manager {
  private disposed = false;

  public operation(): void {
    if (this.disposed) return; // Safe no-op
    // ... do work
  }

  public dispose(): void {
    if (this.disposed) return; // Idempotent
    this.disposed = true;
    // ... cleanup
  }
}
```

#### Layer 4: Type Safety

```typescript
// Comprehensive type guards
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" 
    && value !== null 
    && !Array.isArray(value); // Arrays rejected
}

function isStreamEnvelope(value: unknown): value is StreamEnvelope {
  // Validates all fields recursively
  if (!isRecord(value)) return false;
  // ... detailed checks
}
```

### Security Checklist

- [x] All user inputs validated
- [x] All file paths validated
- [x] All git references sanitized
- [x] All config values validated
- [x] No command injection vectors
- [x] No path traversal vectors
- [x] No null byte injection vectors
- [x] All external data validated with type guards
- [x] All errors logged for audit
- [x] Disposal guards prevent use-after-free

---

## Extension Points

### Adding New Commands

```typescript
// 1. Register in extension.ts
const myCommand = vscode.commands.registerCommand(
  "kloser.myCommand",
  () => {
    // Implementation
  }
);
context.subscriptions.push(myCommand);

// 2. Add to package.json
{
  "contributes": {
    "commands": [{
      "command": "kloser.myCommand",
      "title": "Kloser: My Command"
    }]
  }
}
```

### Adding New Validation Rules

```typescript
// Add to src/pr/validation.ts
export function validateMyInput(input: string): string {
  if (/* invalid */) {
    throw new PRValidationError("Clear error message");
  }
  return input;
}

// Use in code
try {
  const valid = validateMyInput(userInput);
  // ... use valid input
} catch (error) {
  if (error instanceof PRValidationError) {
    showErrorToUser(error.message);
  }
}
```

### Adding New Configuration Options

```typescript
// 1. Update KloserConfig interface
export interface KloserConfig {
  // ... existing
  myOption: number;
}

// 2. Add validation in getKloserConfig()
const myOption = config.get<number>("myOption", defaultValue);
if (/* invalid */) {
  throw new ConfigError("Validation failed: ...");
}

// 3. Add to package.json schema
{
  "configuration": {
    "properties": {
      "kloser.myOption": {
        "type": "number",
        "default": defaultValue,
        "description": "..."
      }
    }
  }
}
```

---

## Error Handling

### Error Categories

1. **PRValidationError**: User input validation failures
2. **ConfigError**: Configuration validation failures
3. **ClaudeRunError**: Claude process errors
4. **Error**: Unexpected errors (bugs)

### Error Handling Pattern

```typescript
try {
  // Operation
  const result = await operation();
} catch (error) {
  // 1. Check for expected errors
  if (error instanceof PRValidationError) {
    // User-facing error
    showErrorMessage(error.message);
    log(error.message);
    return; // Don't throw
  }
  
  if (error instanceof ConfigError) {
    // Config error
    showErrorMessage(`Configuration: ${error.message}`);
    log(`[Config] ${error.message}`);
    return; // Don't throw
  }
  
  // 2. Log unexpected errors
  const message = error instanceof Error 
    ? error.message 
    : String(error);
  log(`[Unexpected] ${message}`);
  
  // 3. Show generic message to user
  showErrorMessage("An unexpected error occurred");
  
  // 4. Re-throw for caller
  throw error;
}
```

### Logging Strategy

**Levels:**
- `log.appendLine()`: Normal operations
- `log.appendLine("[WARN]")`: Recoverable issues
- `log.appendLine("[ERROR]")`: Errors that stop operations

**What to log:**
- All state transitions
- All validation failures
- All command executions
- All disposal operations
- All configuration loads
- All unexpected errors

---

## Performance Considerations

### Throttling

- **StreamApplier updates**: 80ms throttle reduces editor churn
- **Decoration updates**: Batched with animation frame timing

### Memory Management

- **Disposal guards**: Prevent leaks from use-after-free
- **Timer tracking**: All timeouts cleared on dispose
- **Handle management**: Map cleared on dispose
- **Listener cleanup**: Document listener disposed

### Resource Limits

- **Context lines**: 0-1000 (prevents huge prompts)
- **File size**: 512KB max for comment scanning
- **Stream buffer**: Grows incrementally, cleared on completion

---

## Testing Architecture

### Test Organization

```
src/__tests__/
├── validation.test.ts    (27 tests)
├── streamState.test.ts   (27 tests)
└── config.test.ts        (9 tests)
```

### Test Coverage

- ✅ PR number validation
- ✅ File path validation
- ✅ Git reference sanitization
- ✅ Workspace path validation
- ✅ State machine transitions
- ✅ Error handling and rollback
- ✅ Concurrent operations
- ✅ Config validation logic

### Running Tests

```bash
npm test                  # All tests
npm run test:validation   # Validation only
npm run test:state        # State machine only
npm run check-types       # Type checking
```

---

## Future Enhancements

### Potential Improvements

1. **State Machine Integration**
   - Replace RequestManager's string states with StreamStateMachine
   - Stronger guarantees, better error recovery
   - Already tested and proven reliable

2. **Telemetry**
   - Track usage patterns
   - Monitor error rates
   - Identify performance bottlenecks

3. **Multi-Stream Support**
   - Allow multiple concurrent completions
   - Per-file or per-editor streams
   - Requires UI/UX design work

4. **Advanced Configuration**
   - Per-language context lines
   - Custom prompt templates
   - Model selection per operation

5. **Integration Tests**
   - Test full request lifecycle
   - Test concurrent operations
   - Test error recovery scenarios

---

## References

- **Main Plan**: `docs/REMEDIATION_PLAN.md` - Complete remediation plan
- **Testing Guide**: `docs/TESTING_GUIDE.md` - Test documentation
- **Week 1 Report**: Initial security fixes
- **Week 2 Report**: `docs/WEEK2_PROGRESS.md` - Type safety
- **Week 3 Report**: `docs/WEEK3_PROGRESS.md` - Resource management

---

**Document Version:** 1.0  
**Last Review:** October 6, 2026  
**Next Review:** When major architecture changes occur
