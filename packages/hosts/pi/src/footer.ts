import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Custom footer: the built-in layout, with pi-enhance control labels placed on
 * the project-path line instead of a separate status line below the stats.
 */
export interface FooterLabel {
  id: string;
  value: string;
  active: boolean;
}

interface MinimalUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number };
}
interface MinimalEntry {
  type: string;
  usage?: MinimalUsage;
  message?: { role: string; usage?: MinimalUsage };
}

const sanitize = (text: string): string =>
  text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();

const formatTokens = (count: number): string => {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
};

const formatCwd = (cwd: string, home: string | undefined): string => {
  if (!home) return cwd;
  const relativePath = relative(resolve(home), resolve(cwd));
  const inside =
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
  if (!inside) return cwd;
  return relativePath === "" ? "~" : `~${sep}${relativePath}`;
};

export function installEnhanceFooter(
  ctx: ExtensionContext,
  statusKey: string,
  getLabels: () => readonly FooterLabel[],
): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        // Line 1: project path with the control labels right-aligned beside it.
        let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME ?? process.env.USERPROFILE);
        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) pwd = `${pwd} • ${sessionName}`;
        const labels = getLabels().filter((label) => label.value.length > 0);
        const labelsPlain = labels.map((label) => `${label.id}:${label.value}`).join(" ");
        const minGap = 2;
        const pwdWidth = visibleWidth(pwd);
        let labelsText: string | undefined;
        if (labelsPlain && pwdWidth + minGap + visibleWidth(labelsPlain) <= width) {
          labelsText = labelsPlain;
        } else if (labelsPlain) {
          const available = width - pwdWidth - minGap;
          if (available >= 8) labelsText = truncateToWidth(labelsPlain, available, "…");
        }
        let firstLine = theme.fg("dim", truncateToWidth(pwd, width, theme.fg("dim", "...")));
        if (labelsText) {
          const styled = labels
            .map((label) => theme.fg(label.active ? "accent" : "dim", `${label.id}:${label.value}`))
            .join(" ");
          if (labelsText === labelsPlain) {
            const padding = " ".repeat(width - pwdWidth - visibleWidth(labelsPlain));
            firstLine = theme.fg("dim", pwd) + padding + styled;
          } else {
            firstLine = theme.fg("dim", pwd) + " ".repeat(minGap) + theme.fg("dim", labelsText);
          }
        }
        // Line 2: usage and context stats on the left, model info on the right.
        let input = 0,
          output = 0,
          cacheRead = 0,
          cacheWrite = 0,
          cost = 0;
        let latestCacheHitRate: number | undefined;
        const add = (usage: MinimalUsage): void => {
          input += usage.input;
          output += usage.output;
          cacheRead += usage.cacheRead;
          cacheWrite += usage.cacheWrite;
          cost += usage.cost?.total ?? 0;
        };
        for (const entry of ctx.sessionManager.getEntries() as unknown as readonly MinimalEntry[]) {
          if (entry.type === "usage" && entry.usage) add(entry.usage);
          else if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
            add(entry.message.usage);
            const promptTokens =
              entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
            latestCacheHitRate =
              promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
          } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage)
            add(entry.message.usage);
          else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage)
            add(entry.usage);
        }
        const statsParts: string[] = [];
        if (input) statsParts.push(`↑${formatTokens(input)}`);
        if (output) statsParts.push(`↓${formatTokens(output)}`);
        if (cacheRead) statsParts.push(`R${formatTokens(cacheRead)}`);
        if (cacheWrite) statsParts.push(`W${formatTokens(cacheWrite)}`);
        if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined)
          statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
        // Kimi Coding is subscription-backed despite API-key auth; other providers
        // cannot be queried from an extension, so they simply omit the marker.
        const usingSubscription = ctx.model?.provider === "kimi-coding";
        if (cost || usingSubscription)
          statsParts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
        const contextUsage = ctx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const percent = contextUsage?.percent ?? 0;
        const contextDisplay =
          contextUsage?.percent == null
            ? `?/${formatTokens(contextWindow)}`
            : `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
        statsParts.push(
          percent > 90
            ? theme.fg("error", contextDisplay)
            : percent > 70
              ? theme.fg("warning", contextDisplay)
              : contextDisplay,
        );
        if (process.env.PI_EXPERIMENTAL === "1")
          statsParts.push(`${theme.fg("dim", "•")} ${theme.fg("warning", "xp")}`);
        let statsLeft = statsParts.join(" ");
        let statsLeftWidth = visibleWidth(statsLeft);
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLeftWidth = visibleWidth(statsLeft);
        }
        const modelName = ctx.model?.id || "no-model";
        let rightSide = modelName;
        if (ctx.model?.reasoning) {
          const thinkingLevel = ctx.thinkingLevel || "off";
          rightSide =
            thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
        }
        if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
          const withProvider = `(${ctx.model.provider}) ${rightSide}`;
          if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
        }
        const rightWidth = visibleWidth(rightSide);
        const lines: string[] = [];
        if (statsLeftWidth + 2 + rightWidth <= width) {
          const padding = " ".repeat(width - statsLeftWidth - rightWidth);
          lines.push(theme.fg("dim", statsLeft + padding + rightSide));
        } else {
          const availableForRight = width - statsLeftWidth - 2;
          if (availableForRight > 0) {
            const truncated = truncateToWidth(rightSide, availableForRight, "");
            lines.push(
              theme.fg(
                "dim",
                statsLeft +
                  " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncated))) +
                  truncated,
              ),
            );
          } else lines.push(theme.fg("dim", statsLeft));
        }
        // Line 3: statuses from other extensions; our own labels live on line 1.
        const otherStatuses = [...footerData.getExtensionStatuses()]
          .filter(([key]) => key !== statusKey)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => sanitize(text));
        if (otherStatuses.length)
          lines.push(truncateToWidth(otherStatuses.join(" "), width, theme.fg("dim", "...")));
        return [firstLine, ...lines];
      },
    };
  });
}
