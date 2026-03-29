/**
 * 3차 방어: 러너 완료 후 origin issue 자동 연결 안전장치
 *
 * 사용자 프롬프트에 이슈 entityReference가 있고,
 * 러너 히스토리에서 플랜 생성이 감지되면,
 * `agentteams plan issue` CLI를 실행하여 이슈를 연결합니다.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { logger } from "../logger.js";

type IssueRef = {
  provider: string;
  externalId: string;
  externalUrl: string;
  externalTitle?: string;
};

const ENTITY_TYPE_TO_PROVIDER: Record<string, string> = {
  GITHUB_ISSUE: "GITHUB",
  GITLAB_ISSUE: "GITLAB",
  LINEAR_ISSUE: "LINEAR",
};

const ISSUE_ENTITY_TYPES = new Set(Object.keys(ENTITY_TYPE_TO_PROVIDER));

/**
 * 프롬프트(문자열)에서 이슈 entityReference를 추출합니다.
 * 형식: [label](TYPE:id) — TYPE이 GITHUB_ISSUE, GITLAB_ISSUE, LINEAR_ISSUE인 경우
 */
function extractIssueRefsFromText(text: string): IssueRef[] {
  const results: IssueRef[] = [];
  const seen = new Set<string>();

  // Pattern: [label](TYPE:id) or [label](TYPE:id:path)
  const refPattern = /\[([^\]]*)\]\((\w+):([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = refPattern.exec(text)) !== null) {
    const [, label, entityType, rest] = match;
    if (!ISSUE_ENTITY_TYPES.has(entityType)) continue;

    const provider = ENTITY_TYPE_TO_PROVIDER[entityType];
    // rest may be "id" or "id:url" — for LINEAR_ISSUE it's typically a UUID
    const entityId = rest.split(":")[0];
    if (!entityId) continue;

    const key = `${provider}:${entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      provider,
      externalId: entityId,
      externalUrl: "", // URL not available from text format
      externalTitle: label || undefined,
    });
  }

  return results;
}

/**
 * 프롬프트(Tiptap JSON)에서 이슈 entityReference 노드를 추출합니다.
 */
function extractIssueRefsFromTiptap(content: Record<string, unknown>): IssueRef[] {
  const results: IssueRef[] = [];
  const seen = new Set<string>();

  function walk(node: Record<string, unknown>): void {
    if (node.type === "entityReference" && node.attrs) {
      const attrs = node.attrs as Record<string, unknown>;
      const entityType = attrs.entityType as string;
      const provider = ENTITY_TYPE_TO_PROVIDER[entityType];
      if (provider) {
        const entityId = (attrs.entityId as string) ?? "";
        const htmlUrl = (attrs.htmlUrl as string) ?? "";
        const label = (attrs.label as string) ?? "";

        if (entityId) {
          const key = `${provider}:${entityId}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({
              provider,
              externalId: entityId,
              externalUrl: htmlUrl,
              externalTitle: label || undefined,
            });
          }
        }
      }
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content as Record<string, unknown>[]) {
        walk(child);
      }
    }
  }

  walk(content);
  return results;
}

/**
 * 프롬프트에서 이슈 참조를 추출합니다 (문자열 / Tiptap JSON 모두 지원).
 */
export function extractIssueRefsFromPrompt(prompt: string | Record<string, unknown>): IssueRef[] {
  if (typeof prompt === "string") {
    return extractIssueRefsFromText(prompt);
  }
  return extractIssueRefsFromTiptap(prompt);
}

/**
 * 히스토리 마크다운에서 생성된 플랜 ID를 추출합니다.
 * `plan create` 출력이나 planId 패턴을 감지합니다.
 */
function extractCreatedPlanIds(historyMarkdown: string): string[] {
  const planIds: string[] = [];
  const seen = new Set<string>();

  // Pattern 1: CLI output JSON containing "id" field — e.g., { "id": "uuid", ... }
  // Pattern 2: plan ID in format like planId: uuid or --id uuid
  // Pattern 3: UUID-like strings after "plan create" or "Plan created" context
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  // Look for lines that suggest plan creation
  const lines = historyMarkdown.split("\n");
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (
      lower.includes("plan create") ||
      lower.includes("plan created") ||
      lower.includes("creating plan") ||
      lower.includes("plan-id") ||
      lower.includes("planid")
    ) {
      const matches = line.match(uuidPattern);
      if (matches) {
        for (const id of matches) {
          if (!seen.has(id)) {
            seen.add(id);
            planIds.push(id);
          }
        }
      }
    }
  }

  return planIds;
}

/**
 * `agentteams plan issue` CLI를 실행합니다 (fire-and-forget).
 */
function execPlanIssue(
  cwd: string,
  planId: string,
  issue: IssueRef
): Promise<void> {
  return new Promise((resolve) => {
    const args = [
      "plan", "issue",
      "--id", planId,
      "--provider", issue.provider,
      "--external-id", issue.externalId,
      "--external-url", issue.externalUrl || "unknown",
    ];
    if (issue.externalTitle) {
      args.push("--title", issue.externalTitle);
    }

    execFile("agentteams", args, { cwd, timeout: 15000, windowsHide: true }, (error: Error | null) => {
      if (error) {
        // 409 or other failure — skip silently
        logger.warn("Origin issue safeguard: plan issue command failed", {
          planId,
          provider: issue.provider,
          externalId: issue.externalId,
          error: error.message,
        });
      }
      resolve();
    });
  });
}

/**
 * 트리거 완료 후 origin issue 자동 연결 안전장치를 실행합니다.
 * fire-and-forget: 실패해도 트리거 완료에 영향 없음.
 */
export async function runOriginIssueSafeguard(
  prompt: string | Record<string, unknown>,
  historyPath: string | null,
  authPath: string | null
): Promise<void> {
  if (!historyPath || !authPath) return;

  try {
    // 1. 프롬프트에서 이슈 참조 추출
    const issueRefs = extractIssueRefsFromPrompt(prompt);
    if (issueRefs.length === 0) return;

    // 2. 히스토리에서 플랜 생성 감지
    let historyContent: string;
    try {
      historyContent = await readFile(historyPath, "utf8");
    } catch {
      return; // 히스토리 파일 없으면 중단
    }

    const planIds = extractCreatedPlanIds(historyContent);
    if (planIds.length === 0) return;

    // 3. 각 플랜 × 이슈 조합에 대해 CLI 실행
    logger.info("Origin issue safeguard: linking issues to plans", {
      planIds,
      issueCount: issueRefs.length,
    });

    for (const planId of planIds) {
      for (const issue of issueRefs) {
        await execPlanIssue(authPath, planId, issue);
      }
    }
  } catch (error) {
    logger.warn("Origin issue safeguard failed (non-blocking)", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
