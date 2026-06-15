import { describe, it, expect } from 'vitest';
import { mergeFrontmatter } from '../../../src/sync/frontmatter';

const baseObsyncFields = {
  obsync_source: 'test-source',
  obsync_hash: 'abc123def456',
  obsync_synced_at: new Date().toISOString(),
  obsync_git_ref: null,
};

describe('mergeFrontmatter', () => {
  // Test 1: Source with no frontmatter → mergedData contains only obsync_* keys; body is full content
  it('source with no frontmatter yields only obsync_* keys in mergedData and preserves body', () => {
    const rawContent = 'This is a markdown file with no frontmatter.\n\nSome content here.';
    const result = mergeFrontmatter(rawContent, baseObsyncFields);

    expect(result.skipped).toBe(false);
    expect(result.mergedData).toEqual(baseObsyncFields);
    expect(result.body).toBe(rawContent);
  });

  // Test 2: Source with existing YAML frontmatter (title, author) → mergedData has title, author, AND obsync_* fields
  it('source with existing YAML frontmatter preserves source fields and adds obsync_* fields', () => {
    const rawContent = '---\ntitle: My Document\nauthor: Alex\n---\nBody content here.';
    const result = mergeFrontmatter(rawContent, baseObsyncFields);

    expect(result.skipped).toBe(false);
    expect(result.mergedData['title']).toBe('My Document');
    expect(result.mergedData['author']).toBe('Alex');
    expect(result.mergedData['obsync_source']).toBe('test-source');
    expect(result.mergedData['obsync_hash']).toBe('abc123def456');
    expect(result.body.trim()).toBe('Body content here.');
  });

  // Test 3: obsync_* fields overwrite prior obsync_* in source file (D-16 simulation)
  it('obsync_* fields overwrite prior obsync_* fields in source (D-16)', () => {
    const rawContent = [
      '---',
      'title: My Doc',
      'obsync_source: old-source',
      'obsync_hash: oldhash',
      'obsync_synced_at: 2020-01-01T00:00:00.000Z',
      'obsync_git_ref: oldref',
      '---',
      'Body here.',
    ].join('\n');

    const freshFields = {
      obsync_source: 'new-source',
      obsync_hash: 'newhash',
      obsync_synced_at: '2026-06-09T12:00:00.000Z',
      obsync_git_ref: 'abc123',
    };

    const result = mergeFrontmatter(rawContent, freshFields);

    expect(result.skipped).toBe(false);
    expect(result.mergedData['obsync_source']).toBe('new-source');
    expect(result.mergedData['obsync_hash']).toBe('newhash');
    expect(result.mergedData['obsync_synced_at']).toBe('2026-06-09T12:00:00.000Z');
    expect(result.mergedData['obsync_git_ref']).toBe('abc123');
    expect(result.mergedData['title']).toBe('My Doc');
  });

  // Test 4: Source has 'tags: [infra]' → mergedData.tags = ['infra'] (preserved, not modified — D-14)
  it('source tags are preserved exactly as-is (D-14)', () => {
    const rawContent = '---\ntags:\n  - infra\n  - runbook\n---\nContent.';
    const result = mergeFrontmatter(rawContent, baseObsyncFields);

    expect(result.skipped).toBe(false);
    expect(result.mergedData['tags']).toEqual(['infra', 'runbook']);
  });

  // Test 5: TOML frontmatter (starts with '+++') → skipped=true, body=original content, mergedData={}
  it('TOML frontmatter returns skipped=true with original content and empty mergedData', () => {
    const rawContent = '+++ \ntitle = "My Doc"\n+++\nBody here.';
    const result = mergeFrontmatter(rawContent, baseObsyncFields);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('toml');
    expect(result.body).toBe(rawContent);
    expect(result.mergedData).toEqual({});
  });

  // Test 6: JSON frontmatter (starts with '{') → skipped=true, body=original content
  it('JSON frontmatter returns skipped=true with original content and empty mergedData', () => {
    const rawContent = '{"title": "My Doc"}\nBody here.';
    const result = mergeFrontmatter(rawContent, baseObsyncFields);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('json');
    expect(result.body).toBe(rawContent);
    expect(result.mergedData).toEqual({});
  });

  // Test 7: obsync_synced_at is a valid ISO 8601 string
  it('obsync_synced_at in mergedData is a valid ISO 8601 string', () => {
    const synced_at = '2026-06-09T18:30:00.000Z';
    const fields = { ...baseObsyncFields, obsync_synced_at: synced_at };
    const result = mergeFrontmatter('No frontmatter.', fields);

    expect(result.skipped).toBe(false);
    expect(result.mergedData['obsync_synced_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // Test 8: obsync_git_ref: null → serializes as YAML null (not 'null' string)
  it('obsync_git_ref null is preserved as null (not string "null")', () => {
    const fields = { ...baseObsyncFields, obsync_git_ref: null };
    const result = mergeFrontmatter('No frontmatter.', fields);

    expect(result.skipped).toBe(false);
    expect(result.mergedData['obsync_git_ref']).toBeNull();
    expect(result.mergedData['obsync_git_ref']).not.toBe('null');
  });

  // Test 9: obsync_git_ref: '40-char-hex' → preserved as string in mergedData
  it('obsync_git_ref 40-char hex string is preserved as string', () => {
    const gitRef = 'a'.repeat(40);
    const fields = { ...baseObsyncFields, obsync_git_ref: gitRef };
    const result = mergeFrontmatter('No frontmatter.', fields);

    expect(result.skipped).toBe(false);
    expect(result.mergedData['obsync_git_ref']).toBe(gitRef);
    expect(typeof result.mergedData['obsync_git_ref']).toBe('string');
  });

  // Test 10: Source frontmatter with 'aliases: [foo]' → mergedData.aliases = ['foo'] (preserved — D-14)
  it('source aliases are preserved exactly as-is (D-14)', () => {
    const rawContent = '---\naliases:\n  - foo\n  - bar\n---\nContent.';
    const result = mergeFrontmatter(rawContent, baseObsyncFields);

    expect(result.skipped).toBe(false);
    expect(result.mergedData['aliases']).toEqual(['foo', 'bar']);
  });

  // Test 11: Empty source file ('') → mergedData contains only obsync_* keys; body is ''
  it('empty source file yields only obsync_* keys and empty body', () => {
    const result = mergeFrontmatter('', baseObsyncFields);

    expect(result.skipped).toBe(false);
    expect(result.mergedData).toEqual(baseObsyncFields);
    expect(result.body).toBe('');
  });

  // Test 12: Source file with '---' horizontal rule in body (not frontmatter) → body preserved correctly
  it('horizontal rule in body is preserved correctly (gray-matter handles this)', () => {
    const rawContent = [
      '---',
      'title: Doc with HR',
      '---',
      'First section.',
      '',
      '---',
      '',
      'Second section after horizontal rule.',
    ].join('\n');

    const result = mergeFrontmatter(rawContent, baseObsyncFields);

    expect(result.skipped).toBe(false);
    expect(result.mergedData['title']).toBe('Doc with HR');
    expect(result.body).toContain('---');
    expect(result.body).toContain('Second section after horizontal rule.');
  });
});
