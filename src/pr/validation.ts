import * as path from "path";

/**
 * Error thrown when PR data validation fails.
 * 
 * @remarks
 * Used to distinguish validation errors from other errors.
 * Validation errors are typically shown to users, while
 * other errors may indicate bugs.
 */
export class PRValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PRValidationError";
	}
}

/**
 * Validates a PR number is a safe positive integer.
 * 
 * @param value - Value to validate (number or string)
 * @returns Validated positive integer
 * @throws {PRValidationError} If value is not a valid PR number
 * 
 * @remarks
 * Accepts both numbers and numeric strings. Ensures the value
 * is a positive integer within safe range for JavaScript numbers.
 * Prevents command injection by rejecting non-numeric inputs.
 * 
 * @example
 * ```typescript
 * validatePRNumber(42) // returns 42
 * validatePRNumber("123") // returns 123
 * validatePRNumber(-1) // throws PRValidationError
 * validatePRNumber("abc") // throws PRValidationError
 * ```
 */
export function validatePRNumber(value: unknown): number {
	if (value === undefined || value === null) {
		throw new PRValidationError("PR number is required");
	}

	const num = typeof value === "string" ? parseInt(value, 10) : value;

	if (typeof num !== "number" || !Number.isInteger(num) || num <= 0 || num > Number.MAX_SAFE_INTEGER) {
		throw new PRValidationError(
			`Invalid PR number: ${value}. Must be a positive integer.`
		);
	}

	return num;
}

/**
 * Validates a file path for security concerns.
 * 
 * @param filePath - File path to validate (should be relative)
 * @throws {PRValidationError} If path contains security issues
 * 
 * @remarks
 * Prevents path traversal attacks by rejecting:
 * - Paths containing ".." (directory traversal)
 * - Absolute paths starting with "/"
 * - Null bytes (command injection vector)
 * 
 * @example
 * ```typescript
 * validateFilePath("src/file.ts") // OK
 * validateFilePath("../etc/passwd") // throws
 * validateFilePath("/etc/passwd") // throws
 * validateFilePath("file\0.txt") // throws
 * ```
 */
export function validateFilePath(filePath: string): void {
	// Prevent path traversal
	if (filePath.includes("..") || filePath.startsWith("/")) {
		throw new PRValidationError(
			`Invalid file path: ${filePath}. Path traversal not allowed.`
		);
	}

	// Check for null bytes (command injection vector)
	if (filePath.includes("\0")) {
		throw new PRValidationError(
			`Invalid file path: ${filePath}. Null bytes not allowed.`
		);
	}
}

/**
 * Sanitizes a git reference to prevent command injection.
 * 
 * @param ref - Git reference (branch, tag, commit hash, etc.)
 * @returns Sanitized reference (same as input if valid)
 * @throws {PRValidationError} If reference contains invalid characters
 * 
 * @remarks
 * Only allows alphanumeric characters, dash, underscore, forward slash, and dot.
 * This prevents command injection through git references.
 * 
 * @example
 * ```typescript
 * sanitizeGitReference("main") // returns "main"
 * sanitizeGitReference("feature/new-thing") // returns "feature/new-thing"
 * sanitizeGitReference("v1.2.3") // returns "v1.2.3"
 * sanitizeGitReference("main; rm -rf /") // throws
 * ```
 */
export function sanitizeGitReference(ref: string): string {
	// Only allow alphanumeric, dash, underscore, forward slash, dot
	if (!/^[a-zA-Z0-9_\-/.]+$/.test(ref)) {
		throw new PRValidationError(
			`Invalid git reference: ${ref}. Contains invalid characters.`
		);
	}
	return ref;
}

/**
 * Validates a path is within the workspace root.
 * 
 * @param root - Workspace root path (absolute)
 * @param targetPath - Target path to validate (relative or absolute)
 * @returns Absolute path within workspace
 * @throws {PRValidationError} If path escapes workspace or contains security issues
 * 
 * @remarks
 * Resolves the target path and ensures it stays within the workspace.
 * Prevents path traversal attacks even with complex relative paths.
 * Also checks for null bytes and other injection vectors.
 * 
 * @example
 * ```typescript
 * const root = "/workspace/project";
 * validateWorkspacePath(root, "src/file.ts") 
 *   // returns "/workspace/project/src/file.ts"
 * 
 * validateWorkspacePath(root, "../../../etc/passwd")
 *   // throws (escapes workspace)
 * 
 * validateWorkspacePath(root, "/etc/passwd")
 *   // throws (outside workspace)
 * ```
 */
export function validateWorkspacePath(root: string, targetPath: string): string {
	// Join and resolve to get absolute path
	const absolutePath = path.resolve(root, targetPath);

	// Ensure result is within workspace root
	if (!absolutePath.startsWith(root)) {
		throw new PRValidationError(
			`Path traversal detected: ${targetPath} resolves outside workspace root`
		);
	}

	// Additional security checks
	if (absolutePath.includes("\0")) {
		throw new PRValidationError(
			`Invalid path: ${targetPath} contains null bytes`
		);
	}

	return absolutePath;
}
