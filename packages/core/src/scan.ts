import fs from "node:fs/promises";
import path from "node:path";

export const SCAN_SEVERITIES = ["high", "medium", "low"] as const;
export type ScanSeverity = (typeof SCAN_SEVERITIES)[number];

export interface ScanFinding {
  rule: string;
  severity: ScanSeverity;
  file: string;
  line: number;
  excerpt: string;
}

export interface ScanReport {
  findings: ScanFinding[];
  scannedFiles: number;
  blocked: boolean;
}

interface Rule {
  id: string;
  severity: ScanSeverity;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { id: "pipe-download-to-shell", severity: "high", pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(?:ba|z|k)?sh\b/ },
  { id: "pipe-download-to-interpreter", severity: "high", pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(?:python[0-9.]*|node|perl|ruby)\b/ },
  { id: "base64-pipe-to-shell", severity: "high", pattern: /\bbase64\s+(?:-d|--decode)\b[^\n|]*\|\s*(sudo\s+)?(?:ba|z|k)?sh\b/ },
  { id: "reverse-shell-tcp", severity: "high", pattern: /\/dev\/tcp\// },
  { id: "reverse-shell-nc", severity: "high", pattern: /\bnc\b[^\n]*\s-e\s/ },
  { id: "reverse-shell-socat", severity: "high", pattern: /\bsocat\b[^\n]*\bexec\b/i },
  { id: "destructive-root-removal", severity: "high", pattern: /\brm\s+-[A-Za-z]*r[A-Za-z]*f?\s+\/(?:\s|$|\*)/ },
  { id: "credential-file-exfiltration", severity: "high", pattern: /\b(curl|wget|nc|scp)\b[^\n]*(?:id_rsa|\.aws\/credentials|\.netrc|\.ssh\/)/ },
  { id: "hidden-unicode-control", severity: "high", pattern: /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/ },
  { id: "ignore-instructions", severity: "high", pattern: /\b(?:ignore|disregard|forget)\b[^\n]{0,40}\b(?:previous|prior|above|earlier)\b[^\n]{0,20}\b(?:instructions?|prompts?|rules?|messages?)\b/i },
  { id: "do-not-inform-user", severity: "medium", pattern: /\b(?:do not|don't|never)\b[^\n]{0,30}\b(?:tell|inform|notify|mention)\b[^\n]{0,20}\b(?:user|human|owner)\b/i },
  { id: "without-informing-user", severity: "medium", pattern: /\bwithout\s+(?:informing|notifying|telling)\s+(?:the\s+)?(?:user|human|owner)\b/i },
  { id: "override-system-prompt", severity: "medium", pattern: /\b(?:you are now|new\s+(?:system\s+)?prompt|override\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions))\b/i },
  { id: "keep-secret-from-user", severity: "medium", pattern: /\bkeep\s+(?:this|it)\s+(?:a\s+)?secret\b/i },
  { id: "exfiltrate-to-url", severity: "medium", pattern: /\b(?:send|upload|forward|post|transmit)\b[^\n]{0,40}\bto\b[^\n]{0,20}https?:\/\//i },
];

const DEFAULT_SKIP = new Set([".git", "node_modules", "dist", "data", "coverage", ".agentshare"]);
const MAX_FILE_BYTES = 512 * 1024;

export function scanText(text: string, file = "(text)"): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        file,
        line: index + 1,
        excerpt: line.trim().slice(0, 200),
      });
    }
  }
  return findings;
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (DEFAULT_SKIP.has(entry.name)) continue;
      files.push(...(await listFiles(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

export async function scanPack(dir: string): Promise<ScanReport> {
  const root = path.resolve(dir);
  const findings: ScanFinding[] = [];
  let scannedFiles = 0;
  for (const rel of await listFiles(root)) {
    if (rel.endsWith(".tgz")) continue;
    const file = path.join(root, rel);
    const stat = await fs.stat(file);
    if (stat.size > MAX_FILE_BYTES) continue;
    const bytes = await fs.readFile(file);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (text.includes("\uFFFD")) continue;
    scannedFiles += 1;
    findings.push(...scanText(text, rel));
  }
  return {
    findings,
    scannedFiles,
    blocked: findings.some((finding) => finding.severity === "high"),
  };
}

export function formatScanFinding(finding: ScanFinding): string {
  return `[${finding.severity}] ${finding.rule} ${finding.file}:${finding.line} ${finding.excerpt}`;
}

export function summarizeScan(report: ScanReport): string {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of report.findings) counts[finding.severity] += 1;
  return `${report.scannedFiles} files scanned; ${counts.high} high, ${counts.medium} medium, ${counts.low} low`;
}
