import { describe, it, expect } from 'vitest';
import { ObsyncConfigSchema, SourceSchema } from '../../../src/config/types';

const validMinimalConfig = {
  vault: { path: '/home/user/vault' },
  sources: [
    {
      name: 'my-project',
      path: '/home/user/project',
      category: 'Projects',
    },
  ],
};

describe('ObsyncConfigSchema', () => {
  it('parses a valid minimal config and returns a typed object', () => {
    const result = ObsyncConfigSchema.safeParse(validMinimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vault.path).toBe('/home/user/vault');
      expect(result.data.sources).toHaveLength(1);
      expect(result.data.sources[0].name).toBe('my-project');
    }
  });

  it('returns error with path [vault,path] and message Required when vault.path is missing', () => {
    const config = {
      vault: {},
      sources: [
        { name: 'src', path: '/home/user/src', category: 'Projects' },
      ],
    };
    const result = ObsyncConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => JSON.stringify(i.path) === JSON.stringify(['vault', 'path'])
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toBe('Required');
    }
  });

  it('defaults source scan to scattered when scan is omitted', () => {
    const result = ObsyncConfigSchema.safeParse(validMinimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sources[0].scan).toBe('scattered');
    }
  });

  it('fails with enum error on sources[0].scan when scan is invalid value', () => {
    const config = {
      ...validMinimalConfig,
      sources: [
        {
          name: 'src',
          path: '/home/user/src',
          category: 'Projects',
          scan: 'full',
        },
      ],
    };
    const result = ObsyncConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => JSON.stringify(i.path) === JSON.stringify(['sources', 0, 'scan'])
      );
      expect(issue).toBeDefined();
    }
  });

  it('defaults source ai_summary to false when omitted', () => {
    const result = ObsyncConfigSchema.safeParse(validMinimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sources[0].ai_summary).toBe(false);
    }
  });

  it('is valid when ai block is absent', () => {
    const config = { ...validMinimalConfig };
    const result = ObsyncConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ai).toBeUndefined();
    }
  });

  it('fails min(1) when sources array is empty', () => {
    const config = {
      vault: { path: '/home/user/vault' },
      sources: [],
    };
    const result = ObsyncConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => JSON.stringify(i.path) === JSON.stringify(['sources'])
      );
      expect(issue).toBeDefined();
    }
  });

  it('defaults global ignore to empty array when omitted', () => {
    const result = ObsyncConfigSchema.safeParse(validMinimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ignore).toEqual([]);
    }
  });

  it('defaults source labels to empty array when omitted', () => {
    const result = ObsyncConfigSchema.safeParse(validMinimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sources[0].labels).toEqual([]);
    }
  });

  it('parses successfully when audit_log is set to a path string', () => {
    const config = {
      ...validMinimalConfig,
      audit_log: '/home/user/.obsync/audit.log',
    };
    const result = ObsyncConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.audit_log).toBe('/home/user/.obsync/audit.log');
    }
  });

  it('parses successfully when audit_log field is absent', () => {
    const result = ObsyncConfigSchema.safeParse(validMinimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.audit_log).toBeUndefined();
    }
  });
});
