import { z } from "zod";

export const SUBMISSION_SPEC = "submission/v0";

export const SUBMISSION_STATUSES = ["pending", "accepted", "rejected"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

const line = () => z.string().min(1).max(1000);

export const SubmissionInputSchema = z.object({
  spec: z.literal(SUBMISSION_SPEC),
  summary: z.string().min(1).max(4000),
  changes: z.array(line()).max(50).default([]),
  openQuestions: z.array(line()).max(20).default([]),
  authorName: z.string().min(1).max(40).optional(),
  sessionId: z.string().min(1).max(64).optional(),
});
export type SubmissionInput = z.infer<typeof SubmissionInputSchema>;

export interface ShareSubmission {
  id: number;
  shareId: string;
  sessionId?: string;
  authorName?: string;
  spec: typeof SUBMISSION_SPEC;
  summary: string;
  changes: string[];
  openQuestions: string[];
  status: SubmissionStatus;
  ownerNote?: string;
  createdAt: string;
  decidedAt?: string;
}

export function parseSubmissionInput(input: unknown): SubmissionInput {
  return SubmissionInputSchema.parse(input);
}

export function formatSubmissionIssues(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
