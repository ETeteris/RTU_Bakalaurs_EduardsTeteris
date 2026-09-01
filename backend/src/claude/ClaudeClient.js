const axios = require("axios");

// Error from the Anthropic API — carries the already-unwrapped detail message
// so the routes can show it to the user exactly as before.
class ClaudeApiError extends Error {
  constructor(detail) {
    super(detail);
    this.name = "ClaudeApiError";
    this.detail = detail;
  }
}

// The single place where we talk to the Anthropic Messages API. Previously each
// of the three routes repeated the same axios.post with the URL, x-api-key,
// anthropic-version and model id. Now it is centralized: the model / version /
// retries can be changed in one place.
class ClaudeClient {
  constructor(options = {}) {
    this.apiKey  = options.apiKey  || process.env.CLAUDE_API_KEY;
    this.model   = options.model   || "claude-sonnet-4-6";
    this.version = options.version || "2023-06-01";
    this.baseURL = options.baseURL || "https://api.anthropic.com/v1/messages";
  }

  isConfigured() {
    return !!this.apiKey;
  }

  // Sends one message. Returns { data, usage, text }, where text is the first
  // text block — this works both for normal responses and for extended thinking
  // responses (which contain a thinking block plus a text block).
  async message({ system, messages, maxTokens, thinking, timeout, model }) {
    const body = {
      model: model || this.model,
      max_tokens: maxTokens,
      messages,
    };
    if (system) body.system = system;
    if (thinking) body.thinking = thinking;

    const config = {
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": this.version,
        "content-type": "application/json",
      },
    };
    if (timeout) config.timeout = timeout;

    let response;
    try {
      response = await axios.post(this.baseURL, body, config);
    } catch (apiError) {
      const detail = apiError.response?.data?.error?.message || apiError.message;
      throw new ClaudeApiError(detail);
    }

    const data = response.data;
    const textBlock = Array.isArray(data.content)
      ? data.content.find((b) => b.type === "text")
      : null;

    return { data, usage: data.usage, text: textBlock ? textBlock.text : "" };
  }
}

module.exports = { ClaudeClient, ClaudeApiError };
