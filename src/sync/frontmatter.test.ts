import { describe, it, expect } from 'vitest';
import { mergeFrontmatter } from './frontmatter';

const baseObsyncFields = {
  obsync_source: 'test-source',
  obsync_hash: 'abc123',
  obsync_synced_at: '2026-06-10T12:00:00.000Z',
  obsync_git_ref: null,
};

const contentNoFrontmatter = '# Hello\n\nBody text here.';
const contentWithYamlTags = '---\ntitle: My Doc\ntags:\n  - infra\n---\n# Hello\n\nBody text here.';
const contentWithStringTag = '---\ntitle: My Doc\ntags: infra\n---\n# Hello\n\nBody text here.';
const contentWithNoTags = '---\ntitle: My Doc\n---\n# Hello\n\nBody text here.';
const contentToml = '+++\ntitle = "My Doc"\n+++\n# Hello';
const contentJson = '{ "title": "My Doc" }\n# Hello';

// Existing tests (must still pass after Phase 2 extension)

describe('mergeFrontmatter — existing behavior (backward compat)', () => {
  it('returns mergedData with obsync_* fields and source fields merged', () => {
    const result = mergeFrontmatter(contentWithNoTags, baseObsyncFields);

    expect(result.skipped).toBe(false);
    expect(result.mergedData.obsync_source).toBe('test-source');
    expect(result.mergedData.obsync_hash).toBe('abc123');
    expect(result.mergedData.title).toBe('My Doc');
  });

  it('TOML frontmatter returns skipped=true with skipReason toml', () => {
    const result = mergeFrontmatter(contentToml, baseObsyncFields);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('toml');
  });

  it('JSON frontmatter returns skipped=true with skipReason json', () => {
    const result = mergeFrontmatter(contentJson, baseObsyncFields);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('json');
  });

  it('obsync_* fields always overwrite source fields with same name', () => {
    const contentWithObsyncField = '---\nobsync_source: old-source\nobsync_hash: oldhash\n---\n# Hello';
    const result = mergeFrontmatter(contentWithObsyncField, baseObsyncFields);

    expect(result.mergedData.obsync_source).toBe('test-source');
    expect(result.mergedData.obsync_hash).toBe('abc123');
  });

  it('body content is returned correctly after frontmatter parse', () => {
    const result = mergeFrontmatter(contentWithNoTags, baseObsyncFields);

    expect(result.body.trim()).toBe('# Hello\n\nBody text here.');
  });
});

// Phase 2 label injection tests (CAT-02)

describe('mergeFrontmatter — label injection (CAT-02)', () => {
  it('called with no third argument returns mergedData with no tags field (backward compat)', () => {
    const result = mergeFrontmatter(contentNoFrontmatter, baseObsyncFields);

    expect(result.skipped).toBe(false);
    expect('tags' in result.mergedData).toBe(false);
  });

  it('called with empty labels array returns same as no-argument call (empty labels = no-op)', () => {
    const resultNoLabels = mergeFrontmatter(contentNoFrontmatter, baseObsyncFields);
    const resultEmptyLabels = mergeFrontmatter(contentNoFrontmatter, baseObsyncFields, []);

    expect(resultEmptyLabels.mergedData).toEqual(resultNoLabels.mergedData);
    expect('tags' in resultEmptyLabels.mergedData).toBe(false);
  });

  it('injects tags: [runbook] when source has no existing tags and labels has one entry', () => {
    const result = mergeFrontmatter(contentNoFrontmatter, baseObsyncFields, ['runbook']);

    expect(result.skipped).toBe(false);
    expect(result.mergedData.tags).toEqual(['runbook']);
  });

  it('merges labels with existing array tags without duplicates', () => {
    // File has tags: [infra], labels include [infra, runbook] — infra must not be duplicated
    const result = mergeFrontmatter(contentWithYamlTags, baseObsyncFields, ['infra', 'runbook']);

    expect(result.mergedData.tags).toEqual(['infra', 'runbook']);
    // infra appears only once
    const tags = result.mergedData.tags as string[];
    expect(tags.filter((t) => t === 'infra').length).toBe(1);
  });

  it('normalizes string tags field to array and merges without duplicate', () => {
    // File has tags: infra (string, not array), labels include [infra] — should normalize to [infra] not [infra, infra]
    const result = mergeFrontmatter(contentWithStringTag, baseObsyncFields, ['infra']);

    expect(result.mergedData.tags).toEqual(['infra']);
    const tags = result.mergedData.tags as string[];
    expect(tags.filter((t) => t === 'infra').length).toBe(1);
  });

  it('obsync_* fields always overwrite source fields even after tags merge (spread order guarantee)', () => {
    const contentWithObsyncAndTags =
      '---\nobsync_source: old-source\ntags:\n  - infra\n---\n# Hello';
    const result = mergeFrontmatter(contentWithObsyncAndTags, baseObsyncFields, ['runbook']);

    // obsync_* wins over source value
    expect(result.mergedData.obsync_source).toBe('test-source');
    // tags are merged (source tags + labels)
    expect(result.mergedData.tags).toEqual(['infra', 'runbook']);
  });

  it('TOML frontmatter still returns skipped=true even when labels are passed', () => {
    const result = mergeFrontmatter(contentToml, baseObsyncFields, ['infra', 'runbook']);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('toml');
  });

  it('JSON frontmatter still returns skipped=true even when labels are passed', () => {
    const result = mergeFrontmatter(contentJson, baseObsyncFields, ['infra', 'runbook']);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('json');
  });
});
