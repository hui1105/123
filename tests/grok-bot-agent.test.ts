import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findSkillMdPaths, type RepoTree } from '../src/blob.ts';
import { discoverSkills } from '../src/skills.ts';

const temporaryPaths: string[] = [];

function createTemporaryDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'grok-bot-skills-'));
  temporaryPaths.push(path);
  return path;
}

describe('Grok Bot agent support', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const path of temporaryPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('uses distinct Grok Bot and Grok Build target directories', async () => {
    const { agents } = await import('../src/agents.ts');

    expect(agents['grok-bot']).toMatchObject({
      name: 'grok-bot',
      displayName: 'Grok Bot',
      skillsDir: 'agent-data/workflows',
      globalSkillsDir: join(homedir(), 'agent-data/workflows'),
    });
    expect(agents.grok.skillsDir).toBe('.grok/skills');
    expect(agents.grok.displayName).toBe('Grok Build');
  });

  it('detects its own workflows directory, not GROK_HOME', async () => {
    const temporaryHome = createTemporaryDir();
    vi.stubEnv('HOME', temporaryHome);
    vi.stubEnv('GROK_HOME', join(temporaryHome, '.grok'));
    vi.resetModules();
    const { agents } = await import('../src/agents.ts');

    expect(existsSync(join(temporaryHome, 'agent-data/workflows'))).toBe(false);
    await expect(agents['grok-bot'].detectInstalled()).resolves.toBe(false);

    mkdirSync(join(temporaryHome, 'agent-data/workflows'), { recursive: true });
    await expect(agents['grok-bot'].detectInstalled()).resolves.toBe(true);
  });

  it('discovers Skills from local Grok Bot workflows', async () => {
    const project = createTemporaryDir();
    const skillDir = join(project, 'agent-data/workflows/review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: review\ndescription: Reviews code changes.\n---\n\n# Review\n'
    );

    const skills = await discoverSkills(project);
    expect(skills.map((skill) => skill.name)).toContain('review');
  });

  it('discovers Skills from remote Grok Bot workflow paths', () => {
    const tree: RepoTree = {
      sha: 'root-sha',
      branch: 'main',
      tree: [
        {
          path: 'agent-data/workflows/review/SKILL.md',
          type: 'blob',
          sha: 'review-sha',
        },
      ],
    };

    expect(findSkillMdPaths(tree)).toEqual(['agent-data/workflows/review/SKILL.md']);
  });
});
