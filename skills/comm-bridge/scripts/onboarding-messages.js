/**
 * ZY-UX-1 — new-user onboarding message helpers (pure + DI).
 *
 * Renders the zh/en onboarding templates (templates/messages/*.md) and the
 * daily-quota breach comparator. All IO is injectable so this unit-tests without
 * a filesystem or channel. c4-approve wires these into the hold + approve flow.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Skill-local templates (skills/comm-bridge/templates/messages) so they deploy
// with the skill copy under ~/zylos/.claude/skills — a package-root templates/
// dir would not be copied to the deployed tree.
const DEFAULT_TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates', 'messages');

/**
 * Pick a language for a user based on their first message. CJK present → 'zh'.
 * @param {string} text
 * @returns {'zh'|'en'}
 */
export function detectLang(text) {
  return /[一-鿿぀-ヿ]/.test(String(text || '')) ? 'zh' : 'en';
}

/**
 * Render an onboarding message template's language section with placeholder
 * substitution. Templates use `## zh` / `## en` section headers; `{name}` and
 * other `{key}` placeholders are substituted from `vars` (a leading space is
 * added before a non-empty name so "Hi{name}!" reads "Hi Alice!" or "Hi!").
 *
 * @param {string} templateName - e.g. 'hold-ack' | 'welcome'
 * @param {{ lang?: 'zh'|'en', name?: string } & Record<string,string>} [vars]
 * @param {{ templatesDir?: string, readFileSync?: typeof fs.readFileSync }} [io]
 * @returns {string}
 */
export function renderOnboardingMessage(templateName, vars = {}, io = {}) {
  const templatesDir = io.templatesDir || DEFAULT_TEMPLATES_DIR;
  const readFileSync = io.readFileSync || fs.readFileSync;
  const lang = vars.lang === 'zh' ? 'zh' : 'en';

  const raw = readFileSync(path.join(templatesDir, `${templateName}.md`), 'utf8');
  const section = extractSection(raw, lang) || extractSection(raw, 'en') || raw;

  const name = vars.name ? ` ${String(vars.name).trim()}` : '';
  return section
    .replace(/\{name\}/g, name)
    .replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m))
    .trim();
}

function extractSection(raw, lang) {
  // Line-based split on "## <lang>" headers up to the next "## " header or EOF.
  const body = [];
  let capturing = false;
  for (const line of String(raw).split(/\r?\n/)) {
    const h = line.match(/^##\s+(\S+)/);
    if (h) { capturing = h[1] === lang; continue; }
    if (capturing) body.push(line);
  }
  return body.length ? body.join('\n').trim() : null;
}

/**
 * Compare each instance's today-token usage against its daily quota and return
 * the breaches. Pure — caller supplies the token cache and the instance configs.
 *
 * @param {object} tokenCache - activity-monitor/token-cache.json shape
 *   ({ instances: { <id>: { daily: number } } }).
 * @param {Record<string, { quota_tokens_daily?: number }>} instances
 *   instances.json `instances` map.
 * @returns {Array<{ instance: string, used: number, quota: number }>}
 */
export function checkQuotaBreaches(tokenCache, instances) {
  const breaches = [];
  const byId = tokenCache?.instances || {};
  for (const [id, def] of Object.entries(instances || {})) {
    const quota = def?.quota_tokens_daily;
    if (!Number.isFinite(quota) || quota <= 0) continue; // no quota set
    const used = Number(byId[id]?.daily) || 0;
    if (used > quota) breaches.push({ instance: id, used, quota });
  }
  return breaches;
}

export const _internal = { DEFAULT_TEMPLATES_DIR, extractSection };
