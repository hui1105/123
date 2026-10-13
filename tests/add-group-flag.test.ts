import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Error and message lines, for asserting on the unknown-group error.
const logged: string[] = [];

vi.mock('@clack/prompts', () => {
  const noop = () => {};
  const record = (...a: unknown[]) => logged.push(a.join(' '));
  return {
    intro: noop,
    outro: record,
    note: noop,
    confirm: vi.fn().mockResolvedValue(true),
    cancel: noop,
    isCancel: () => false,
    log: {
      info: noop,
      message: record,
      warn: noop,
      error: record,
      step: noop,
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

import { runAdd, parseAddOptions } from '../src/add.ts';
import * as installer from '../src/installer.ts';
import { wellKnownProvider, type WellKnownSkill } from '../src/providers/index.ts';
import { searchMultiselect } from '../src/prompts/search-multiselect.ts';
import type { Skill } from '../src/types.ts';

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
}

describe('add --group', () => {
  let base: string;
  let fixture: string;
  let origCwd: string;

  beforeEach(async () => {
    logged.length = 0;
    base = await mkdtemp(join(tmpdir(), 'add-group-'));
    fixture = join(base, 'repo');
    for (const name of ['xlsx', 'docx', 'pdf', 'slides', 'standalone']) {
      await writeSkill(join(fixture, 'skills', name), name);
    }
    await mkdir(join(fixture, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(fixture, '.claude-plugin/marketplace.json'),
      JSON.stringify({
        plugins: [
          { name: 'document-skills', source: './', skills: ['./skills/xlsx', './skills/docx'] },
          { name: 'office-tools', source: './', skills: ['./skills/xlsx', './skills/slides'] },
          { name: 'pdf-tools', source: './', skills: ['./skills/pdf'] },
        ],
      })
    );

    const project = join(base, 'project');
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

  /** Runs `skills add <fixture> ...args` for codex and returns the installed skill names. */
  async function installedWith(args: string[]): Promise<string[]> {
    const { source, options, errors } = parseAddOptions([fixture, ...args]);
    expect(errors).toEqual([]);
    const install = vi.spyOn(installer, 'installSkillForAgent');
    await runAdd(source, { ...options, agent: ['codex'], global: false, copy: true });
    expect(searchMultiselect).not.toHaveBeenCalled();
    return install.mock.calls.map(([skill]) => (skill as Skill).name).sort();
  }

  it('installs every skill in the group without prompting', async () => {
    expect(await installedWith(['--group', 'document-skills'])).toEqual(['docx', 'xlsx']);
  });

  it.each([
    ['comma-separated', ['--group', 'document-skills,pdf-tools']],
    ['repeated', ['--group', 'document-skills', '--group', 'pdf-tools']],
    ['space-separated', ['--group', 'document-skills', 'pdf-tools']],
  ])('accepts several groups %s', async (_form, args) => {
    expect(await installedWith(args)).toEqual(['docx', 'pdf', 'xlsx']);
  });

  it('accepts mixed comma and repeated forms', async () => {
    expect(
      await installedWith(['--group', 'document-skills,pdf-tools', '--group', 'office-tools'])
    ).toEqual(['docx', 'pdf', 'slides', 'xlsx']);
  });

  it('accepts the title-cased name the prompt shows', async () => {
    expect(await installedWith(['--group', 'Office Tools'])).toEqual(['slides', 'xlsx']);
  });

  it('installs a skill in two requested groups once', async () => {
    expect(await installedWith(['--group', 'document-skills,office-tools'])).toEqual([
      'docx',
      'slides',
      'xlsx',
    ]);
  });

  it('installs the union of --group and --skill', async () => {
    expect(await installedWith(['--group', 'pdf-tools', '--skill', 'standalone', 'pdf'])).toEqual([
      'pdf',
      'standalone',
    ]);
  });

  it('fails on an unknown group and lists the valid ones', async () => {
    const install = vi.spyOn(installer, 'installSkillForAgent');
    const { source, options } = parseAddOptions([fixture, '--group', 'pdf-tools,nope']);

    await expect(
      runAdd(source, { ...options, agent: ['codex'], global: false, copy: true })
    ).rejects.toThrow('process.exit called');

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(install).not.toHaveBeenCalled();
    expect(logged).toEqual(
      expect.arrayContaining([
        'Unknown group: nope',
        '  - document-skills',
        '  - office-tools',
        '  - pdf-tools',
      ])
    );
  });

  it('fails on --group for a well-known source, which defines no groups', async () => {
    const skill = {
      name: 'docs',
      description: 'docs skill',
      content: '---\nname: docs\ndescription: docs skill\n---\n',
      installName: 'docs',
      sourceUrl: 'https://example.com/.well-known/agent-skills/docs/SKILL.md',
      files: new Map([['SKILL.md', 'x']]),
      indexEntry: { name: 'docs', description: 'docs skill', files: ['SKILL.md'] },
    } as WellKnownSkill;
    vi.spyOn(wellKnownProvider, 'fetchAllSkills').mockResolvedValue([skill]);
    const install = vi.spyOn(installer, 'installSkillForAgent');
    const { source, options } = parseAddOptions(['https://example.com', '--group', 'a,b']);

    await expect(
      runAdd(source, { ...options, agent: ['codex'], global: false, copy: true })
    ).rejects.toThrow('process.exit called');

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(install).not.toHaveBeenCalled();
    expect(searchMultiselect).not.toHaveBeenCalled();
    expect(logged).toContain('Unknown groups: a, b');
  });

  it('mentions --group in the --list closing hint when the source has groups', async () => {
    await expect(
      runAdd([fixture], { list: true, agent: ['codex'], global: false })
    ).rejects.toThrow('process.exit called');

    expect(process.exit).toHaveBeenCalledWith(0);
    expect(logged).toContain(
      'Use --skill <name> or --group <name> to install specific skills or whole groups'
    );
  });
});
