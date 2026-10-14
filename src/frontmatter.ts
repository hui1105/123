import { parse as parseYaml, stringify } from 'yaml';

/**
 * Minimal frontmatter parser. Only supports YAML (the `---` delimiter).
 * Does NOT support `---js` / `---javascript` to avoid eval()-based RCE
 * that exists in gray-matter's built-in JS engine.
 */
export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  content: string;
} {
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw };
  const data = (parseYaml(match[1]!) as Record<string, unknown>) ?? {};
  return { data, content: match[2] ?? '' };
}

/**
 * Ensures `disable-model-invocation: true` is present in a SKILL.md's YAML frontmatter.
 * Preserves existing frontmatter formatting when possible.
 */
export function applyDisableModelInvocation(raw: string): string {
  const { data, content } = parseFrontmatter(raw);
  if (data['disable-model-invocation'] === true) {
    return raw;
  }

  const match = raw.match(/^(\uFEFF?)---(\r?\n)([\s\S]*?)\r?\n---(\r?\n?[\s\S]*)$/);
  if (match) {
    const [, bom, newline, frontmatter, rest] = match;
    const updatedFrontmatter = /^disable-model-invocation\s*:/m.test(frontmatter!)
      ? frontmatter!.replace(/^disable-model-invocation\s*:.*$/m, 'disable-model-invocation: true')
      : `${frontmatter!.replace(/\s+$/, '')}${newline}disable-model-invocation: true`;
    const candidate = `${bom}---${newline}${updatedFrontmatter}${newline}---${rest}`;
    if (parseFrontmatter(candidate).data['disable-model-invocation'] === true) {
      return candidate;
    }
  }

  const updatedData = { ...data, 'disable-model-invocation': true };
  const serialized = stringify(updatedData).trimEnd();
  return `---\n${serialized}\n---\n${content.replace(/^\r?\n/u, '')}`;
}
