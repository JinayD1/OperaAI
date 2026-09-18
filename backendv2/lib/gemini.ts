// All model calls go through OpenRouter's OpenAI-compatible API instead of the
// Google SDK. Call sites keep the Gemini SDK's `generateContent` shape (string
// or [prompt, ...inlineData parts] contents, Gemini-style responseSchema); this
// module adapts that to a chat-completions request and converts the schema to
// standard JSON Schema. Requires OPENROUTER_API_KEY; checked per-call, not at
// import, so routes that never call a model don't 500 on missing config.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

// Mirrors the members of @google/genai's Type enum that our schemas use.
export const Type = {
  OBJECT: "OBJECT",
  STRING: "STRING",
  INTEGER: "INTEGER",
  NUMBER: "NUMBER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
} as const;

export interface GeminiSchema {
  type: string;
  description?: string;
  nullable?: boolean;
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  minItems?: number;
  maxItems?: number;
}

interface InlineDataPart {
  inlineData: { mimeType: string; data: string };
}

type ContentPart = string | InlineDataPart;

interface GenerateContentArgs {
  model?: string;
  contents: string | ContentPart[];
  config?: {
    responseMimeType?: string;
    responseSchema?: GeminiSchema;
    temperature?: number;
  };
}

export class OpenRouterError extends Error {
  status?: number;
  details?: unknown;

  constructor(message: string, status?: number, details?: unknown) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.details = details;
  }
}

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new OpenRouterError(
      "Missing OPENROUTER_API_KEY — add it to backendv2/.env (see .env.example)",
      500,
    );
  }
  return key;
}

function resolveModel(model?: string): string {
  if (process.env.OPENROUTER_MODEL) return process.env.OPENROUTER_MODEL;
  if (!model) return DEFAULT_MODEL;
  // Bare Gemini SDK names like "gemini-2.5-flash" need OpenRouter's vendor prefix.
  return model.includes("/") ? model : `google/${model}`;
}

// Gemini schemas use uppercase type names and `nullable`; JSON Schema wants
// lowercase types and a ["type", "null"] union.
function toJsonSchema(schema: GeminiSchema): Record<string, unknown> {
  const type = schema.type.toLowerCase();
  const out: Record<string, unknown> = {
    type: schema.nullable ? [type, "null"] : type,
  };
  if (schema.description) out.description = schema.description;
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toJsonSchema(v)]),
    );
    out.additionalProperties = false;
  }
  if (schema.required) out.required = schema.required;
  if (schema.items) out.items = toJsonSchema(schema.items);
  if (schema.minItems !== undefined) out.minItems = schema.minItems;
  if (schema.maxItems !== undefined) out.maxItems = schema.maxItems;
  return out;
}

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function toOpenAiContent(contents: string | ContentPart[]): OpenAiContentPart[] {
  const parts = typeof contents === "string" ? [contents] : contents;
  return parts.map((part) => {
    if (typeof part === "string") {
      return { type: "text" as const, text: part };
    }
    const { mimeType, data } = part.inlineData;
    return {
      type: "image_url" as const,
      image_url: { url: `data:${mimeType};base64,${data}` },
    };
  });
}

// Models occasionally wrap JSON in markdown fences when the router doesn't
// enforce structured output; strip them so JSON.parse at call sites succeeds.
function stripCodeFences(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : text;
}

async function generateContent(
  args: GenerateContentArgs,
): Promise<{ text: string | undefined }> {
  const apiKey = getApiKey();

  const body: Record<string, unknown> = {
    model: resolveModel(args.model),
    messages: [{ role: "user", content: toOpenAiContent(args.contents) }],
  };

  if (args.config?.temperature !== undefined) {
    body.temperature = args.config.temperature;
  }

  if (args.config?.responseSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: false,
        schema: toJsonSchema(args.config.responseSchema),
      },
    };
  } else if (args.config?.responseMimeType === "application/json") {
    body.response_format = { type: "json_object" };
  }

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new OpenRouterError(
      `OpenRouter request failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
      error,
    );
  }

  const raw = await res.text();

  if (!res.ok) {
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } };
      message = parsed.error?.message || raw;
    } catch {
      // keep raw body as the message
    }
    throw new OpenRouterError(
      `OpenRouter error (${res.status}): ${message}`,
      res.status,
      raw,
    );
  }

  let parsed: { choices?: { message?: { content?: string } }[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpenRouterError("OpenRouter returned non-JSON response", 502, raw);
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    return { text: undefined };
  }

  return { text: stripCodeFences(content.trim()) };
}

// Same call shape as the Gemini SDK client (`genai.models.generateContent`),
// so existing call sites work unchanged.
export const genai = {
  models: { generateContent },
};

export const localizationPlanSchema = {
  type: Type.OBJECT,
  properties: {
    targetLabel: {
      type: Type.STRING,
      description: "Short label for the target part(s), e.g. screws, connector, fuse",
    },
    targetDescription: {
      type: Type.STRING,
      description: "Specific visual description of what the CV model should find",
    },
    countHint: {
      type: Type.INTEGER,
      description: "Number of target parts if explicitly known",
      nullable: true,
    },
    contextObjects: {
      type: Type.ARRAY,
      items: {
        type: Type.STRING,
      },
      description: "Nearby assemblies or objects that help visually identify the target",
    },
    overlayText: {
      type: Type.STRING,
      description: "Short label to show on the final image overlay",
    },
    groupTargets: {
      type: Type.BOOLEAN,
      description: "Whether the later CV model should return one grouped box covering all relevant targets",
    },
  },
  required: [
    "targetLabel",
    "targetDescription",
    "contextObjects",
    "overlayText",
    "groupTargets",
  ],
};

export const localizationResultSchema = {
  type: Type.OBJECT,
  properties: {
    found: { type: Type.BOOLEAN },
    targetLabel: { type: Type.STRING, nullable: true },
    box2d: {
      type: Type.ARRAY,
      items: { type: Type.INTEGER },
      minItems: 4,
      maxItems: 4,
      nullable: true,
    },
  },
  required: ["found"],
};
