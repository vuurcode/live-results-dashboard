/** The age categories of the skating union by code (without its leading D or H): the group and the suffix of its name. */
const CATEGORIES: Record<string, [group: CategoryGroup, suffix: string]> = {
  PF: ['pupils', 'F'], PE: ['pupils', 'E'], PD: ['pupils', 'D'], PC: ['pupils', 'C'], PB: ['pupils', 'B'], PA: ['pupils', 'A'],
  C1: ['juniors', 'C1'], C2: ['juniors', 'C2'], B1: ['juniors', 'B1'], B2: ['juniors', 'B2'], A1: ['juniors', 'A1'], A2: ['juniors', 'A2'],
  N1: ['neoSeniors', '1'], N2: ['neoSeniors', '2'], N3: ['neoSeniors', '3'], N4: ['neoSeniors', '4'],
  SA: ['seniors', 'A'], SB: ['seniors', 'B'],
  '40': ['masters', 'A'], '45': ['masters', 'B'], '50': ['masters', 'C'], '55': ['masters', 'D'], '60': ['masters', 'E'], '65': ['masters', 'F'], '70': ['masters', 'G'],
};

type CategoryGroup = 'pupils' | 'juniors' | 'neoSeniors' | 'seniors' | 'masters';

/** The words in the viewer's language: the gender letters D (dames) and H (heren), and the category groups. */
export interface CategoryLabels extends Record<CategoryGroup, string> {
  women: string;
  men: string;
}

/** The name of a category code such as "DA1" or "HPF", with the gender in front ("Women Juniors A1"); a code that is not in the table is returned as it is. */
export function categoryName(code: string | null | undefined, labels: CategoryLabels): string {
  if (!code) return '';
  const trimmed = code.trim();
  const letter = trimmed.charAt(0).toUpperCase();
  const gender = letter === 'D' ? labels.women : letter === 'H' ? labels.men : undefined;
  const category = CATEGORIES[trimmed.slice(1).toUpperCase()];
  return gender && category ? `${gender} ${labels[category[0]]} ${category[1]}` : trimmed;
}
