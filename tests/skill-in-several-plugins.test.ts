import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Everything printed through clack or console, in order, for --list assertions.
const output: string[] = [];

vi.mock('@clack/prompts', () => {
  const noop = () => {};
  const record = (...a: unknown[]) => output.push(a.join(' '));
  return {
    intro: noop,
    outro: noop,
    note: noop,
    confirm: vi.fn().mockResolvedValue(true),
    cancel: noop,
    isCancel: () => false,
    log: {
      info: noop,
      message: record,
      warn: noop,
      error: (...a: unknown[]) => console.log('[clack.error]', ...a),
      step: record,
      success: noop,
    },
    spinner: () => ({ start: noop, stop: noop }),
  };
});

vi.mock('picocolors', () => {
  const id = (s: string) => s;
  return { default: new Proxy(id, { get: () => id }) };
});

vi.mock('../src/telemetry.ts', () => ({
  track: vi.fn(),
  setVersion: vi.fn(),
  fetchAuditData: vi.fn().mockResolvedValue(null),
}));

vi.mock('../src/detect-agent.ts', () => ({
  detectAgent: vi.fn().mockResolvedValue({ isAgent: false, agent: { name: 'none' } }),
  getAgentType: vi.fn(),
  ensureUniversalAgents: vi.fn((x: string[]) => x),
}));

vi.mock('../src/prompts/search-multiselect.ts', async (importActual) => {
  const actual = await importActual<typeof import('../src/prompts/search-multiselect.ts')>();
  return { ...actual, searchMultiselect: vi.fn() };
});

import { runAdd } from '../src/add.ts';
import * as installer from '../src/installer.ts';
import { searchMultiselect } from '../src/prompts/search-multiselect.ts';
import type { Skill } from '../src/types.ts';

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
}

describe('skill listed under several plugins', () => {
  let base: string;
  let fixture: string;
  let project: string;
  let origCwd: string;

  beforeEach(async () => {
    output.length = 0;
    base = await mkdtemp(join(tmpdir(), 'multi-plugin-'));
    fixture = join(base, 'repo');
    await writeSkill(join(fixture, 'skills/xlsx'), 'xlsx');
    await writeSkill(join(fixture, 'skills/docx'), 'docx');
    await writeSkill(join(fixture, 'skills/standalone'), 'standalone');
    await mkdir(join(fixture, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(fixture, '.claude-plugin/marketplace.json'),
      JSON.stringify({
        plugins: [
          { name: 'document-skills', source: './', skills: ['./skills/xlsx', './skills/docx'] },
          { name: 'office-tools', source: './', skills: ['./skills/xlsx'] },
        ],
      })
    );

    project = join(base, 'project');
    await mkdir(project, { recursive: true });
    origCwd = process.cwd();
    process.chdir(project);

    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await rm(base, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.mocked(searchMultiselect).mockReset();
  });

  it('shows the skill under every group in the prompt and installs it once', async () => {
    vi.mocked(searchMultiselect).mockImplementation(async ({ items }) => [
      items.find((item) => item.label === 'xlsx')!.value,
    ]);
    const install = vi.spyOn(installer, 'installSkillForAgent');

    await runAdd([fixture], { agent: ['codex'], global: false, mode: 'copy' });

    const { items } = vi.mocked(searchMultiselect).mock.calls[0]![0];
    expect(items.map((item) => [item.group, item.label])).toEqual([
      ['Document Skills', 'docx'],
      ['Document Skills', 'xlsx'],
      ['Office Tools', 'xlsx'],
      ['Other', 'standalone'],
    ]);
    expect(install.mock.calls.map(([skill]) => (skill as Skill).name)).toEqual(['xlsx']);
  });

  it('merges groups when plugins list different directories with the same skill name', async () => {
    await writeSkill(join(fixture, 'plugins/office/skills/xlsx'), 'xlsx');
    await writeFile(
      join(fixture, '.claude-plugin/marketplace.json'),
      JSON.stringify({
        plugins: [
          { name: 'document-skills', source: './', skills: ['./skills/xlsx', './skills/docx'] },
          { name: 'office-tools', source: './plugins/office', skills: ['./skills/xlsx'] },
        ],
      })
    );
    vi.mocked(searchMultiselect).mockImplementation(async ({ items }) => [items[0]!.value]);

    await runAdd([fixture], { agent: ['codex'], global: false, mode: 'copy' });

    const { items } = vi.mocked(searchMultiselect).mock.calls[0]![0];
    expect(items.map((item) => [item.group, item.label])).toEqual([
      ['Document Skills', 'docx'],
      ['Document Skills', 'xlsx'],
      ['Office Tools', 'xlsx'],
      ['Other', 'standalone'],
    ]);
  });

  it('lists the skill under every group with --list', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => output.push(a.join(' ')));

    await expect(runAdd([fixture], { list: true })).rejects.toThrow('process.exit called');
    log.mockRestore();

    // Headers and skill names only: drop blank lines, descriptions and the exit stub's error.
    const lines = output
      .slice(output.indexOf('Available Skills'))
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith(' skill') && !line.startsWith('[clack.error]'));
    expect(lines).toEqual([
      'Available Skills',
      'Document Skills',
      'docx',
      'xlsx',
      'Office Tools',
      'xlsx',
      'General',
      'standalone',
    ]);
  });
});
