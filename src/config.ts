import * as vscode from "vscode";

/**
 * Error thrown when configuration validation fails.
 * 
 * @remarks
 * ConfigErrors indicate user configuration problems that should
 * be fixed in settings.json. The error message should be clear
 * enough for users to understand what to fix.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Bedrock-specific configuration options.
 */
export interface BedrockConfig {
  baseUrl?: string;
  model?: string;
  smallFastModel?: string;
  useBedrock: boolean;
}

/**
 * Kloser extension configuration.
 */
export interface KloserConfig {
  bedrock: BedrockConfig;
  claudeExecutable: string;
  contextLines: number;
  env: Record<string, string>;
  extraArgs: string[];
  model?: string;
}

/**
 * Gets and validates the Kloser configuration from VS Code settings.
 * 
 * @returns Validated configuration object
 * @throws {ConfigError} If any configuration value is invalid
 * 
 * @remarks
 * Performs comprehensive validation of all configuration values:
 * - contextLines must be an integer between 0 and 1000
 * - extraArgs must be an array of strings
 * - env must be an object with string values
 * 
 * Invalid configurations throw ConfigError with a clear message
 * that users can use to fix their settings.
 * 
 * @example
 * ```typescript
 * try {
 *   const config = getKloserConfig();
 *   console.log(`Using ${config.claudeExecutable}`);
 * } catch (error) {
 *   if (error instanceof ConfigError) {
 *     showErrorMessage(`Configuration error: ${error.message}`);
 *   }
 * }
 * ```
 */
export function getKloserConfig(): KloserConfig {
  const config = vscode.workspace.getConfiguration("kloser");
  
  // Validate contextLines
  const contextLines = config.get<number>("contextLines", 60);
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 1000) {
    throw new ConfigError(
      `Invalid contextLines: ${contextLines}. Must be an integer between 0 and 1000.`
    );
  }
  
  // Validate extraArgs
  const extraArgs = config.get<string[]>("extraArgs", []);
  if (!Array.isArray(extraArgs)) {
    throw new ConfigError("extraArgs must be an array of strings");
  }
  for (const arg of extraArgs) {
    if (typeof arg !== "string") {
      throw new ConfigError(`Invalid extraArgs: all values must be strings, got ${typeof arg}`);
    }
  }
  
  // Validate env
  const env = config.get<Record<string, string>>("env", {});
  if (typeof env !== "object" || env === null) {
    throw new ConfigError("env must be an object");
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new ConfigError(`Invalid env.${key}: value must be a string, got ${typeof value}`);
    }
  }
  
  return {
    bedrock: {
      baseUrl: config.get<string>("bedrock.baseUrl") || undefined,
      model: config.get<string>("bedrock.model") || undefined,
      smallFastModel: config.get<string>("bedrock.smallFastModel") || undefined,
      useBedrock: config.get<boolean>("bedrock.useBedrock", false),
    },
    claudeExecutable: config.get<string>("claudeExecutable", "claude"),
    contextLines,
    env,
    extraArgs,
    model: config.get<string>("model") || undefined,
  };
}

/**
 * Builds the child process environment for Claude Code CLI.
 * 
 * @param config - Kloser configuration
 * @returns Environment variables object for child process
 * 
 * @remarks
 * Merges process.env with configuration overrides.
 * Sets Bedrock-specific environment variables when enabled.
 */
export function buildChildEnv(config: KloserConfig): NodeJS.ProcessEnv {
  const overrides: Record<string, string> = { ...config.env };
  if (config.bedrock.useBedrock) {
    overrides.CLAUDE_CODE_USE_BEDROCK = "1";
  }
  if (config.bedrock.model) {
    overrides.ANTHROPIC_MODEL = config.bedrock.model;
  }
  if (config.bedrock.smallFastModel) {
    overrides.ANTHROPIC_SMALL_FAST_MODEL = config.bedrock.smallFastModel;
  }
  if (config.bedrock.baseUrl) {
    overrides.ANTHROPIC_BEDROCK_BASE_URL = config.bedrock.baseUrl;
  }
  return { ...process.env, ...overrides };
}
