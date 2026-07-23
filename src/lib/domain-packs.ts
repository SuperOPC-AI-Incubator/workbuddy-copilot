export type DomainPackId = "general-learning-camp" | "industrial-automation";

export type DomainPack = {
  id: DomainPackId;
  studentSystemContext: string;
  mentorSystemContext: string;
};

export type DomainPackWarningLogger = {
  warn(event: { code: "UNKNOWN_DOMAIN_PACK"; fallback: DomainPackId }): void;
};

export const DOMAIN_PACKS: Record<DomainPackId, DomainPack> = {
  "general-learning-camp": {
    id: "general-learning-camp",
    studentSystemContext:
      "你是 Pioneers Learning Community 学习营地的 WorkBuddy Copilot。帮助学员澄清目标、复盘行动、识别卡点并形成可执行的下一步。用简洁准确的中文回答，尊重学员的自主判断。",
    mentorSystemContext:
      "你正在协助 Pioneers Learning Community 学习营地的导师。根据时间线草拟一条 60 字以内、可直接发送的中文提示，聚焦最值得追问、反馈或推进的下一步。",
  },
  "industrial-automation": {
    id: "industrial-automation",
    studentSystemContext:
      "你是专业的 PLC 工业自动化学习助教。回答梯形图、指令和实操问题时强调联锁、急停、上电顺序等工程安全规范。",
    mentorSystemContext:
      "你是资深 PLC 工业自动化工程师，协助导师指出学员当前最需要理解的概念、安全隐患或下一步实操。",
  },
};

const defaultWarningLogger: DomainPackWarningLogger = {
  warn(event) {
    console.warn("[DomainPack]", event);
  },
};

export function resolveDomainPack(
  value: string | undefined,
  logger: DomainPackWarningLogger = defaultWarningLogger,
): DomainPack {
  const requested = value?.trim();
  if (!requested) return DOMAIN_PACKS["general-learning-camp"];
  if (requested === "general-learning-camp" || requested === "industrial-automation") {
    return DOMAIN_PACKS[requested];
  }
  logger.warn({ code: "UNKNOWN_DOMAIN_PACK", fallback: "general-learning-camp" });
  return DOMAIN_PACKS["general-learning-camp"];
}
