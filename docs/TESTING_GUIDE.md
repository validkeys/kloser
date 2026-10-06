# Kloser Testing Guide

## Test Suite Overview

The Kloser extension now includes comprehensive unit tests for critical security and stability components.

### Test Structure

- **Location**: `src/__tests__/`
- **Framework**: Node.js built-in test runner (Node 20+)
- **Transpiler**: tsx (for TypeScript support)
- **Total Tests**: 54 tests across 17 suites

### Test Files

#### 1. `validation.test.ts` (27 tests)

Tests for the PR validation module (`src/pr/validation.ts`):

- **validatePRNumber**: Validates PR numbers are safe positive integers
  - Valid inputs: positive integers, numeric strings
  - Rejects: undefined/null, zero/negative, non-integers, out of bounds
  - Command injection safety: Safely extracts numeric prefix

- **validateFilePath**: Prevents path traversal and command injection
  - Accepts: Valid relative paths
  - Rejects: Path traversal (../*), absolute paths, null bytes

- **sanitizeGitReference**: Prevents command injection in git refs
  - Accepts: Alphanumeric, dash, underscore, slash, dot
  - Rejects: Spaces, special shell characters, command injection attempts

- **validateWorkspacePath**: Ensures paths stay within workspace
  - Accepts: Valid relative paths, absolute paths within workspace
  - Rejects: Path traversal, paths outside workspace, null bytes
  - Normalizes redundant slashes and dots

#### 2. `streamState.test.ts` (27 tests)

Tests for the stream state machine (`src/streamState.ts`):

- **State Transitions**: Tests all valid/invalid state transitions
  - Valid paths: streaming → settling → accepting → completed
  - Invalid transitions are rejected
  - Terminal states (completed, failed) reject all transitions

- **Error Handling**: 
  - Operations are executed during transitions
  - State rollback on operation failure
  - Retry after failed operations

- **Concurrency**:
  - Concurrent transitions are serialized
  - In-progress transitions block new ones
  - Rapid successive transitions handled correctly

- **Complex Flows**:
  - Success: streaming → settling → accepting → completed
  - Reject: streaming → settling → rejecting → failed
  - Redirect: streaming → redirecting → streaming → settling

## Running Tests

### All Tests
```bash
npm test
```

This runs type checking followed by all test suites.

### Individual Test Suites
```bash
# Validation tests only
npm run test:validation

# State machine tests only
npm run test:state
```

### Type Checking Only
```bash
npm run check-types
```

## Test Results

All tests passing as of current implementation:

```
ℹ tests 54
ℹ suites 17
ℹ pass 54
ℹ fail 0
✔ All type checks pass
```

## CI/CD Integration

The test suite is designed for CI/CD integration:

1. **Fast**: Completes in ~500ms
2. **No external dependencies**: Uses Node.js built-in test runner
3. **Type-safe**: Includes TypeScript type checking
4. **Exit codes**: Proper exit codes for CI/CD pipelines

### Example GitHub Actions Integration

```yaml
- name: Install dependencies
  run: npm ci

- name: Run tests
  run: npm test

- name: Build extension
  run: npm run compile
```

## Manual Testing Checklist

While unit tests cover critical security and stability components, the following manual tests are recommended:

### 1. Code Completion Flow
- [ ] Select code block
- [ ] Run "Kloser: Complete Selection with Agent"
- [ ] Verify streaming indicator appears
- [ ] Accept with Tab
- [ ] Verify changes applied correctly

### 2. Code Review Flow
- [ ] Select code block
- [ ] Run "Kloser: Code Review Selection"
- [ ] Verify review appears in webview
- [ ] Check review suggestions are relevant

### 3. PR Tour Flow
- [ ] Run "Kloser: Review PR (Guided Tour)"
- [ ] Enter valid PR number
- [ ] Navigate with Ctrl+Shift+7 (next slice)
- [ ] Toggle diff with Ctrl+Shift+6
- [ ] Verify no crashes or hangs

### 4. Error Handling
- [ ] Try invalid PR number (negative, string, etc.)
- [ ] Verify appropriate error message
- [ ] Try PR tour with no git repo
- [ ] Verify graceful error handling

### 5. Concurrent Operations
- [ ] Start code completion
- [ ] Immediately start another completion
- [ ] Verify no race conditions or crashes
- [ ] Stop all requests with "Kloser: Stop All Requests"

## Future Testing Improvements

### Unit Tests
- [ ] Add tests for `RequestManager` with state machine integration
- [ ] Add tests for `decorationManager.ts` timer management
- [ ] Add tests for `reviewWebview.ts` timeout handling
- [ ] Add tests for `claudeRunner.ts` process lifecycle

### Integration Tests
- [ ] Test full completion flow with mock Claude process
- [ ] Test full PR review flow with mock git commands
- [ ] Test concurrent request handling
- [ ] Test timeout and cancellation scenarios

### E2E Tests
- [ ] Automated VS Code extension tests
- [ ] Test with real Claude Code CLI
- [ ] Test with real git repositories
- [ ] Performance and stability testing

## Troubleshooting

### Tests Fail with Module Not Found
```bash
# Reinstall tsx
npm install --save-dev tsx
```

### Type Errors During Tests
```bash
# Verify TypeScript version
npm list typescript

# Reinstall dependencies
npm ci
```

### Tests Hang or Timeout
```bash
# Check for infinite loops in state machine
# Verify timeout values in tests (currently 60s)
# Check for unresolved promises
```

## Contributing

When adding new security or stability features:

1. **Write tests first**: TDD approach ensures coverage
2. **Test edge cases**: Null, undefined, invalid inputs
3. **Test error paths**: Ensure proper error handling
4. **Test concurrency**: If code has async operations
5. **Update this guide**: Document new test suites

## References

- Node.js Test Runner: https://nodejs.org/api/test.html
- tsx: https://github.com/privatenumber/tsx
- TypeScript: https://www.typescriptlang.org/
