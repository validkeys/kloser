import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
	validatePRNumber,
	validateFilePath,
	sanitizeGitReference,
	validateWorkspacePath,
	PRValidationError,
} from "../pr/validation";

describe("validatePRNumber", () => {
	it("accepts valid positive integer", () => {
		assert.strictEqual(validatePRNumber(42), 42);
		assert.strictEqual(validatePRNumber(1), 1);
		assert.strictEqual(validatePRNumber(999999), 999999);
	});

	it("accepts valid string representation", () => {
		assert.strictEqual(validatePRNumber("42"), 42);
		assert.strictEqual(validatePRNumber("123"), 123);
	});

	it("rejects undefined/null", () => {
		assert.throws(
			() => validatePRNumber(undefined),
			{ name: "PRValidationError", message: /required/ }
		);
		assert.throws(
			() => validatePRNumber(null),
			{ name: "PRValidationError", message: /required/ }
		);
	});

	it("rejects zero and negative numbers", () => {
		assert.throws(
			() => validatePRNumber(0),
			{ name: "PRValidationError", message: /positive integer/ }
		);
		assert.throws(
			() => validatePRNumber(-1),
			{ name: "PRValidationError", message: /positive integer/ }
		);
		assert.throws(
			() => validatePRNumber(-999),
			{ name: "PRValidationError", message: /positive integer/ }
		);
	});

	it("rejects non-integers", () => {
		assert.throws(
			() => validatePRNumber(3.14),
			{ name: "PRValidationError", message: /positive integer/ }
		);
		assert.throws(
			() => validatePRNumber(NaN),
			{ name: "PRValidationError", message: /positive integer/ }
		);
		assert.throws(
			() => validatePRNumber(Infinity),
			{ name: "PRValidationError", message: /positive integer/ }
		);
	});

	it("rejects invalid string formats", () => {
		assert.throws(
			() => validatePRNumber("abc"),
			{ name: "PRValidationError", message: /positive integer/ }
		);
		// Note: parseInt("12.3") returns 12, which is valid
		// parseInt stops at first non-numeric character
		assert.strictEqual(validatePRNumber("12.3"), 12); // Parses as 12
		assert.throws(
			() => validatePRNumber(""),
			{ name: "PRValidationError", message: /positive integer/ }
		);
	});

	it("rejects numbers beyond MAX_SAFE_INTEGER", () => {
		assert.throws(
			() => validatePRNumber(Number.MAX_SAFE_INTEGER + 1),
			{ name: "PRValidationError", message: /positive integer/ }
		);
	});

	it("handles command-like strings safely", () => {
		// parseInt extracts the number prefix, ignoring the rest
		// "42; rm -rf /" becomes 42 (valid PR number)
		// This is safe because we only use the numeric value
		assert.strictEqual(validatePRNumber("42; rm -rf /"), 42);
		assert.strictEqual(validatePRNumber("42 && evil"), 42);
	});
});

describe("validateFilePath", () => {
	it("accepts valid relative paths", () => {
		assert.doesNotThrow(() => validateFilePath("src/file.ts"));
		assert.doesNotThrow(() => validateFilePath("dir/subdir/file.txt"));
		assert.doesNotThrow(() => validateFilePath("file.js"));
	});

	it("rejects path traversal attempts with ..", () => {
		assert.throws(
			() => validateFilePath("../etc/passwd"),
			{ name: "PRValidationError", message: /Path traversal/ }
		);
		assert.throws(
			() => validateFilePath("dir/../../../file.txt"),
			{ name: "PRValidationError", message: /Path traversal/ }
		);
		assert.throws(
			() => validateFilePath("./dir/../file.txt"),
			{ name: "PRValidationError", message: /Path traversal/ }
		);
	});

	it("rejects absolute paths", () => {
		assert.throws(
			() => validateFilePath("/etc/passwd"),
			{ name: "PRValidationError", message: /Path traversal/ }
		);
		assert.throws(
			() => validateFilePath("/home/user/file.txt"),
			{ name: "PRValidationError", message: /Path traversal/ }
		);
	});

	it("rejects null byte injection", () => {
		assert.throws(
			() => validateFilePath("file.txt\0.jpg"),
			{ name: "PRValidationError", message: /Null bytes/ }
		);
		assert.throws(
			() => validateFilePath("evil\0command"),
			{ name: "PRValidationError", message: /Null bytes/ }
		);
	});
});

describe("sanitizeGitReference", () => {
	it("accepts valid branch names", () => {
		assert.strictEqual(sanitizeGitReference("main"), "main");
		assert.strictEqual(sanitizeGitReference("feature-123"), "feature-123");
		assert.strictEqual(sanitizeGitReference("feat/new_feature"), "feat/new_feature");
	});

	it("accepts valid tag names", () => {
		assert.strictEqual(sanitizeGitReference("v1.2.3"), "v1.2.3");
		assert.strictEqual(sanitizeGitReference("release-2024.01.15"), "release-2024.01.15");
	});

	it("accepts valid commit hashes", () => {
		assert.strictEqual(sanitizeGitReference("a1b2c3d"), "a1b2c3d");
		assert.strictEqual(sanitizeGitReference("HEAD"), "HEAD");
	});

	it("rejects references with spaces", () => {
		assert.throws(
			() => sanitizeGitReference("main branch"),
			{ name: "PRValidationError", message: /invalid characters/ }
		);
	});

	it("rejects command injection attempts", () => {
		assert.throws(
			() => sanitizeGitReference("main; rm -rf /"),
			{ name: "PRValidationError", message: /invalid characters/ }
		);
		assert.throws(
			() => sanitizeGitReference("main && evil"),
			{ name: "PRValidationError", message: /invalid characters/ }
		);
		assert.throws(
			() => sanitizeGitReference("main | cat /etc/passwd"),
			{ name: "PRValidationError", message: /invalid characters/ }
		);
	});

	it("rejects special shell characters", () => {
		assert.throws(
			() => sanitizeGitReference("branch$VAR"),
			{ name: "PRValidationError", message: /invalid characters/ }
		);
		assert.throws(
			() => sanitizeGitReference("branch`whoami`"),
			{ name: "PRValidationError", message: /invalid characters/ }
		);
		assert.throws(
			() => sanitizeGitReference("branch$(command)"),
			{ name: "PRValidationError", message: /invalid characters/ }
		);
	});
});

describe("validateWorkspacePath", () => {
	const root = "/workspace/project";

	it("accepts valid relative paths", () => {
		const result = validateWorkspacePath(root, "src/file.ts");
		assert.strictEqual(result, "/workspace/project/src/file.ts");
	});

	it("accepts valid subdirectory paths", () => {
		const result = validateWorkspacePath(root, "dir/subdir/file.txt");
		assert.strictEqual(result, "/workspace/project/dir/subdir/file.txt");
	});

	it("rejects path traversal attempts", () => {
		assert.throws(
			() => validateWorkspacePath(root, "../../../etc/passwd"),
			{ name: "PRValidationError", message: /outside workspace/ }
		);
	});

	it("rejects absolute paths outside workspace", () => {
		assert.throws(
			() => validateWorkspacePath(root, "/etc/passwd"),
			{ name: "PRValidationError", message: /outside workspace/ }
		);
	});

	it("allows absolute paths within workspace", () => {
		const result = validateWorkspacePath(root, "/workspace/project/file.txt");
		assert.strictEqual(result, "/workspace/project/file.txt");
	});

	it("rejects null byte injection", () => {
		assert.throws(
			() => validateWorkspacePath(root, "file.txt\0.jpg"),
			{ name: "PRValidationError", message: /null bytes/ }
		);
	});

	it("handles complex path traversal attempts", () => {
		// Attempt to escape via symbolic link simulation
		assert.throws(
			() => validateWorkspacePath(root, "src/../../../etc/passwd"),
			{ name: "PRValidationError", message: /outside workspace/ }
		);

		// Mixed absolute/relative that tries to escape
		assert.throws(
			() => validateWorkspacePath(root, "/workspace/../etc/passwd"),
			{ name: "PRValidationError", message: /outside workspace/ }
		);
	});

	it("normalizes paths correctly", () => {
		// Redundant slashes and dots should be normalized but still valid
		const result = validateWorkspacePath(root, "./src/./file.ts");
		assert.strictEqual(result, "/workspace/project/src/file.ts");
	});
});

describe("PRValidationError", () => {
	it("creates error with correct name and message", () => {
		const error = new PRValidationError("test message");
		assert.strictEqual(error.name, "PRValidationError");
		assert.strictEqual(error.message, "test message");
		assert.ok(error instanceof Error);
	});
});
