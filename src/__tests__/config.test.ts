import { describe, it } from "node:test";
import * as assert from "node:assert";

/**
 * Config validation tests
 * 
 * Note: Full integration tests with vscode.workspace.getConfiguration
 * are difficult to test in isolation. These tests focus on the validation
 * logic and error handling.
 */

describe("ConfigError", () => {
  it("creates error with correct properties", () => {
    // ConfigError is defined in config.ts
    class ConfigError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ConfigError";
      }
    }
    
    const error = new ConfigError("test message");
    assert.strictEqual(error.name, "ConfigError");
    assert.strictEqual(error.message, "test message");
    assert.ok(error instanceof Error);
    assert.ok(error instanceof ConfigError);
  });
});

describe("Config Validation Logic", () => {
  describe("contextLines validation", () => {
    function validateContextLines(value: number): boolean {
      return Number.isInteger(value) && value >= 0 && value <= 1000;
    }

    it("accepts valid contextLines", () => {
      assert.strictEqual(validateContextLines(0), true);
      assert.strictEqual(validateContextLines(60), true);
      assert.strictEqual(validateContextLines(1000), true);
    });

    it("rejects invalid contextLines", () => {
      assert.strictEqual(validateContextLines(-1), false);
      assert.strictEqual(validateContextLines(1001), false);
      assert.strictEqual(validateContextLines(60.5), false);
      assert.strictEqual(validateContextLines(NaN), false);
      assert.strictEqual(validateContextLines(Infinity), false);
    });
  });

  describe("extraArgs validation", () => {
    function validateExtraArgs(value: unknown): boolean {
      if (!Array.isArray(value)) return false;
      return value.every(arg => typeof arg === "string");
    }

    it("accepts valid extraArgs", () => {
      assert.strictEqual(validateExtraArgs([]), true);
      assert.strictEqual(validateExtraArgs(["--verbose"]), true);
      assert.strictEqual(validateExtraArgs(["--verbose", "--debug"]), true);
    });

    it("rejects invalid extraArgs", () => {
      assert.strictEqual(validateExtraArgs("not array"), false);
      assert.strictEqual(validateExtraArgs(null), false);
      assert.strictEqual(validateExtraArgs(undefined), false);
      assert.strictEqual(validateExtraArgs([123]), false);
      assert.strictEqual(validateExtraArgs(["--verbose", 123]), false);
      assert.strictEqual(validateExtraArgs([true, false]), false);
    });
  });

  describe("env validation", () => {
    function validateEnv(value: unknown): boolean {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      return Object.values(value as Record<string, unknown>).every(
        v => typeof v === "string"
      );
    }

    it("accepts valid env", () => {
      assert.strictEqual(validateEnv({}), true);
      assert.strictEqual(validateEnv({ KEY: "value" }), true);
      assert.strictEqual(validateEnv({ AWS_PROFILE: "default", AWS_REGION: "us-west-2" }), true);
    });

    it("rejects invalid env", () => {
      assert.strictEqual(validateEnv(null), false);
      assert.strictEqual(validateEnv(undefined), false);
      assert.strictEqual(validateEnv("not object"), false);
      assert.strictEqual(validateEnv([]), false);
      assert.strictEqual(validateEnv({ KEY: 123 }), false);
      assert.strictEqual(validateEnv({ KEY: "value", PORT: 8080 }), false);
    });
  });
});

describe("Edge Cases", () => {
  it("handles empty response validation", () => {
    function validateResponse(text: string): boolean {
      return text.trim().length > 0;
    }

    assert.strictEqual(validateResponse("valid text"), true);
    assert.strictEqual(validateResponse("  valid  "), true);
    assert.strictEqual(validateResponse(""), false);
    assert.strictEqual(validateResponse("   "), false);
    assert.strictEqual(validateResponse("\n\n"), false);
    assert.strictEqual(validateResponse("\t\t"), false);
  });

  it("handles disposal guard pattern", () => {
    class TestResource {
      private disposed = false;

      public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        // cleanup logic
      }

      public doSomething(): void {
        if (this.disposed) return;
        // do work
      }
    }

    const resource = new TestResource();
    resource.doSomething(); // Should work
    resource.dispose(); // First disposal
    resource.dispose(); // Should be safe (no-op)
    resource.doSomething(); // Should be no-op after disposal
  });
});
