import { describe, it, expect } from 'vitest';

import { generateSlug } from './provisioner.js';

describe('generateSlug', () => {
  it('converts to lowercase with underscores', () => {
    expect(generateSlug('Acme Plumbing')).toBe('acme_plumbing');
  });

  it('strips special characters', () => {
    expect(generateSlug("Joe's Auto & Body")).toBe('joes_auto_body');
  });

  it('handles multiple spaces', () => {
    expect(generateSlug('My   Cool   Business')).toBe('my_cool_business');
  });

  it('truncates to 64 characters', () => {
    const long = 'A'.repeat(100);
    expect(generateSlug(long).length).toBe(64);
  });

  it('handles simple names', () => {
    expect(generateSlug('WeightLossNow')).toBe('weightlossnow');
  });

  it('strips leading/trailing underscores', () => {
    expect(generateSlug(' Test Business ')).toBe('test_business');
  });
});
