/**
 * arXiv silently returns zero results for a category that does not exist, so a typo in Settings would
 * produce an empty domain with no error. We therefore validate categories against this list, and the
 * query expander may only choose from it.
 */
const CS = ["AI","AR","CC","CE","CG","CL","CR","CV","CY","DB","DC","DL","DM","DS","ET","FL","GL","GR","GT","HC","IR","IT","LG","LO","MA","MM","MS","NA","NE","NI","OH","OS","PF","PL","RO","SC","SD","SE","SI","SY"];

export const ARXIV_CATEGORIES: readonly string[] = [
  ...CS.map((c) => `cs.${c}`),
  "stat.ML", "stat.ME", "stat.AP", "stat.TH", "stat.CO",
  "eess.IV", "eess.AS", "eess.SP", "eess.SY",
  "math.OC", "math.ST", "math.NA",
  "q-bio.NC", "q-bio.QM", "q-bio.GN",
  "physics.med-ph", "physics.comp-ph", "physics.data-an",
  "econ.GN", "econ.EM",
];

const SET = new Set(ARXIV_CATEGORIES);
export const isKnownCategory = (c: string) => SET.has(c);
