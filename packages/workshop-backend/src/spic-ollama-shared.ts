// SPIC fork: a company-wide Ollama server (behind an auth-requiring reverse proxy) that every user
// should see in their Agent picker without configuring anything themselves -- same experience as
// the AI-Gateway-suggested models, but for Ollama, which AI Gateway itself cannot proxy to (see
// ai-models.ts's "SPIC fork" comment). Mirrors ai-gateway.ts's AiGatewayConfig
// getModelList()/resolveModel() shape so user.ts can treat it the same way, without touching that
// file (kept separate to stay out of upstream's way).
import { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { UserAiModelRecord } from "./storage-schema/user-storage.js";

export interface SharedOllamaModel {
  /** Model name as `ollama list` shows it on the shared server, e.g. "muse-glimmer:latest". */
  id: string;
  /** Human-readable name shown in the Agent picker. */
  name: string;
}

export class SharedOllamaConfig {
  readonly apiUrl: string;
  readonly apiToken: string;
  readonly models: SharedOllamaModel[];

  constructor(env: Cloudflare.Env) {
    this.apiUrl = env.OLLAMA_SHARED_API_URL!;
    this.apiToken = env.OLLAMA_SHARED_API_TOKEN ?? "";
    this.models = JSON.parse(env.OLLAMA_SHARED_MODELS ?? "[]");
  }

  getModelList(): AiChatAuthorInfo[] {
    return this.models.map(m => ({ type: "agent", id: m.id, name: m.name }));
  }

  /** Look up a shared-server model by ID, returning a record that carries the org's own token. */
  resolveModel(modelId: string): UserAiModelRecord | undefined {
    const model = this.models.find(m => m.id === modelId);
    if (!model) return undefined;
    return {
      profile: { type: "agent", id: model.id, name: model.name },
      config: { provider: "ollama", model: model.id, apiUrl: this.apiUrl, apiToken: this.apiToken },
    };
  }
}

/** Parses shared-Ollama configuration from env. Returns null when OLLAMA_SHARED_API_URL is unset. */
export function getSharedOllamaConfig(env: Cloudflare.Env): SharedOllamaConfig | null {
  if (!env.OLLAMA_SHARED_API_URL) return null;
  return new SharedOllamaConfig(env);
}
