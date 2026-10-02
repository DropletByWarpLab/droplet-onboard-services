/**
 * WARP-3452 — per-client setup snippets for Settings → Coding tools.
 *
 * Pure, so the page test can pin the one rule that matters here: a snippet
 * carries the real base URL and model id, and ONLY the placeholder for the
 * token. The real token is shown once, in its own panel, and never lands in
 * text a person might paste into a shared config or a screenshot.
 *
 * Client details are from the ticket's §5 table (verified 2026-10-02).
 */

export const TOKEN_PLACEHOLDER = "<your token>";

export interface ClientGuide {
  id: string;
  name: string;
  steps: string;
  snippet: string;
}

export function clientGuides({
  origin,
  model,
  contextWindow,
}: {
  origin: string;
  model: string | null;
  contextWindow: number | null;
}): ClientGuide[] {
  const openai = `${origin}/llm/v1`;
  const ollama = `${origin}/llm`;
  const id = model ?? "<model id>";
  const token = TOKEN_PLACEHOLDER;
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const q = (value: string) => JSON.stringify(value);
  const fields = (rows: Array<[string, string]>) =>
    rows.map(([k, v]) => `${k}: ${v}`).join("\n");

  return [
    {
      id: "copilot-vscode",
      name: "GitHub Copilot in VS Code",
      steps:
        "In the Chat view open the model picker, choose Manage Language Models, then Add Models → Custom Endpoint. Pick Chat Completions and paste your token when asked; VS Code stores it as a secret. The chatLanguageModels.json it writes should look like this:",
      snippet: json([
        {
          name: "Droplet",
          vendor: "customendpoint",
          apiKey: token,
          apiType: "chat-completions",
          models: [
            {
              id,
              name: id,
              url: `${openai}/chat/completions`,
              toolCalling: true,
              ...(contextWindow ? { maxInputTokens: contextWindow } : {}),
            },
          ],
        },
      ]),
    },
    {
      id: "ollama-vscode",
      name: "Ollama extension for VS Code",
      steps: `Install the official Ollama extension, add these lines to your VS Code settings.json, then pick ${id} from its model list.`,
      snippet: json({
        "ollama.endpoint": ollama,
        "ollama.headers": { Authorization: `Bearer ${token}` },
      }),
    },
    {
      id: "copilot-jetbrains",
      name: "GitHub Copilot in JetBrains IDEs",
      steps:
        "In Copilot Chat's model settings, add an OpenAI-compatible custom endpoint with these values.",
      snippet: fields([
        ["Base URL", openai],
        ["API key", token],
        ["Model", id],
      ]),
    },
    {
      id: "copilot-cli",
      name: "GitHub Copilot CLI",
      steps: "Set these in your shell before you start copilot.",
      snippet: [
        `export COPILOT_PROVIDER_BASE_URL=${q(openai)}`,
        "export COPILOT_PROVIDER_TYPE=openai",
        `export COPILOT_PROVIDER_API_KEY=${q(token)}`,
        `export COPILOT_MODEL=${q(id)}`,
      ].join("\n"),
    },
    {
      id: "continue",
      name: "Continue",
      steps: "Add this model to your Continue config.yaml.",
      snippet: [
        "models:",
        "  - name: Droplet",
        "    provider: openai",
        `    model: ${q(id)}`,
        `    apiBase: ${q(openai)}`,
        `    apiKey: ${q(token)}`,
        "    capabilities:",
        "      - tool_use",
        ...(contextWindow
          ? ["    defaultCompletionOptions:", `      contextLength: ${contextWindow}`]
          : []),
      ].join("\n"),
    },
    {
      id: "cline",
      name: "Cline",
      steps: "In Cline's settings choose the OpenAI Compatible provider and fill in:",
      snippet: fields([
        ["Base URL", openai],
        ["API Key", token],
        ["Model ID", id],
      ]),
    },
    {
      id: "opencode",
      name: "OpenCode",
      steps:
        "Add this provider to opencode.json, then set DROPLET_TOKEN to your token in your shell.",
      snippet: json({
        provider: {
          droplet: {
            npm: "@ai-sdk/openai-compatible",
            name: "Droplet",
            options: { baseURL: openai, apiKey: "{env:DROPLET_TOKEN}" },
            models: { [id]: { name: id } },
          },
        },
      }),
    },
    {
      id: "zed",
      name: "Zed",
      steps:
        "Add this to your Zed settings.json, then enter your token in the agent settings for the Droplet provider.",
      snippet: json({
        language_models: {
          openai_compatible: {
            Droplet: {
              api_url: openai,
              available_models: [
                {
                  name: id,
                  ...(contextWindow ? { max_tokens: contextWindow } : {}),
                  capabilities: { tools: true, images: false },
                },
              ],
            },
          },
        },
      }),
    },
    {
      id: "aider",
      name: "Aider",
      steps: "Set these in your shell, then start aider with the model.",
      snippet: [
        `export OPENAI_API_BASE=${q(openai)}`,
        `export OPENAI_API_KEY=${q(token)}`,
        `aider --model ${q(`openai/${id}`)}`,
      ].join("\n"),
    },
    {
      id: "open-webui",
      name: "Open WebUI",
      steps: "In Admin Settings → Connections, add an OpenAI connection with:",
      snippet: fields([
        ["URL", openai],
        ["Key", token],
        ["Model", id],
      ]),
    },
  ];
}
