/** Presentation only: saved names remain the keys used by mentions and routing. */
const characterNames: Record<string, string> = {
  product: "Mira", platform: "Atlas", research: "Sage", design: "Luna",
  engineering: "Theo", ui: "Iris", ux: "Nova", qa: "Quinn",
  security: "Raven", operations: "Kai", data: "Ada", documentation: "Cleo",
  planner: "Finn", reviewer: "Vera", builder: "Theo", critic: "Raven", architect: "Atlas",
  "session 組織與任務規劃": "Finn",
  "輸入操作與介面體驗": "Iris",
  "模型路由與用量分析": "Ada",
  "agent 執行與背景工作": "Theo",
  "審查協作與程式碼變更": "Vera",
  "對話紀錄與知識檢索": "Sage",
  "瀏覽器工具與檔案媒體": "Nova",
  "workspace、帳戶與安全": "Raven",
  "資料儲存與狀態同步": "Kai",
  "平台可靠性與部署": "Atlas"
};
const domainCharacters: Array<[RegExp, string]> = [
  [/^(?:fairshot )?hiring platform$/i, "Mira"],
  [/^local (?:development|dev) environment$/i, "Theo"],
  [/^deployment (?:and|&) (?:cloud )?infrastructure$/i, "Atlas"],
  [/^end-to-end workflow testing$/i, "Quinn"],
  [/^data models (?:and|&) api contracts$/i, "Ada"],
  [/^observability (?:and|&) diagnostics$/i, "Sage"],
  [/^code review (?:and|&) repository maintenance$/i, "Vera"],
  [/^(?:codex|agent) tools (?:and|&) automation$/i, "Nova"],
  [/^developer productivity$/i, "Finn"]
];

export function domainActorIdentity(actor: { name: string }) {
  const name = actor.name.trim();
  const character = characterNames[name.toLowerCase()] ?? domainCharacters.find(([pattern]) => pattern.test(name))?.[1];
  return { name: character ?? (name || "Actor"), role: character ? name : null };
}

/** Search the name shown in the UI while retaining saved-name mention compatibility. */
export function domainActorMatchesMention(actor: { name: string }, query: string) {
  const normalized = query.toLowerCase();
  return actor.name.toLowerCase().includes(normalized)
    || domainActorIdentity(actor).name.toLowerCase().includes(normalized);
}
