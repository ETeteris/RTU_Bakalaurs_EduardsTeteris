// Error thrown when a Claude response cannot be parsed as JSON. Carries the
// truncated raw snippet that the routes return to the user (as before).
class ParseError extends Error {
  constructor(message, snippet) {
    super(message);
    this.name = "ParseError";
    this.snippet = snippet;
  }
}

// Error with a ready-made HTTP response body (error + message), so a service can
// specify exactly what the route returns (e.g. "Claude API error (planning)").
class HttpError extends Error {
  constructor(error, message) {
    super(message);
    this.name = "HttpError";
    this.error = error;
    this.detail = message;
  }
}

module.exports = { ParseError, HttpError };
