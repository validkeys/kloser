import * as vscode from "vscode";

export interface BedrockConfig {
  baseUrl?: string;
  model?: string;
  smallFastModel?: string;
  useBedrock: boolean;
}

export interface KloserConfig {
  bedrock: BedrockConfig;
  claudeExecutable: string;
  contextLines: number;
  env: Record<string, string>;
  extraArgs: string[];
  model?: string;
}

export function getKloserConfig(): KloserConfig {
  const config = vscode.workspace.getConfiguration("kloser");
  return {
    bedrock: {
      baseUrl: config.get<string>("bedrock.baseUrl") || undefined,
      model: config.get<string>("bedrock.model") || undefined,
      smallFastModel: config.get<string>("bedrock.smallFastModel") || undefined,
      useBedrock: config.get<boolean>("bedrock.useBedrock", false),
    },
    claudeExecutable: config.get<string>("claudeExecutable", "claude"),
    contextLines: Math.max(0, config.get<number>("contextLines", 60)),
    env: config.get<Record<string, string>>("env", {}),
    extraArgs: config.get<string[]>("extraArgs", []),
    model: config.get<string>("model") || undefined,
  };
}

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
