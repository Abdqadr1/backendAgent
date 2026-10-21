// Shell commands the agent may never run. Everything else in Bash is allowed inside the container.
// Kept free of imports so the Bash guard hook loads it without config or secrets.
export const BLOCKED_BASH: RegExp[] = [
  /\bgit\s+(push|remote|config\s+--global|credential)\b/,
  /\b(curl|wget|ssh|scp|rsync|nc|ncat|telnet)\b/,
  /\b(sudo|su|docker|kubectl|terraform|helm|aws|gcloud|az)\b/,
  /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/,
  /\b(printenv|env)\b\s*($|\|)/,
];
