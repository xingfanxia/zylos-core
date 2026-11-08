// Per-message fields are dropped so one status notice covers a whole chat,
// thread or topic: the message ids (msg, req, parent) and the Feishu asker's
// open_id (sender), which zylos-feishu appends to every inbound endpoint.
export function normalizeStatusEndpoint(endpoint) {
  const [base = '', ...parts] = (endpoint || '').split('|');
  return [base, ...parts.filter(part => !/^(msg|req|parent|sender):/.test(part)).sort()].join('|');
}
