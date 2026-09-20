"use strict";

// A planner's guesses about output format must not precede source resolution.
// This changes guidance only: it neither routes models nor restricts tools.
function sourceResolutionGuidance(contract) {
  const intent = contract?.contentIntent;
  if (contract?.externalFactPolicy?.required) return "";
  if (!intent || !["extract", "understand", "convert", "modify"].includes(intent.operation)) return "";
  if (!intent.sourceKinds?.length || intent.attachmentKinds?.length || contract.priorSourceContentEvidence) return "";
  if ((contract.intentContract?.relation || "new") !== "new") return "";
  return [
    "Source resolution precedes output planning:",
    "This new request refers to source content, but no attachment source is bound to it. No output format or deliverable has been established by the platform.",
    "Resolve the source from the current user's words, actual attachment manifest and explicit file references. A file path or a request to work on identified workspace content authorizes normal inspection and processing; no upload is needed in that case.",
    "A missing attachment cannot be identified by similarity, by being the only file of its type, by an earlier generated output, or by a workspace memory digest. If the user refers to an attachment that is not available and has not explicitly identified another source, ask for the attachment and wait. Do not inspect or process unrelated old files as a substitute.",
    "Once the source is identified, perform the full requested task with all available tools. Choose the result format from the user's request, not the source's extension. Do not invent office-file delivery requirements for an in-chat answer.",
    "Report actual evidence and limitations. A request for necessary input is pending work, not a successful deliverable. Later user revisions override conflicting earlier plans; stopping work does not authorize deletion of existing outputs.",
  ].join("\n");
}

module.exports = { sourceResolutionGuidance };
