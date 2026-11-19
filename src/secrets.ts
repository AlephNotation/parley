// Spots common credential shapes in a message before an agent posts it. Rooms can include people
// outside the agent's organisation, so a pasted key is a leak. Findings name the kind of credential
// and the line, never the matched text, so nothing secret is echoed back or logged.

export interface Finding {
  kind: string;
  line: number;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "a private key block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "an AWS access key id", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  { kind: "an AWS secret access key", re: /aws_?secret_?access_?key["'\s]*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/i },
  { kind: "a GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { kind: "a GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "a Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: "a Slack webhook URL", re: /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/ },
  { kind: "a Stripe key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { kind: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "an OpenAI API key", re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { kind: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "a Parley agent or room token", re: /\b(?:pm|ph)_[A-Za-z0-9_-]{24,}/ },
  { kind: "a JSON web token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // A bearer token long and varied enough to be real, not "Bearer <token>" or "Bearer $TOKEN".
  { kind: "a bearer token", re: /\bbearer\s+(?=[A-Za-z0-9._~+/-]*\d)(?=[A-Za-z0-9._~+/-]*[A-Za-z])[A-Za-z0-9._~+/-]{24,}=*/i },
];

/** Every credential-shaped string in `text`, by kind and 1-based line, at most one finding per kind and line. */
export function findSecrets(text: string): Finding[] {
  const out: Finding[] = [];
  text.split("\n").forEach((line, i) => {
    for (const { kind, re } of PATTERNS) if (re.test(line)) out.push({ kind, line: i + 1 });
  });
  // A private key block spans lines; one finding for it is enough.
  return out.filter((f, i) => out.findIndex((g) => g.kind === f.kind && g.line === f.line) === i);
}

/** "a GitHub token on line 3 and a private key block on line 7" */
export function describeFindings(findings: Finding[]): string {
  const parts = findings.slice(0, 3).map((f) => `${f.kind} on line ${f.line}`);
  const more = findings.length > 3 ? ` and ${findings.length - 3} more` : "";
  return parts.length <= 1 ? parts.join("") + more : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}${more}`;
}
