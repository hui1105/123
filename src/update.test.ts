import { describe, expect, it } from 'vitest';
import { getGlobalUpdateAgents } from './update.ts';

describe('getGlobalUpdateAgents', () => {
  it('preserves the agents that currently have the global skill installed', () => {
    expect(
      getGlobalUpdateAgents('gh', [
        { name: 'gh', scope: 'global', agents: ['autohand-code', 'universal'] },
      ])
    ).toEqual(['autohand-code', 'universal']);
  });

  it('falls back to the universal skills directory when no global install is found', () => {
    expect(getGlobalUpdateAgents('gh', [])).toEqual(['universal']);
  });

  it('does not use project skill placements for a global update', () => {
    expect(
      getGlobalUpdateAgents('gh', [{ name: 'gh', scope: 'project', agents: ['autohand-code'] }])
    ).toEqual(['universal']);
  });
});
