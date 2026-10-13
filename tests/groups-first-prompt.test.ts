import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@clack/prompts', () => {
  const noop = () => {};
  return {
    intro: noop,
    outro: noop,
    note: noop,
    confirm: vi.fn().mockResolvedValue(true),
    cancel: noop,
    isCancel: (v: unknown) => typeof v === 'symbol',
    log: { info: noop, message: noop, warn: noop, error: noop, step: noop, success: noop },
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
import { detectAgent } from '../src/detect-agent.ts';
import { searchMultiselect, cancelSymbol } from '../src/prompts/search-multiselect.ts';
import type { Skill } from '../src/types.ts';

const GROUPS_MESSAGE = 'Which groups?';

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
}

/**
 * Fixture repo: plugin "alpha" lists a01..aNN plus "shared", plugin "beta"
 * lists b01..bNN plus "shared", and "loose" belongs to no plugin.
 */
async function writeFixture(repo: string, perPlugin: number): Promise<void> {
  const names = (prefix: string) =>
    Array.from({ length: perPlugin }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);
  const alpha = names('a');
  const beta = names('b');
  for (const name of [...alpha, ...beta, 'shared', 'loose']) {
    await writeSkill(join(repo, 'skills', name), name);
  }
  await mkdir(join(repo, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(repo, '.claude-plugin/marketplace.json'),
    JSON.stringify({
      plugins: [
        { name: 'alpha', source: './', skills: [...alpha, 'shared'].map((n) => `./skills/${n}`) },
        { name: 'beta', source: './', skills: [...beta, 'shared'].map((n) => `./skills/${n}`) },
      ],
    })
  );
}

/** Fixture repo from plugin name to skill names, plus skills in no plugin. */
async function writeRepo(
  repo: string,
  plugins: Record<string, string[]>,
  loose: string[] = []
): Promise<void> {
  const all = new Set([...Object.values(plugins).flat(), ...loose]);
  for (const name of all) await writeSkill(join(repo, 'skills', name), name);
  await mkdir(join(repo, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(repo, '.claude-plugin/marketplace.json'),
    JSON.stringify({
      plugins: Object.entries(plugins).map(([name, skills]) => ({
        name,
        source: './',
        skills: skills.map((n) => `./skills/${n}`),
      })),
    })
  );
}

const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);

type PromptArgs = Parameters<typeof searchMultiselect>[0];
const promptCalls = () =>
  vi.mocked(searchMultiselect).mock.calls.map(([args]) => args as PromptArgs);
const groupPrompt = () => promptCalls().find((args) => args.message === GROUPS_MESSAGE);
const skillPrompt = () =>
  promptCalls().find((args) => String(args.message).startsWith('Select skills'));
const installedNames = (install: { mock: { calls: unknown[][] } }) =>
  install.mock.calls.map(([skill]) => (skill as Skill).name).sort();

/** Answer the groups step with `groups` (labels) and accept the skill step as preselected. */
function answer(groups: string[]): void {
  vi.mocked(searchMultiselect).mockImplementation(async (args: PromptArgs) => {
    if (args.message === GROUPS_MESSAGE) {
      return args.items.filter((item) => groups.includes(item.label)).map((item) => item.value);
    }
    return (args.initialSelected ?? []) as unknown[];
  });
}

describe('groups-first skill prompt', () => {
  let base: string;
  let fixture: string;
  let origCwd: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'groups-first-'));
    fixture = join(base, 'repo');
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

  const run = (options: Record<string, unknown> = {}) =>
    runAdd([fixture], { agent: ['codex'], global: false, mode: 'copy', ...options } as never);

  it('asks for groups first when the skill list does not fit, with nothing preselected', async () => {
    await writeFixture(fixture, 10);
    answer(['Alpha']);

    await run();

    const step1 = groupPrompt();
    expect(promptCalls()[0]).toBe(step1);
    expect(step1!.items.map((item) => item.label)).toEqual(['Alpha', 'Beta', 'Other']);
    expect(step1!.initialSelected ?? []).toEqual([]);
    expect(step1!.required).toBe(true);
  });

  it('limits the skill step to the picked groups, all preselected', async () => {
    await writeFixture(fixture, 10);
    answer(['Beta']);
    const install = vi.spyOn(installer, 'installSkillForAgent');

    await run();

    const step2 = skillPrompt()!;
    expect(step2.items.map((item) => [item.group, item.label])).toEqual([
      ...Array.from({ length: 10 }, (_, i) => ['Beta', `b${String(i + 1).padStart(2, '0')}`]),
      ['Beta', 'shared'],
    ]);
    expect(step2.initialSelected).toEqual(step2.items.map((item) => item.value));
    expect(installedNames(install)).toHaveLength(11);
    expect(installedNames(install)).not.toContain('loose');
  });

  it('shows a skill under each picked group and installs it once', async () => {
    await writeFixture(fixture, 10);
    answer(['Alpha', 'Beta']);
    const install = vi.spyOn(installer, 'installSkillForAgent');

    await run();

    const step2 = skillPrompt()!;
    expect(step2.items.filter((item) => item.label === 'shared').map((i) => i.group)).toEqual([
      'Alpha',
      'Beta',
    ]);
    expect(step2.items.some((item) => item.group === 'Other')).toBe(false);
    expect(new Set(step2.initialSelected).size).toBe(step2.initialSelected!.length);
    const names = installedNames(install);
    expect(names.filter((n) => n === 'shared')).toHaveLength(1);
    expect(names).toHaveLength(21);
  });

  it('includes ungrouped skills only when "Other" is picked', async () => {
    await writeFixture(fixture, 10);
    answer(['Other']);
    const install = vi.spyOn(installer, 'installSkillForAgent');

    await run();

    expect(skillPrompt()!.items.map((item) => [item.group, item.label])).toEqual([
      ['Other', 'loose'],
    ]);
    expect(installedNames(install)).toEqual(['loose']);
  });

  it('keeps the single skill prompt when the list fits', async () => {
    await writeFixture(fixture, 8); // 9 + 9 + 1 = 19 rows
    answer([]);

    await run();

    expect(groupPrompt()).toBeUndefined();
    const step = skillPrompt()!;
    expect(step.items).toHaveLength(19);
    expect(step.initialSelected).toBeUndefined();
  });

  it('keeps the single skill prompt at exactly 20 rows', async () => {
    await writeRepo(fixture, { alpha: numbered('a', 10), beta: numbered('b', 10) });
    answer([]);

    await run();

    expect(groupPrompt()).toBeUndefined();
    expect(skillPrompt()!.items).toHaveLength(20);
  });

  it('asks for groups at 21 rows', async () => {
    await writeRepo(fixture, { alpha: numbered('a', 10), beta: numbered('b', 10) }, ['loose']);
    answer(['Alpha']);

    await run();

    expect(groupPrompt()).toBeDefined();
  });

  it('counts a skill once per group it shows under', async () => {
    // 19 distinct skills, but s1 and s2 show under both groups: 21 rows
    await writeRepo(fixture, {
      alpha: [...numbered('a', 9), 's1', 's2'],
      beta: [...numbered('b', 8), 's1', 's2'],
    });
    answer(['Alpha']);

    await run();

    expect(groupPrompt()).toBeDefined();
  });

  it('keeps the single skill prompt when there is only one group', async () => {
    for (let i = 1; i <= 25; i++) await writeSkill(join(fixture, 'skills', `s${i}`), `s${i}`);
    vi.mocked(searchMultiselect).mockImplementation(async (args: PromptArgs) => [
      args.items[0]!.value,
    ]);

    await run();

    expect(groupPrompt()).toBeUndefined();
    expect(skillPrompt()!.items).toHaveLength(25);
  });

  it.each([
    ['groups', GROUPS_MESSAGE],
    ['skills', 'Select skills'],
  ])('cancels the install when the %s step is cancelled', async (_step, message) => {
    await writeFixture(fixture, 10);
    vi.mocked(searchMultiselect).mockImplementation(async (args: PromptArgs) => {
      if (String(args.message).startsWith(message)) return cancelSymbol;
      return args.items.map((item) => item.value);
    });
    const install = vi.spyOn(installer, 'installSkillForAgent');

    await expect(run()).rejects.toThrow('process.exit called');

    expect(process.exit).toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it.each([
    ['-y', { yes: true }],
    ['--skill', { skill: ['a01'] }],
    ['--group', { group: ['alpha'] }],
    ['--all', { all: true }],
  ])('does not ask for groups with %s', async (_flag, options) => {
    await writeFixture(fixture, 10);
    answer(['Alpha']);

    await run(options);

    expect(groupPrompt()).toBeUndefined();
  });

  it('does not ask for groups in agent mode', async () => {
    await writeFixture(fixture, 10);
    vi.mocked(detectAgent).mockResolvedValueOnce({
      isAgent: true,
      agent: { name: 'claude-code' },
    } as never);
    answer(['Alpha']);

    await run();

    expect(groupPrompt()).toBeUndefined();
  });
});
