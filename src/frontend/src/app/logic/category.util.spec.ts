import { describe, expect, it } from 'vitest';
import { categoryName } from './category.util';

const nl = { women: 'Dames', men: 'Heren', pupils: 'Pupillen', juniors: 'Junioren', neoSeniors: 'Neo-senioren', seniors: 'Senioren', masters: 'Masters' };
const en = { women: 'Women', men: 'Men', pupils: 'Pupils', juniors: 'Juniors', neoSeniors: 'Neo-seniors', seniors: 'Seniors', masters: 'Masters' };

describe('categoryName', () => {
  it('puts the gender in front of the category name', () => {
    expect(categoryName('DA1', nl)).toBe('Dames Junioren A1');
    expect(categoryName('HA1', nl)).toBe('Heren Junioren A1');
    expect(categoryName('DPF', nl)).toBe('Dames Pupillen F');
    expect(categoryName('HN3', nl)).toBe('Heren Neo-senioren 3');
    expect(categoryName('DSB', nl)).toBe('Dames Senioren B');
    expect(categoryName('D40', nl)).toBe('Dames Masters A');
    expect(categoryName('H70', nl)).toBe('Heren Masters G');
  });

  it('speaks the language of the labels', () => {
    expect(categoryName('DA1', en)).toBe('Women Juniors A1');
    expect(categoryName('HPC', en)).toBe('Men Pupils C');
    expect(categoryName('HN3', en)).toBe('Men Neo-seniors 3');
  });

  it('returns an unknown code as it is, and nothing for no code', () => {
    expect(categoryName('XYZ', nl)).toBe('XYZ');
    expect(categoryName('SC2', nl)).toBe('SC2');
    expect(categoryName(null, nl)).toBe('');
  });
});
