import { shouldCompactPastedText } from "./attachments";
import { browserBridgeContextAttachmentName, parseBrowserBridgeContext } from "./browserBridgeContext";
import { parseTurnIssueContext, turnIssueContextAttachmentName } from "./turnIssueCopy";

type PasteData = Pick<DataTransfer, "files" | "items" | "getData">;

/**
 * Shared paste rules for every attachment-capable composer: pasted images/files,
 * Browser Bridge context, Threadex issue context, and long text all become
 * attachments. Returns null when the paste should fall through to normal text.
 */
export function attachmentFilesFromPaste(data: PasteData, existingNames: readonly string[] = []): File[] | null {
  const clipboardFiles = Array.from(data.files);
  const itemFiles = clipboardFiles.length === 0
    ? Array.from(data.items ?? []).filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => file !== null)
    : [];
  const files = [...clipboardFiles, ...itemFiles];
  if (files.length) return files;

  const text = data.getData("text/plain");
  const browserContext = parseBrowserBridgeContext(text);
  if (browserContext) {
    return [new File([JSON.stringify(browserContext, null, 2)], browserBridgeContextAttachmentName(browserContext), { type: "application/json" })];
  }
  const issueContext = parseTurnIssueContext(text);
  if (issueContext) {
    return [new File([JSON.stringify(issueContext, null, 2)], turnIssueContextAttachmentName(issueContext), { type: "application/json" })];
  }
  if (shouldCompactPastedText(text)) {
    const taken = new Set(existingNames.map(name => name.toLowerCase()));
    let index = 1, name = "Pasted text.txt";
    while (taken.has(name.toLowerCase())) name = `Pasted text ${++index}.txt`;
    return [new File([text], name, { type: "text/plain" })];
  }
  return null;
}
