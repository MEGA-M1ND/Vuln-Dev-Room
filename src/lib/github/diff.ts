import { ApiError } from "@/lib/api/errors";

/**
 * The exact file contents a human approved, as recorded on the run's DIFF
 * artifact by the agent runtime (`contentJson.files`).
 *
 * Delivery deliberately applies THIS rather than reconstructing files from the
 * unified diff text: the diff is for humans to read, while this is the precise,
 * reviewed output. If it is missing we refuse to open a pull request rather
 * than guessing at file contents.
 */
export type ReviewedFile = { path: string; content: string };

/** Paths must stay inside the repository — no absolute paths or traversal. */
function assertSafePath(path: string): string {
  const p = path.trim().replace(/\\/g, "/");
  if (
    !p ||
    p.startsWith("/") ||
    p.includes("..") ||
    p.includes("\0") ||
    p.length > 400
  ) {
    throw new ApiError("BAD_REQUEST", `Unsafe file path in run output: ${path}`);
  }
  return p;
}

export function readReviewedFiles(contentJson: unknown): ReviewedFile[] {
  if (!contentJson || typeof contentJson !== "object") return [];
  const files = (contentJson as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];

  const out: ReviewedFile[] = [];
  for (const entry of files) {
    if (!entry || typeof entry !== "object") continue;
    const { path, content } = entry as { path?: unknown; content?: unknown };
    if (typeof path !== "string" || typeof content !== "string") continue;
    out.push({ path: assertSafePath(path), content });
  }
  return out;
}
