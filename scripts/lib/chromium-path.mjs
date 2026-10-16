// The one Chromium resolver for Node browser tests (same order as
// scripts/lib/chromium_path.py): TP_CHROMIUM, TP_QA_CHROMIUM,
// TP_BROWSER_EXECUTABLE (an explicit path must exist), then the newest
// Playwright-managed full Chromium (/opt/pw-browsers/chromium-*/chrome-linux/chrome),
// then common system paths.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ENV_NAMES = ['TP_CHROMIUM', 'TP_QA_CHROMIUM', 'TP_BROWSER_EXECUTABLE'];
const SYSTEM_PATHS = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
const isFile = file => { try { return statSync(file).isFile(); } catch { return false; } };

function managed(root = '/opt/pw-browsers') {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map(name => ({ name, revision: Number(/^chromium-(\d+)$/.exec(name)?.[1] ?? -1) }))
    .filter(row => row.revision >= 0)
    .sort((a, b) => b.revision - a.revision)
    .map(row => path.join(root, row.name, 'chrome-linux', 'chrome'));
}

/** Absolute path of a Chromium executable; throws (or returns null) when none exists. */
export function chromiumExecutable({ required = true } = {}) {
  for (const name of ENV_NAMES) {
    const value = String(process.env[name] || '').trim();
    if (!value) continue;
    if (!isFile(value)) throw new Error(`${name}=${value} is not an executable file`);
    return value;
  }
  const found = [...managed(), ...SYSTEM_PATHS].find(isFile);
  if (found) return found;
  if (required) throw new Error('No Chromium found: set TP_CHROMIUM (or TP_QA_CHROMIUM / TP_BROWSER_EXECUTABLE) to a Chromium executable.');
  return null;
}
