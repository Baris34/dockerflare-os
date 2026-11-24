// This is the export boundary. Read only identifiers and typed accounting/status fields.
// Never serialize a source record, error, description, message body, tool argument or result.
const toolNames = new Set([
  "readFile",
  "grep",
  "writeFile",
  "editFile",
  "describeBinding",
  "setBindingHook",
  "setGadgetBinding",
  "saveCapsuleAsBinding",
  "createGadget",
  "createWorktree",
  "executeCode",
  "giveUp",
  "webFetch",
  "observeUserChanges",
  "listBlueprints",
  "listConnectableResources",
  "requestConnection",
  "createExternalResource",
]);
export function identifier(value) {
  return typeof value === "string" &&
    value.length <= 160 &&
    /^[\p{L}\p{N}_.:@/+-]+$/u.test(value) &&
    !/(?:^|[./:])(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.)/i.test(
      value,
    ) &&
    !/^\d{13,19}$/.test(value)
    ? value
    : null;
}
export const integer = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
export const time = (value) =>
  integer(value instanceof Date ? value.getTime() : value);
export const positive = (value) =>
  Number.isFinite(value) && value > 0 ? value : null;
export const requestId = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    value,
  )
    ? value
    : null;
const toolName = (value) => (toolNames.has(value) ? value : "unknown-tool");

export function modelEvent(row, record) {
  const m = record?.message;
  if (!m || m.role !== "assistant") return;
  const id = requestId(record.osDashboardRequestId ?? record.seyirRequestId),
    requested = identifier(m.model),
    served = identifier(m.responseModel);
  const usage = m.usage;
  const input = integer(usage?.input),
    output = integer(usage?.output);
  const cacheRead = integer(usage?.cacheRead) ?? 0,
    cacheWrite = integer(usage?.cacheWrite) ?? 0;
  // pi initializes unreported usage and prices to zero. A zero-only snapshot cannot prove a price or a measurement.
  const measured =
    input > 0 ||
    output > 0 ||
    cacheRead > 0 ||
    cacheWrite > 0 ||
    integer(usage?.totalTokens) > 0;
  const cost = positive(usage?.cost?.total);
  return {
    event_id: id ? "request:" + id : "step:" + row.sequence,
    type: "model",
    ts: time(m.timestamp) ?? time(row.timestamp),
    name: served ?? requested,
    actor: identifier(row.author?.id),
    status:
      m.stopReason === "error"
        ? "failed"
        : m.stopReason === "aborted"
          ? "aborted"
          : "completed",
    requested_model: requested,
    served_model: served,
    request_id: id,
    operation: "chat",
    source_seq: row.sequence,
    input_tokens:
      measured && input !== null
        ? integer(input + cacheRead + cacheWrite)
        : null,
    output_tokens: measured ? output : null,
    cost_usd: cost,
    cost_source: cost === null ? null : "workshop_estimate",
  };
}
export function toolEvents(row, snapshot) {
  const completed = Array.isArray(row.toolCalls) ? row.toolCalls : [];
  const results = completed.map((call, i) => ({
    event_id: "tool:" + row.sequence + ":" + i,
    type: "tool",
    ts: time(row.timestamp),
    actor: identifier(row.author?.id),
    name: toolName(call.toolName),
    status:
      call.error === "Operation aborted"
        ? "aborted"
        : Object.hasOwn(call, "error")
          ? "failed"
          : "executed",
    source_seq: row.sequence,
  }));
  const matched = new Set(completed.map((c) => c.toolCallId));
  const blocks = snapshot?.message?.content;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block?.type === "toolCall" && !matched.has(block.id)) {
        results.push({
          event_id: "tool:" + row.sequence + ":" + results.length,
          type: "tool",
          ts: time(row.timestamp),
          name: toolName(block.name),
          actor: identifier(row.author?.id),
          status: "requested",
          source_seq: row.sequence,
        });
      }
    }
  }
  return results;
}
export function decisionCard(row) {
  if (!["connectionRequest", "webFetchRequest"].includes(row.type)) return;
  const statuses = {
    pending: "pending",
    accepted: "approved",
    approved: "approved",
    denied: "denied",
  };
  if (!Object.hasOwn(statuses, row.state)) return;
  return {
    event_id: "decision:" + row.sequence,
    type: "approval",
    name:
      row.type === "connectionRequest"
        ? (identifier(row.vendorId) ?? "connection")
        : "webFetch",
    status: statuses[row.state],
    ts: time(row.timestamp),
    actor: row.state === "pending" ? null : identifier(row.decidedBy),
    source_seq: row.sequence,
  };
}
export function actionDecision(action) {
  if (
    action?.type !== "action" ||
    integer(action.id) === null ||
    integer(action.caller?.chatId) === null
  )
    return;
  const status =
    action.state === "approved"
      ? action.autoApproved === true
        ? "auto_approved"
        : "approved"
      : action.state === "rejected"
        ? "denied"
        : action.state === "pending"
          ? "pending"
          : null;
  if (!status) return;
  return {
    event_id: "action:" + action.id,
    type: "approval",
    status,
    ts: time(action.appliedAt) ?? time(action.createdAt),
    name: identifier(action.description?.actionKind?.tag) ?? "action",
    actor: status === "pending" ? null : identifier(action.resolvedBy?.id),
    action_id: action.id,
  };
}
